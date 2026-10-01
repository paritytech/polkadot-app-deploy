import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { classifyForRetry, HARNESS_GUARD_MARKER, NO_RETRY_EXIT_CODE, FLAKE_PATTERNS } from "../tools/release-retry-wrapper.mjs";

const WRAPPER = new URL("../tools/release-retry-wrapper.mjs", import.meta.url).pathname;

test("classifyForRetry: flake-class patterns return exit 75", () => {
  const flakes = [
    "tx Invalid: Stale",
    'Revive.call: attempt 1/3 failed ({ "type": "Invalid", "value": { "type": "Stale" } }), retrying...',
    'Deployment failed: { "type": "Invalid", "value": { "type": "Stale" } }',
    "ChainHead disjointed",
    "Connection lost and max reconnections (3) exhausted",
    "Account mapping did not take effect on-chain for 5DfhGyQd",
  ];
  for (const stderr of flakes) {
    assert.strictEqual(classifyForRetry(stderr), 75,
      `expected exit 75 (retry-eligible) for stderr containing: ${stderr.slice(0, 50)}`);
  }
});

test("classifyForRetry: unverifiable code presence is retry-eligible, a missing contract is not", () => {
  // null = the code-presence query failed (retry). false = a verdict (no retry).
  assert.strictEqual(
    classifyForRetry("paseo-next-v2 (POP_RULES 0xabc): Could not determine the DotNS ABI profile: neither pricingVersion() (v0.5.8-rc1) nor startingPrice() (poprules-startingPrice) answered. Code presence at this address could not be verified either (the runtime code-presence query failed), so a wrong/undeployed POP_RULES address is also possible."),
    75,
  );
  assert.strictEqual(
    classifyForRetry("paseo-next-v2 (POP_RULES 0xabc): No contract deployed at this address — could not detect the DotNS ABI profile because no contract code was found here."),
    1,
  );
});

test("classifyForRetry: a harness-guard failure is never retried, even alongside flake wording", () => {
  // S8 and S-GRANDPA-REUPLOAD log "Connection lost" while passing, so without
  // this a deterministic leak would rerun the whole scenario (#1393).
  const output = `Connection lost and max reconnections (3) exhausted\n${HARNESS_GUARD_MARKER} process still alive 30s after the suite finished.`;
  // 1 is the code CI produces: node --test normalises its child's exit code.
  assert.strictEqual(classifyForRetry(output, 1), 1,
    ">> FAIL: retry-wrapper: a harness-guard failure must fail fast, not classify as a flake");
  assert.strictEqual(classifyForRetry(output, NO_RETRY_EXIT_CODE), NO_RETRY_EXIT_CODE,
    ">> FAIL: retry-wrapper: a direct CLI no-retry exit must also fail fast");
  // Keyed on the code, so a flake earlier in the same run still retries when
  // the harness exited cleanly.
  assert.strictEqual(classifyForRetry("Connection lost and max reconnections (3) exhausted", 1), 75,
    ">> FAIL: retry-wrapper: a genuine flake must still retry");
});

// End to end in the shape CI uses: wrapper -> node --test -> a leaking file that
// also logs flake wording.
test("wrapper: a harness leak in a leg that logs flake wording does not retry", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawn } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-e2e-"));
  const guard = new URL("./helpers/e2e-exit-guard.js", import.meta.url).href;
  fs.writeFileSync(path.join(dir, "leaky.test.js"), `
import { test } from "node:test";
import { trackTimers, armExitGuard } from ${JSON.stringify(guard)};
trackTimers();
test("passes but leaks", () => {
  process.stderr.write("Connection lost and max reconnections (3) exhausted\\n");
  setInterval(() => {}, 5000);
});
process.on("exit", () => {});
setTimeout(() => armExitGuard(300), 100);
`);
  try {
    // Otherwise the inner runner sees the outer one, skips every file and exits 0.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [WRAPPER, process.execPath, "--test", path.join(dir, "leaky.test.js")], { stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { out += c; });
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("timed out")); }, 60_000);
      child.on("close", (c) => { clearTimeout(t); resolve(c); });
    });
    const tail = out.trim().split("\n").slice(-3).join(" | ");
    // Positive first: otherwise a fixture that fails to load passes this test.
    assert.ok(out.includes(HARNESS_GUARD_MARKER),
      `>> FAIL: retry-wrapper: the fixture never printed the guard marker, so this test proves nothing; ${tail}`);
    assert.ok(out.includes("Connection lost"),
      `>> FAIL: retry-wrapper: the fixture never logged flake wording, so this test proves nothing; ${tail}`);
    assert.strictEqual(code, 1,
      `>> FAIL: retry-wrapper: a deterministic harness leak must fail fast with the child's code, not be retried as a flake; got ${code}; ${tail}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyForRetry: arbitrary errors return exit 1", () => {
  const real = [
    "Post-deploy verification failed: on-chain contenthash mismatch",
    "Contract execution would revert during setRoot",
    "assertion failed at test/e2e.test.js:42",
  ];
  for (const stderr of real) {
    assert.strictEqual(classifyForRetry(stderr), 1,
      `expected exit 1 (fail-fast) for stderr containing: ${stderr.slice(0, 50)}`);
  }
});

test("classifyForRetry: empty stderr on success returns exit 0", () => {
  assert.strictEqual(classifyForRetry("", 0), 0);
});

test("classifyForRetry: child non-zero exit with unrecognized stderr is exit 1", () => {
  assert.strictEqual(classifyForRetry("some unrelated chatter", 1), 1);
});

test("classifyForRetry: new infra-flake patterns return exit 75", () => {
  const infra = [
    "Error: bulletin-deploy requires Node.js >=22 (running v18.19.1).",
    "received a shutdown signal",
    "chunk(nonce:9561) subscription error: Block 0x466ab0... is not pinned (stop-call)",
  ];
  for (const output of infra) {
    assert.strictEqual(classifyForRetry(output), 75,
      `expected exit 75 (retry-eligible) for output containing: ${output.slice(0, 60)}`);
  }
});

test("classifyForRetry: chain/block-inclusion timeout patterns return exit 75 (#1050)", () => {
  const chainTimeouts = [
    "Deployment failed: chunk(nonce:15594) timed out after 180s waiting for block confirmation",
    "transaction watcher silent for 60s, aborting",
    "chunk(nonce:203) not included after 120s of chain progress (budget=180s)",
    "Deployment did not settle within 300s wall-clock ceiling",
  ];
  for (const output of chainTimeouts) {
    assert.strictEqual(classifyForRetry(output), 75,
      `expected exit 75 (retry-eligible) for output containing: ${output.slice(0, 60)}`);
  }
});

test("classifyForRetry: AH ReviveApi.address timeout is retry-eligible (#1131)", () => {
  const ahTimeouts = [
    "Deployment failed: DotNS connect: failed to resolve EVM address from 5HbjRq... via ReviveApi.address (ReviveApi.address timed out after 30000ms); RPC: wss://paseo-asset-hub-next-rpc.polkadot.io",
    "Error: ReviveApi.address timed out after 30000ms",
  ];
  for (const output of ahTimeouts) {
    assert.strictEqual(classifyForRetry(output), 75,
      `expected exit 75 (retry-eligible) for AH-RPC ReviveApi.address timeout: ${output.slice(0, 60)}`);
  }
});

test("classifyForRetry: IPFS gateway roundtrip budget exhaustion is retry-eligible", () => {
  const out = "S-INC-ROUNDTRIP: roundtrip budget exhausted after 30000ms";
  assert.strictEqual(classifyForRetry(out, 1), 75,
    ">> FAIL: retry-classify: gateway roundtrip timeout must be retry-eligible (75) — the deploy already finalised on-chain, only the HTTP readback failed");
});

test("classifyForRetry: Promise.any exhaustion (every RPC endpoint failed) is retry-eligible", () => {
  assert.strictEqual(classifyForRetry("Deployment failed: All promises were rejected", 1), 75,
    ">> FAIL: retry-classify: 'All promises were rejected' must be retry-eligible (75) — every endpoint failing is a network window, #1627");
});

test("classifyForRetry: a manifest CONTENT mismatch must NOT be retry-eligible", () => {
  const out = "S-INC-ROUNDTRIP: manifest content mismatch: expected bafy... got bafk...";
  assert.notStrictEqual(classifyForRetry(out, 1), 75,
    ">> FAIL: retry-classify: a real integrity regression must never be retried away");
});

test("wrapper reads stdout — flake pattern on stdout triggers exit 75", async () => {
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      WRAPPER,
      process.execPath,
      "-e",
      'process.stdout.write("ChainHead disjointed\\n"); process.exit(1);',
    ]);
    child.on("close", resolve);
  });
  assert.strictEqual(exitCode, 75,
    "expected wrapper to exit 75 when flake pattern appears on child stdout");
});

test("wrapper reads stdout — clean output with exit 1 produces wrapper exit 1", async () => {
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, [
      WRAPPER,
      process.execPath,
      "-e",
      'process.stdout.write("everything looks fine\\n"); process.exit(1);',
    ]);
    child.on("close", resolve);
  });
  assert.strictEqual(exitCode, 1,
    "expected wrapper to exit 1 when no flake pattern present and child exits 1");
});

// The wrapper substring-scans its child's whole output, and the child is the
// test runner. A flake phrase written into a failure hint, a failWith message
// or a ">> FAIL:" line therefore makes a deterministic failure buy a 30-minute
// retry. Only those printed strings are scanned, not the regexes that match a
// deploy's own output: the WS-fault scenarios test for flake wording on
// purpose, which HARNESS_GUARD_MARKER handles.
test("no flake pattern appears in a harness failure message or hint", () => {
  const harness = readFileSync(new URL("./e2e.test.js", import.meta.url), "utf8");
  const failurePath = harness.split("\n").filter((l) => /(^|\s)(hint|message):/.test(l) || l.includes(">> FAIL:"));
  for (const needle of FLAKE_PATTERNS) {
    const offender = failurePath.find((l) => l.includes(needle));
    assert.strictEqual(
      offender,
      undefined,
      `>> FAIL: test/e2e.test.js prints the flake pattern "${needle}" on a failure path, so tripping that assertion would be retried as a flake. Reword it. Line: ${offender?.trim()}`,
    );
  }
});
