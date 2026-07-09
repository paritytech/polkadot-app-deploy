import test from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { classifyForRetry } from "../tools/release-retry-wrapper.mjs";

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
