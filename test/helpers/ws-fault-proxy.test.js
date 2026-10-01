import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { startFaultProxy } from "./ws-fault-proxy.mjs";

// #1620: a rapid-mode proxy armed a 50 s storm-deadline timer that close() never
// cleared, so the E2E harness-leak guard reported the process still alive.
const count = (kind) => process.getActiveResourcesInfo().filter((r) => r === kind).length;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("ws-fault-proxy resource hygiene", () => {
  test("a closed rapid-mode proxy leaves no Timeout or socket handle behind", async () => {
    const before = { timeout: count("Timeout"), tcp: count("TCPSocketWrap") + count("TCPServerWrap") };
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(upstream, "listening");

    const proxy = await startFaultProxy({
      mode: "rapid",
      initialDelayMs: 10_000,
      dropEveryMs: 2_000,
      dropDurationMs: 40_000,
      upstream: `ws://127.0.0.1:${upstream.address().port}`,
    });
    const client = new WebSocket(proxy.url);
    await once(client, "open");
    await sleep(50); // let the proxy dial its upstream leg

    client.close();
    await proxy.close();
    await new Promise((r) => upstream.close(r));
    await sleep(100); // sockets finish closing on the next ticks

    const after = { timeout: count("Timeout"), tcp: count("TCPSocketWrap") + count("TCPServerWrap") };
    assert.deepEqual(after, before,
      `>> FAIL: ws-fault-proxy: close() left handles open (before ${JSON.stringify(before)}, after ${JSON.stringify(after)}); the storm-deadline timer must be cleared`);
  });
});
