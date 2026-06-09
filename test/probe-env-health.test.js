import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Helper: run the probe with the WebSocket constructor mocked via a stub
// preload file. We can't trivially inject mocks into an ESM script invoked
// as a child process, so we drive the probe through a Node --import preload
// that replaces globalThis.WebSocket before the probe runs.
function runProbe({ env, scenario, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const preload = path.join(os.tmpdir(), `ws-mock-${scenario}-${Date.now()}.mjs`);
    fs.writeFileSync(preload, MOCKS[scenario]);
    const child = spawn(
      process.execPath,
      ["--import", preload, "tools/probe-env-health.mjs", "--env", env, "--timeout-ms", String(timeoutMs)],
      { env: { ...process.env, GITHUB_OUTPUT: "" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("close", (code) => {
      fs.rmSync(preload, { force: true });
      resolve({ code, stdout, stderr });
    });
  });
}

// Every mock stubs BOTH globalThis.WebSocket (for the chain probes) AND
// globalThis.fetch (for the gateway HTTP probe). The default fetch stub
// returns 200; the gateway_error scenario throws on fetch.
const FETCH_OK = `
  globalThis.fetch = async () => ({ status: 200 });
`;
const FETCH_THROWS = `
  globalThis.fetch = async () => { throw new Error("ENOTFOUND gateway.example"); };
`;
const WS_HEALTHY = `
  globalThis.WebSocket = class {
    constructor(url) { setTimeout(() => this.onopen?.(), 0); }
    send(msg) {
      const { id, method } = JSON.parse(msg);
      const result = method === "system_chain" ? "Mock Chain"
                   : method === "state_call"   ? "0x" + "ab".repeat(20)
                   : null;
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) }), 0);
    }
    close() { this.onclose?.(); }
  };
`;

const MOCKS = {
  healthy: WS_HEALTHY + FETCH_OK,
  ws_connect_error: `
    globalThis.WebSocket = class {
      constructor(url) { setTimeout(() => this.onerror?.({ message: "ECONNREFUSED" }), 0); }
      send() {}
      close() {}
    };
  ` + FETCH_OK,
  rpc_error: `
    globalThis.WebSocket = class {
      constructor(url) { setTimeout(() => this.onopen?.(), 0); }
      send(msg) {
        const { id } = JSON.parse(msg);
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "RPC bork" } }) }), 0);
      }
      close() {}
    };
  ` + FETCH_OK,
  runtime_call_error: `
    globalThis.WebSocket = class {
      constructor(url) { setTimeout(() => this.onopen?.(), 0); }
      send(msg) {
        const { id, method } = JSON.parse(msg);
        if (method === "system_chain") {
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result: "Mock Chain" }) }), 0);
        } else {
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "ReviveApi missing" } }) }), 0);
        }
      }
      close() {}
    };
  ` + FETCH_OK,
  timeout: `
    globalThis.WebSocket = class {
      constructor(url) { /* never opens */ }
      send() {}
      close() {}
    };
  ` + FETCH_OK,
  // Chain probes succeed, but the gateway HTTP fetch throws (DNS/refused/timeout).
  gateway_error: WS_HEALTHY + FETCH_THROWS,
};

describe("probe-env-health", () => {
  test("exits 0 on healthy chain", async () => {
    const { code, stdout } = await runProbe({ env: "preview", scenario: "healthy" });
    assert.strictEqual(code, 0, `expected exit 0, got ${code}; stdout: ${stdout}`);
    assert.match(stdout, /healthy/i);
  });

  test("exits non-zero on WS connect error", async () => {
    const { code, stderr } = await runProbe({ env: "preview", scenario: "ws_connect_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /ws_connect_error/);
  });

  test("exits non-zero on rpc error", async () => {
    const { code, stderr } = await runProbe({ env: "preview", scenario: "rpc_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /rpc_error/);
  });

  test("exits non-zero on runtime_call_error", async () => {
    const { code, stderr } = await runProbe({ env: "preview", scenario: "runtime_call_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /runtime_call_error/);
  });

  test("exits non-zero on timeout", async () => {
    const { code, stderr } = await runProbe({ env: "preview", scenario: "timeout", timeoutMs: 500 });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /timeout/);
  });

  test("unknown env id fails with available-envs hint", async () => {
    const { code, stderr } = await runProbe({ env: "does-not-exist", scenario: "healthy" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /unknown_env/);
    assert.match(stderr, /Available envs:/i);
  });

  test("exits non-zero on gateway_error (chains up, gateway HTTP throws)", async () => {
    const { code, stderr } = await runProbe({ env: "preview", scenario: "gateway_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /gateway_error/);
    assert.match(stderr, /gateway /);
  });
});
