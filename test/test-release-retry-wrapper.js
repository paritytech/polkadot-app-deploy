import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { classifyForRetry, HARNESS_GUARD_MARKER, NO_RETRY_EXIT_CODE, FLAKE_PATTERNS } from "../tools/release-retry-wrapper.mjs";

const WRAPPER = new URL("../tools/release-retry-wrapper.mjs", import.meta.url).pathname;

test("classifyForRetry: flake-class patterns return exit 75", () => {
  const flakes = [
    "tx Invalid: Stale",
    'Revive.call: attempt 1/3 failed ({ "type": "Invalid", "value": { "type": "Stale" } }), retrying...',
    'Deployment failed: { "type": "Invalid", "value": { "type": "Stale" } }',
    "ChainHead disjointed",
    "Connection lost and max reconnections (3) exhausted",
    "Account auto-mapping did not take effect on-chain for 5DfhGyQd",
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

// #1649: the retry decision reads the FINAL failure only. src/deploy.ts prints
// "Connection lost ..., reconnecting..." for reconnects that RECOVER, and a later
// deterministic failure in the same run used to exit 75 because of it.
const RECONNECT_LINES = [
  "\n   Connection lost (heartbeat timeout), reconnecting...\n",
  "\n   Connection lost, reconnecting to Bulletin in 2s (1/5)...\n",
];
const CONTENTHASH = "Post-deploy verification failed for app.dot: on-chain contenthash is 0x00";

test("classifyForRetry: a recovered reconnect does not make a later deterministic failure retry-eligible (#1649)", () => {
  for (const log of RECONNECT_LINES) {
    // bare message, CLI shape, and the harness shape whose "seen tail" can quote the reconnect line
    for (const failure of [
      CONTENTHASH,
      `Deployment failed: ${CONTENTHASH}`,
      `>> FAIL: S1 deploy: unknown (exit 1)\n   seen tail:\n     ${log.trim()}\n     ${CONTENTHASH}`,
    ]) {
      assert.strictEqual(classifyForRetry(log + failure, 1), 1,
        `>> FAIL: retry-wrapper: recovered reconnect + deterministic failure must not retry: ${failure.slice(0, 60)}`);
    }
  }
});

test("classifyForRetry: a flake that IS the final failure still retries after recovered reconnects (#1649 cross-table cases)", () => {
  const finals = [
    "Connection lost and max reconnections (5) exhausted",
    "Connection lost and max reconnections (5) exhausted after phase B — finality probe unavailable. Retry the deploy.",
    "Invalid: Stale",
    "roundtrip budget exhausted: HTTP 504",
    "Error: bulletin-deploy requires Node.js >=22 (running v18.19.1).",
    "ChainHead disjointed",
    "Account auto-mapping did not take effect on-chain for 5Df. The signer needs enough testnet PAS",
  ];
  for (const log of RECONNECT_LINES) {
    for (const f of finals) {
      for (const failure of [f, `Deployment failed: ${f}`, `>> FAIL: S1 deploy: x (exit 1)\n   seen tail:\n     ${f}`]) {
        assert.strictEqual(classifyForRetry(log + failure, 1), 75,
          `>> FAIL: retry-wrapper: a final flake must retry after a recovered reconnect: ${f.slice(0, 50)}`);
      }
    }
  }
});

test("classifyForRetry: only the LAST failure block decides (#1649)", () => {
  const flake = 'Deployment failed: { "type": "Invalid", "value": { "type": "Stale" } }';
  const real = `>> FAIL: S1 deploy: contenthash (exit 1)\n   ${CONTENTHASH}`;
  assert.strictEqual(classifyForRetry(`${flake}\n${real}`, 1), 1,
    ">> FAIL: retry-wrapper: an earlier recovered flake must not retry a later deterministic failure");
  assert.strictEqual(classifyForRetry(`${real}\n${flake}`, 1), 75,
    ">> FAIL: retry-wrapper: a final flake must retry");
});

test("classifyForRetry: harness guard and no-retry keep precedence over a final-block flake (#1649)", () => {
  const out = `${HARNESS_GUARD_MARKER} leak\nDeployment failed: ChainHead disjointed`;
  assert.strictEqual(classifyForRetry(out, 1), 1);
  assert.strictEqual(classifyForRetry("Deployment failed: ChainHead disjointed", NO_RETRY_EXIT_CODE), NO_RETRY_EXIT_CODE);
});

test("wrapper: a recovered reconnect then a deterministic failure exits 1, a final flake exits 75 (#1649)", async () => {
  const run = (script) => new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, process.execPath, "-e", script]);
    child.on("close", resolve);
  });
  assert.strictEqual(await run(`console.error("   Connection lost (heartbeat timeout), reconnecting..."); console.error(${JSON.stringify(`Deployment failed: ${CONTENTHASH}`)}); process.exit(1);`), 1,
    ">> FAIL: retry-wrapper: recorded log, recovered reconnect + contenthash mismatch, must not exit 75");
  assert.strictEqual(await run(`console.error("   Connection lost, reconnecting to Bulletin in 2s (1/5)..."); console.error("Deployment failed: Connection lost and max reconnections (5) exhausted"); process.exit(1);`), 75,
    ">> FAIL: retry-wrapper: recorded log, exhausted reconnections, must exit 75");
});

// #1648: a needle nothing emits is dead weight that reads as coverage. The
// "Account mapping did not take effect" needle survived a rewording of its only
// producer for exactly that reason. Every needle in the wrapper and in the
// e2e-failure table must occur in a string src/ can emit, or be listed here
// with why no producer exists in src/.
const NEEDLES_WITHOUT_SRC_PRODUCER = {
  "Invalid: Stale": "papi 1.x transaction error text, not emitted by src/",
  '"type": "Stale"': "papi 2.x JSON-serialised transaction error, not emitted by src/",
  "ChainHead disjointed": "polkadot-api ChainHead follow-subscription error",
  "is not pinned": "polkadot-api / node error: 'Block 0x... is not pinned'",
  "received a shutdown signal": "GitHub Actions runner message, not from this code",
  "All promises were rejected": "AggregateError message of the JS engine's Promise.any (src/dotns.ts fetchNonce uses it)",
  "fetchManifestRoundtrip failed": "emitted by test/e2e.test.js, not src/",
  "Contract reverted (flags=1)": "pallet-revive dispatch error text, wrapped by src/ but not authored there",
};

// Needles whose producer interpolates part of the text: every listed fragment must occur in src/.
const COMPOSED_PRODUCERS = {
  "requires Node.js >=22": ["requires Node.js ${enginesNode}", "engines"],
  "ReviveApi.address timed out": ['"ReviveApi.address"', "${operationName} timed out after"],
};

function collectSrcProducerText() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      // telemetry.ts holds the classifier regexes, which mention needles without emitting them
      else if (e.name.endsWith(".ts") && e.name !== "telemetry.ts") out.push(readFileSync(full, "utf8"));
    }
  };
  walk(new URL("../src", import.meta.url).pathname);
  // drop comment text: a needle that only a comment mentions has no producer
  return out.join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("every wrapper and e2e-failure needle has a producer in src/ or a documented reason it has none (#1648)", () => {
  const e2eSource = readFileSync(new URL("./helpers/e2e-failure.js", import.meta.url), "utf8");
  const e2eNeedles = [...e2eSource.matchAll(/\{ needle: ((?:"(?:[^"\\]|\\.)*")|(?:'(?:[^'\\]|\\.)*')), class:/g)].map((m) => (m[1][0] === '"' ? JSON.parse(m[1]) : m[1].slice(1, -1)));
  assert.ok(e2eNeedles.length >= 10, ">> FAIL: needle-producer guard: could not parse the e2e-failure table, so this guard proves nothing");
  const needles = new Set([...FLAKE_PATTERNS, ...e2eNeedles]);
  const src = collectSrcProducerText();
  for (const needle of needles) {
    if (needle in NEEDLES_WITHOUT_SRC_PRODUCER) continue;
    const fragments = COMPOSED_PRODUCERS[needle] ?? [needle];
    assert.ok(fragments.every((f) => src.includes(f)),
      `>> FAIL: needle-producer guard: the flake needle ${JSON.stringify(needle)} appears in no string src/ emits, so it can never match. Update it to the producer's current wording, or list it in NEEDLES_WITHOUT_SRC_PRODUCER with the external source.`);
  }
  for (const listed of Object.keys(NEEDLES_WITHOUT_SRC_PRODUCER)) {
    assert.ok(needles.has(listed), `>> FAIL: needle-producer guard: NEEDLES_WITHOUT_SRC_PRODUCER lists ${JSON.stringify(listed)}, which is in neither table. Remove it.`);
  }
});
