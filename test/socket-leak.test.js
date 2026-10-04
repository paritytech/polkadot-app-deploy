// #1675: after deploy()/DotNS work returns in-process, no socket bulletin-deploy
// opened may keep the event loop alive. Each case runs in a child process
// (test/fixtures/socket-leak-child.mjs) against local servers; the child must
// exit by itself and report no TCP/TLS socket handles.
//
// Root causes pinned here:
//   - papi's ws-provider drops its socket WITHOUT closing it on the connect
//     TIMEOUT and on the STALE heartbeat; the orphan finishes its handshake and
//     nothing can close it (connect-timeout / stale-heartbeat / dotns cases).
//   - a gateway response returned early on 404/5xx keeps its socket checked out
//     until its body is read or cancelled (manifest-fetch / roundtrip cases).
// The remaining cases are guards for paths that already exit cleanly.
import { describe, it, test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const CHILD = fileURLToPath(new URL("./fixtures/socket-leak-child.mjs", import.meta.url));
const SOCKET_RESOURCE = /^(TCPSocketWrap|TLSWrap|TLSSocket)$/;

let server;
let wsBase;

// Server behaviour is chosen by the path the child connects to, so cases can run concurrently:
//   /ok           accept at once
//   /hold/<ms>    hold the handshake <ms>, then accept
//   /drop/<key>   accept, terminate after 200 ms; later connects for <key> are held 1.5 s
// Server sockets stay open, as a real RPC node's would: nothing on the server side ever helps the child's
// event loop drain.
before(async () => {
  const wss = new WebSocketServer({ noServer: true });
  const droppedKeys = new Set();
  const accept = (req, sock, head, onConn = () => {}) =>
    wss.handleUpgrade(req, sock, head, (ws) => { ws.on("message", () => {}); onConn(ws); });
  server = http.createServer((req, res) => {
    if (req.url === "/head") { res.writeHead(200, { "content-length": "10" }); res.end(); return; }
    // Gateway miss with a body large enough that undici can't finish it eagerly.
    res.writeHead(504, { "content-type": "text/html" });
    res.end("x".repeat(256 * 1024));
  });
  server.keepAliveTimeout = 60_000;
  server.on("upgrade", (req, sock, head) => {
    const [, route, arg] = req.url.split("/");
    if (route === "hold") setTimeout(() => accept(req, sock, head), Number(arg));
    else if (route === "drop" && !droppedKeys.has(arg)) { droppedKeys.add(arg); accept(req, sock, head, (ws) => setTimeout(() => ws.terminate(), 200)); }
    else if (route === "drop") setTimeout(() => accept(req, sock, head), 1500);
    else accept(req, sock, head);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  wsBase = `ws://127.0.0.1:${server.address().port}`;
});

after(() => { server.closeAllConnections(); server.close(); });

async function runChild(kind, deadlineMs) {
  const child = spawn(process.execPath, [CHILD, kind, wsBase], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, deadlineMs);
    child.on("exit", () => { clearTimeout(timer); resolve(true); });
  });
  const line = out.split("\n").find((l) => l.startsWith("RESOURCES "));
  const resources = line ? JSON.parse(line.slice("RESOURCES ".length)) : null;
  return { exited, resources, out };
}

function assertExitsClean(kind, { exited, resources, out }) {
  assert.ok(resources, `child output had no RESOURCES line:\n${out.slice(-800)}\n>> FAIL: ${kind}: child crashed before finishing the scenario`);
  const sockets = resources.filter((r) => SOCKET_RESOURCE.test(r));
  assert.deepEqual(sockets, [], `>> FAIL: ${kind}: ${sockets.length} socket handle(s) still open after teardown: ${sockets.join(", ")}`);
  assert.ok(exited, `>> FAIL: ${kind}: child still alive after teardown; something holds the event loop open (active: ${resources.join(", ")})`);
}

// [case, deadline ms]. Generous on purpose: a passing child exits as soon as its scenario ends, so the
// deadline only bounds the failing path, and a slow CI runner must not turn it into a flake.
const CASES = [
  ["connect-then-destroy", 15_000],
  ["destroy-during-connect", 15_000],
  ["destroy-during-reconnect", 15_000],
  ["connect-timeout-then-destroy", 15_000],
  ["stale-heartbeat-then-destroy", 15_000],
  ["raw-ws-close-during-connect", 15_000],
  ["gateway-head-keepalive", 15_000],
  ["manifest-fetch-gateway-504", 15_000],
  ["manifest-roundtrip-gateway-504", 15_000],
  // Child-process level: the real DotNS Asset Hub client with papi's default 5 s connect timeout.
  ["dotns-client-default-timeout", 25_000],
];

describe("#1675 socket leak: teardown leaves no socket and the process exits by itself", { concurrency: true }, () => {
  for (const [kind, deadlineMs] of CASES) {
    it(kind, async () => assertExitsClean(kind, await runChild(kind, deadlineMs)));
  }
});

test("#1675 getWsProvider keeps papi's switch() and getStatus() on the provider it wraps", async () => {
  const { getWsProvider } = await import("../dist/ws.js");
  const provider = getWsProvider(["ws://127.0.0.1:1", "ws://127.0.0.1:2"]);
  assert.equal(typeof provider, "function", ">> FAIL: getWsProvider: the wrapped provider is no longer a papi JsonRpcProvider function");
  assert.equal(typeof provider.switch, "function", ">> FAIL: getWsProvider: switch() was dropped, so multi-endpoint failover can't be driven");
  assert.equal(provider.getStatus().type, (await import("polkadot-api/ws")).WsEvent.CLOSE, ">> FAIL: getWsProvider: getStatus() no longer reports papi's status");
});
