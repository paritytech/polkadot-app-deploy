import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROBE_SCRIPT = path.resolve("tools/probe-env-health.mjs");

// Helper: run the probe with the WebSocket constructor mocked via a stub
// preload file. We can't trivially inject mocks into an ESM script invoked
// as a child process, so we drive the probe through a Node --import preload
// that replaces globalThis.WebSocket before the probe runs.
// `cwd` defaults to the repo root; a test that needs a synthetic
// assets/environments.json (e.g. an env with no contracts block, which no
// real fixture in this repo has — both paseo-next-v2 and devnet declare
// DotNS contracts) overrides it to a temp dir and PROBE_SCRIPT's absolute
// path keeps the probe itself resolvable regardless of cwd.
function runProbe({ env, scenario, timeoutMs = 5000, cwd }) {
  return new Promise((resolve) => {
    const preload = path.join(os.tmpdir(), `ws-mock-${scenario}-${Date.now()}.mjs`);
    fs.writeFileSync(preload, MOCKS[scenario]);
    const child = spawn(
      process.execPath,
      ["--import", preload, PROBE_SCRIPT, "--env", env, "--timeout-ms", String(timeoutMs)],
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

// Builds a throwaway repo root (assets/environments.json only — that's all
// loadEnv() reads) with one env, `no-contracts`, that has valid chain
// endpoints but declares no `contracts` block at all. Used only by the
// "no contracts block" test below; every real env in this repo has one.
function makeNoContractsFixtureDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-env-health-fixture-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(
    path.join(dir, "assets", "environments.json"),
    JSON.stringify({
      environments: [{ id: "no-contracts", name: "No Contracts", network: "paseo", ipfs: "http://gateway.example" }],
      chains: [
        { id: "asset-hub", endpoints: { "no-contracts": { wss: "wss://asset-hub.example" } } },
        { id: "bulletin", endpoints: { "no-contracts": { wss: "wss://bulletin.example" } } },
        // #1595 follow-up: loadEnv() now requires a people RPC too (see
        // probe-env-health.mjs), so this synthetic fixture must declare one
        // or every test using it would fail on a missing-people-RPC
        // config_error before ever reaching the dotns_not_configured check
        // this fixture exists to exercise.
        { id: "people", endpoints: { "no-contracts": { wss: "wss://people.example" } } },
      ],
    }),
  );
  return dir;
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

// People probe (#1595 follow-up, port of bulletin PR #1596-follow-up):
// distinguishes behavior by connection URL, since a real env's
// asset-hub/bulletin/people endpoints differ (see assets/environments.json's
// paseo-next-v2 entry — e.g. "paseo-asset-hub-next-rpc" vs
// "paseo-people-next-system-rpc"). Asset Hub + Bulletin stay healthy; only
// the People connection errors or hangs, proving the probe attributes the
// failure to the right chain rather than needing all three down to notice.
// One factory (same pattern as wsWithStorage() above) instead of two
// hand-copied mock classes that would otherwise repeat the
// system_chain/state_call/state_getStorage response ternary a second and
// third time.
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

  // bulletin-deploy issue #1329: DotNS deploys through a CREATE3 factory, so
  // contract addresses are IDENTICAL across every env and stable across a
  // chain reset — a healthy RPC + a configured address proves nothing about
  // whether the contracts actually exist on that chain. The probe must check
  // code presence, not just address configuration. (port of bulletin #1353)
  describe("DotNS contract-presence check (bulletin-deploy issue #1329)", () => {
    test("env with no contracts block at all is unhealthy", async () => {
      // No real env in this repo's assets/environments.json omits
      // `contracts` (both paseo-next-v2 and devnet declare it), so this test
      // builds a throwaway repo root with a synthetic env that has valid
      // chain endpoints but no contracts block at all.
      const fixtureDir = makeNoContractsFixtureDir();
      try {
        const { code, stderr } = await runProbe({ env: "no-contracts", scenario: "healthy", cwd: fixtureDir });
        assert.notStrictEqual(code, 0, ">> FAIL: no-contracts-block: expected non-zero exit for an env with no contracts configured");
        assert.match(stderr, /dotns_not_configured/, `>> FAIL: no-contracts-block: expected dotns_not_configured, got: ${stderr}`);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    test("env whose contracts have no code on chain is unhealthy", async () => {
      const { code, stderr } = await runProbe({ env: "paseo-next-v2", scenario: "dotns_contract_missing" });
      assert.notStrictEqual(code, 0, ">> FAIL: contract-missing: expected non-zero exit when the AccountInfoOf read returns null (no code)");
      assert.match(stderr, /dotns_contract_missing/, `>> FAIL: contract-missing: expected dotns_contract_missing, got: ${stderr}`);
      assert.match(stderr, /POP_RULES/, ">> FAIL: contract-missing: message should name the address/contract key that failed");
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
// Why loadEnv() stays a hand-parse: see the comment above loadEnv() in
// tools/probe-env-health.mjs. This test runs under `npm test`, where dist/ IS
// built (unlike the CI job that constraint is about), and compares loadEnv()
// against src/environments.ts's resolveEndpoints() for every e2eEligible env
// — the set select-env actually probes — so a future edit to either side that
// silently diverges fails loudly here instead of in a 3am CI run.
describe("loadEnv() drift guard against the real resolver", () => {
  test("loadEnv() agrees with resolveEndpoints() for every e2eEligible env", async () => {
    const distPath = new URL("../dist/environments.js", import.meta.url);
    if (!fs.existsSync(distPath)) {
      throw new Error(">> FAIL: loadEnv-drift-guard: dist/environments.js not found — run `npm run build` first");
    }
    const { loadEnv } = await import("../tools/probe-env-health.mjs");
    const { loadEnvironments, resolveEndpoints } = await import("../dist/environments.js");

    const { doc } = await loadEnvironments();
    const e2eEligibleIds = doc.environments.filter((e) => e.e2eEligible).map((e) => e.id);
    assert.ok(e2eEligibleIds.length > 0, ">> FAIL: loadEnv-drift-guard: fixture assumption broken — no e2eEligible envs found in assets/environments.json");

    for (const envId of e2eEligibleIds) {
      const fromHandParse = loadEnv(envId);
      assert.ok(!fromHandParse.error, `>> FAIL: loadEnv-drift-guard ${envId}: loadEnv() itself errored: ${fromHandParse.error?.message}`);

      const resolved = resolveEndpoints(doc, envId);
      assert.strictEqual(fromHandParse.assetHubRpc, resolved.assetHub[0],
        `>> FAIL: loadEnv-drift-guard ${envId}: asset-hub RPC diverges from resolveEndpoints() — hand-parse=${fromHandParse.assetHubRpc}, resolver=${resolved.assetHub[0]}`);
      assert.strictEqual(fromHandParse.bulletinRpc, resolved.bulletin[0],
        `>> FAIL: loadEnv-drift-guard ${envId}: bulletin RPC diverges from resolveEndpoints() — hand-parse=${fromHandParse.bulletinRpc}, resolver=${resolved.bulletin[0]}`);
      assert.strictEqual(fromHandParse.gatewayUrl, resolved.ipfs,
        `>> FAIL: loadEnv-drift-guard ${envId}: gateway URL diverges from resolveEndpoints() — hand-parse=${fromHandParse.gatewayUrl}, resolver=${resolved.ipfs}`);
    }
  });
});
