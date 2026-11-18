import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readShippedDescriptor } from "../tools/lib/stack-copies.mjs";

const PROBE_SCRIPT = path.resolve("tools/probe-env-health.mjs");

// Helper: run the probe with the WebSocket constructor mocked via a stub
// preload file. We can't trivially inject mocks into an ESM script invoked
// as a child process, so we drive the probe through a Node --import preload
// that replaces globalThis.WebSocket before the probe runs.
function runProbe({ env, scenario, timeoutMs = 5000, cwd = process.cwd() }) {
  return new Promise((resolve) => {
    const preload = path.join(os.tmpdir(), `ws-mock-${scenario}-${Date.now()}.mjs`);
    fs.writeFileSync(preload, MOCKS[scenario]);
    const child = spawn(
      process.execPath,
      ["--import", preload, "tools/probe-env-health.mjs", "--env", env, "--timeout-ms", String(timeoutMs)],
      { cwd, env: { ...process.env, GITHUB_OUTPUT: "" }, stdio: ["ignore", "pipe", "pipe"] },
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

// A copy of the probe beside a .trinity/ whose preview descriptor lacks `dropKeys` from its
// `dotns` map. Every real built-in stack carries the checked contracts, so this is the only way
// to get to the probe's not-configured branch.
function probeCopyWithout(dropKeys) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "probe-env-"));
  fs.mkdirSync(path.join(root, "tools/lib"), { recursive: true });
  fs.mkdirSync(path.join(root, "assets"));
  fs.mkdirSync(path.join(root, ".trinity"));
  fs.copyFileSync("tools/probe-env-health.mjs", path.join(root, "tools/probe-env-health.mjs"));
  fs.copyFileSync("tools/lib/stack-copies.mjs", path.join(root, "tools/lib/stack-copies.mjs"));
  fs.copyFileSync("assets/stack-policy.json", path.join(root, "assets/stack-policy.json"));
  const descriptor = readShippedDescriptor("preview");
  for (const key of dropKeys) delete descriptor.dotns[key];
  fs.writeFileSync(path.join(root, ".trinity/preview.json"), JSON.stringify(descriptor));
  return root;
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
      const result = method === "system_chain"    ? "Mock Chain"
                   : method === "state_call"       ? "0x" + "ab".repeat(20)
                   // Non-null == contract code present at that address.
                   : method === "state_getStorage" ? "0x00806e6f6465"
                   : null;
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) }), 0);
    }
    close() { this.onclose?.(); }
  };
`;

// The DotNS contract-presence check is a plain `state_getStorage` on
// pallet-revive's AccountInfoOf map, issued on the SAME Asset Hub probe as
// system_chain/state_call — no papi, no extra dependency (the probe must
// stay dependency-free). So these mocks vary what state_getStorage returns:
// null == no code.
function wsWithStorage(storageBody) {
  return `
  globalThis.WebSocket = class {
    constructor(url) { setTimeout(() => this.onopen?.(), 0); }
    send(msg) {
      const { id, method, params } = JSON.parse(msg);
      let result = null;
      if (method === "system_chain") result = "Mock Chain";
      else if (method === "state_call") result = "0x" + "ab".repeat(20);
      else if (method === "state_getStorage") { ${storageBody} }
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) }), 0);
    }
    close() { this.onclose?.(); }
  };
`;
}

// No code at the address — the reset-chain case bulletin-deploy issue #1329 describes.
const DOTNS_MISSING_CODE = wsWithStorage(`result = null;`);
// The storage read never answers: must hit the probe timeout, not hang.
const DOTNS_HANGS = `
  globalThis.WebSocket = class {
    constructor(url) { setTimeout(() => this.onopen?.(), 0); }
    send(msg) {
      const { id, method } = JSON.parse(msg);
      if (method === "state_getStorage") return; // never responds
      const result = method === "system_chain" ? "Mock Chain" : "0x" + "ab".repeat(20);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) }), 0);
    }
    close() { this.onclose?.(); }
  };
`;

// since a stack's asset-hub/bulletin/people endpoints differ (see
// the preview descriptor, e.g. ".../asset-hub" vs
// ".../people"). Asset Hub + Bulletin stay healthy; only the People
// connection errors or hangs, proving the probe attributes the failure to
// the right chain rather than needing all three down to notice. One factory
// (same pattern as wsWithStorage() above) instead of two hand-copied mock
// classes that would otherwise repeat the system_chain/state_call/
// state_getStorage response ternary a second and third time.
function wsPeopleFails(mode) {
  // NOTE: no trailing "//" comment on these single-line guards — the
  // generated code is a single template line, and a line comment there would
  // silently swallow the constructor's closing brace, breaking the class in
  // a way that crashes the probe process (a false-positive "non-zero exit"
  // that looks like the intended failure but isn't).
  const openGuard =
    mode === "timeout"
      ? `if (!this.url.includes("people")) setTimeout(() => this.onopen?.(), 0);` // People never opens — must hit the probe timeout, not hang.
      : `setTimeout(() => this.onopen?.(), 0);`;
  const errorBranch =
    mode === "rpc_error"
      ? `
      if (this.url.includes("people")) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "People RPC bork" } }) }), 0);
        return;
      }`
      : "";
  return (
    `
  globalThis.WebSocket = class {
    constructor(url) { this.url = url; ${openGuard} }
    send(msg) {
      const { id, method } = JSON.parse(msg);${errorBranch}
      const result = method === "system_chain"    ? "Mock Chain"
                   : method === "state_call"       ? "0x" + "ab".repeat(20)
                   : method === "state_getStorage" ? "0x00806e6f6465"
                   : null;
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ jsonrpc: "2.0", id, result }) }), 0);
    }
    close() { this.onclose?.(); }
  };
` + FETCH_OK
  );
}
const PEOPLE_RPC_ERROR = wsPeopleFails("rpc_error");
const PEOPLE_TIMEOUT = wsPeopleFails("timeout");

const MOCKS = {
  healthy: WS_HEALTHY + FETCH_OK,
  people_rpc_error: PEOPLE_RPC_ERROR,
  people_timeout: PEOPLE_TIMEOUT,
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
  // Chain + gateway probes succeed, but the AccountInfoOf storage read returns null at the
  // configured address (a reset chain with a stale-but-configured address).
  dotns_contract_missing: FETCH_OK + DOTNS_MISSING_CODE,
  // The storage read never resolves — must time out, not hang or false-pass.
  dotns_timeout: FETCH_OK + DOTNS_HANGS,
};

describe("probe-env-health", () => {
  test("exits 0 on healthy chain", async () => {
    const { code, stdout } = await runProbe({ env: "paseo-next-v2", scenario: "healthy" });
    assert.strictEqual(code, 0, `expected exit 0, got ${code}; stdout: ${stdout}`);
    assert.match(stdout, /healthy/i);
    // #1595 follow-up: the People chain is still probed and reported even
    // though it's advisory-only now — this just isn't gating.
    assert.match(stdout, /people=Mock Chain/, ">> FAIL: probe-env-health: healthy output must report the People chain's system_chain result");
  });

  // #1595 follow-up (reverted from gating, per maintainer; port of bulletin
  // PR #1596-follow-up): a People-only failure must NOT flip env health.
  // select-env gates every E2E job in the workflow — including ones that
  // never touch the People chain — and this repo has only one e2eEligible
  // env, so there is nothing to fall back to: gating on People here would
  // fail every job outright. Chains that DO need People now fall back at
  // the test level instead (test/e2e-chain-calls.test.js's
  // connectChainWithFallback()). This probe still reports People's status
  // for visibility, just doesn't gate on it.
  describe("People is advisory-only, not gating (#1595 follow-up)", () => {
    test("a People-only RPC error still exits 0 (healthy), with People reported down", async () => {
      const { code, stdout, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "people_rpc_error" });
      assert.strictEqual(code, 0, `>> FAIL: people-advisory: a People-only RPC error must not fail the env — got exit ${code}, stderr: ${stderr}`);
      assert.match(stdout, /healthy/i);
      assert.match(stdout, /people=DOWN/, ">> FAIL: people-advisory: healthy output must still report People as DOWN when its own probe fails");
      assert.match(stderr, /advisory: people/, ">> FAIL: people-advisory: the People failure must still be logged (to stderr) even though it doesn't gate");
    });

    test("a People-only RPC hang still exits 0 after the bound (healthy), with People reported down", async () => {
      const { code, stdout } = await runProbe({ env: "paseo-next-v2", scenario: "people_timeout", timeoutMs: 500 });
      assert.strictEqual(code, 0, ">> FAIL: people-advisory: a People-only timeout must not fail the env");
      assert.match(stdout, /people=DOWN/, ">> FAIL: people-advisory: healthy output must report People as DOWN when its probe times out");
    });
  });

  test("exits non-zero on WS connect error", async () => {
    const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "ws_connect_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /ws_connect_error/);
  });

  test("exits non-zero on rpc error", async () => {
    const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "rpc_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /rpc_error/);
  });

  test("exits non-zero on runtime_call_error", async () => {
    const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "runtime_call_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /runtime_call_error/);
  });

  test("exits non-zero on timeout", async () => {
    const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "timeout", timeoutMs: 500 });
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
    const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "gateway_error" });
    assert.notStrictEqual(code, 0);
    assert.match(stderr, /gateway_error/);
    assert.match(stderr, /gateway /);
  });

  // Issue #1329: DotNS deploys through a CREATE3 factory, so contract
  // addresses are IDENTICAL across every env and stable across a chain
  // reset — a healthy RPC + a configured address proves nothing about
  // whether the contracts actually exist on that chain. The probe must
  // check code presence, not just address configuration.
  describe("DotNS contract-presence check (issue #1329)", () => {
    test("stack whose descriptor lacks the checked DotNS contracts is unhealthy", async () => {
      // Chain probes still need mocking so the probe gets to the DotNS check at all.
      const root = probeCopyWithout(["popRules", "controller"]);
      try {
        const { code, stderr } = await runProbe({ env: "preview", scenario: "healthy", cwd: root });
        assert.notStrictEqual(code, 0, ">> FAIL: no-contracts: expected non-zero exit for a stack whose descriptor lists neither checked contract");
        assert.match(stderr, /dotns_not_configured/, `>> FAIL: no-contracts: expected dotns_not_configured, got: ${stderr}`);
        assert.match(stderr, /dotns\.popRules, dotns\.controller/, `>> FAIL: no-contracts: the message must list every missing dotns key, got: ${stderr}`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("env whose contracts have no code on chain is unhealthy", async () => {
      const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "dotns_contract_missing" });
      assert.notStrictEqual(code, 0, ">> FAIL: contract-missing: expected non-zero exit when the AccountInfoOf read returns null (no code)");
      assert.match(stderr, /dotns_contract_missing/, `>> FAIL: contract-missing: expected dotns_contract_missing, got: ${stderr}`);
      assert.match(stderr, /dotns\.popRules/, ">> FAIL: contract-missing: message should name the descriptor key of the contract that failed");
    });

    test("a hanging storage read times out rather than hanging or false-passing", async () => {
      const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "dotns_timeout", timeoutMs: 500 });
      assert.notStrictEqual(code, 0, ">> FAIL: dotns-timeout: a stalled contract-code read must fail, not hang");
      assert.match(stderr, /timeout/, `>> FAIL: dotns-timeout: expected timeout classification, got: ${stderr}`);
    });

    test("healthy env with real contract code still passes end to end", async () => {
      const { code, stdout } = await runProbe({ env: "paseo-next-v2", scenario: "healthy" });
      assert.strictEqual(code, 0, `>> FAIL: dotns-healthy: expected exit 0 with DotNS contracts present; stdout: ${stdout}`);
      assert.match(stdout, /healthy/i);
    });

    // The storage prefix is hardcoded in the probe because Node has no
    // twox128 and the tool must stay dependency-free. Nothing else would
    // notice if it drifted: a wrong prefix reads null for EVERY address, so
    // every env would look contract-less and select-env would reject them
    // all. Re-derive it here from @polkadot/util-crypto (a devDependency,
    // fine in tests) and pin.
    test("the hardcoded AccountInfoOf storage prefix still matches twox128(Revive)+twox128(AccountInfoOf)", async () => {
      const { xxhashAsU8a, cryptoWaitReady } = await import("@polkadot/util-crypto");
      await cryptoWaitReady();
      const hex = (u8) => Buffer.from(u8).toString("hex");
      const expected = hex(xxhashAsU8a("Revive", 128)) + hex(xxhashAsU8a("AccountInfoOf", 128));
      const src = fs.readFileSync(new URL("../tools/probe-env-health.mjs", import.meta.url), "utf8");
      const m = src.match(/REVIVE_ACCOUNT_INFO_PREFIX\s*=\s*"([0-9a-f]{64})"/);
      assert.ok(m, ">> FAIL: dotns-prefix: could not find REVIVE_ACCOUNT_INFO_PREFIX in probe-env-health.mjs");
      assert.strictEqual(m[1], expected, ">> FAIL: dotns-prefix: hardcoded prefix no longer matches twox128(\"Revive\")+twox128(\"AccountInfoOf\") — a wrong prefix reads null for every address and would mark every env contract-less");
    });
  });
});

// ---------------------------------------------------------------------------
// loadEnv() drift guard (port of bulletin #1538, probe-env-health half only —
// the twin has no chunk-sharing-report.mjs, so that half of #1538 doesn't apply)
// ---------------------------------------------------------------------------
// loadEnv() reads the shipped copies without dist/ (see the comment above it in
// tools/probe-env-health.mjs). This compares it against dist/stacks.js's
// readShippedStack() for every e2eEligible stack, the set select-env probes, so a
// divergence on either side fails here instead of in a CI run.
describe("loadEnv() drift guard against the real resolver (#1535)", () => {
  test("loadEnv() agrees with readShippedStack() for every e2eEligible stack", async () => {
    const { loadEnv } = await import("../tools/probe-env-health.mjs");
    const { readShippedStack, BUILT_IN_STACK_IDS } = await import("../dist/stacks.js");
    const e2eEligibleIds = BUILT_IN_STACK_IDS.filter((id) => readShippedStack(id).e2eEligible);
    assert.ok(e2eEligibleIds.length > 0, ">> FAIL: loadEnv-drift-guard: no e2eEligible stack in assets/stack-policy.json");

    for (const envId of e2eEligibleIds) {
      const fromCopies = loadEnv(envId);
      assert.ok(!fromCopies.error, `>> FAIL: loadEnv-drift-guard ${envId}: loadEnv() itself errored: ${fromCopies.error?.message}`);
      const stack = readShippedStack(envId);
      assert.strictEqual(fromCopies.assetHubRpc, stack.chains.AssetHub.rpc[0],
        `>> FAIL: loadEnv-drift-guard ${envId}: asset-hub RPC diverges from readShippedStack(): tool=${fromCopies.assetHubRpc}, resolver=${stack.chains.AssetHub.rpc[0]}`);
      assert.strictEqual(fromCopies.bulletinRpc, stack.chains.Bulletin.rpc[0],
        `>> FAIL: loadEnv-drift-guard ${envId}: bulletin RPC diverges from readShippedStack(): tool=${fromCopies.bulletinRpc}, resolver=${stack.chains.Bulletin.rpc[0]}`);
      assert.strictEqual(fromCopies.peopleRpc, stack.chains.People.rpc[0],
        `>> FAIL: loadEnv-drift-guard ${envId}: people RPC diverges from readShippedStack(): tool=${fromCopies.peopleRpc}, resolver=${stack.chains.People.rpc[0]}`);
      assert.strictEqual(fromCopies.gatewayUrl, stack.ipfsGateway,
        `>> FAIL: loadEnv-drift-guard ${envId}: gateway URL diverges from readShippedStack(): tool=${fromCopies.gatewayUrl}, resolver=${stack.ipfsGateway}`);
      assert.deepStrictEqual(Object.entries(fromCopies.dotns).sort(), Object.entries(stack.descriptor.dotns ?? {}).sort(),
        `>> FAIL: loadEnv-drift-guard ${envId}: dotns diverges from readShippedStack(): tool=${JSON.stringify(fromCopies.dotns)}, resolver=${JSON.stringify(stack.descriptor.dotns)}`);
    }
  });

  test("loadEnv() resolves an alias to its built-in stack", async () => {
    const { loadEnv } = await import("../tools/probe-env-health.mjs");
    assert.strictEqual(loadEnv("previewnet").id, "preview",
      ">> FAIL: loadEnv alias: select-env passes ids and aliases alike, so 'previewnet' must probe the preview stack");
  });
});
