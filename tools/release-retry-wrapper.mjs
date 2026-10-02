#!/usr/bin/env node
// Selective retry wrapper for release E2E.
//
// Spawns a child process (the deploy CLI / test runner invocation), captures
// stdout AND stderr, classifies the failure mode, and exits with 75 on
// flake-class matches (retry-eligible) or the child's own exit code otherwise.
//
// Both streams are passed through to the parent's stdout/stderr so the GH
// Actions job log still shows everything live.
//
// node --test captures each test-file subprocess's output and re-emits it as
// TAP YAML on its own stdout — so deploy CLI errors (e.g. "ChainHead
// disjointed") appear on stdout, not stderr. Capturing both is required.
//
// Configure nick-fields/retry@v3 with retry_on_exit_code: 75 so retries only
// fire for the named transient classes. See
// docs-internal/superpowers/specs/2026-05-22-ci-restructure-design.md.

import { spawn } from "node:child_process";

// Exact substrings that map to retry-eligible flake classes.
// Patterns derived from Sentry telemetry (top transient errors over 30d on
// the e2e-ci-pr and e2e-ci-release tags).
export const FLAKE_PATTERNS = [
  "Invalid: Stale",                          // tx Invalid/Stale (nonce race) — papi 1.x format
  '"type": "Stale"',                         // tx Invalid/Stale — papi 2.x JSON format
  "ChainHead disjointed",                    // RPC reorg / WS flake
  "Connection lost",                         // WS hard drop
  "is not pinned",                           // papi ChainHead subscription: node dropped block pin (stop-call)
  "Account auto-mapping did not take effect", // Revive mapping race (src/dotns.ts producer)
  "requires Node.js >=22",                   // parity-default runner downgrade (Node v18) — infra flake
  "received a shutdown signal",              // runner process killed mid-job — CI infra flake
  // Chain/block-inclusion timeouts — top transient error class on
  // paseo-next-v2 during the 2026-07 finality-lag incidents (#1050).
  "waiting for block confirmation",
  "transaction watcher silent for",
  "of chain progress (budget=",
  "did not settle within",
  // Asset Hub runtime-call (EVM address resolution) timeout — the paseo-next-v2
  // AH node degrades under concurrent E2E matrix load and times out ReviveApi.address
  // (#1131). A fresh CI retry lands in a recovered window. Not retried before, so a
  // single bad window failed the whole scenario (shifting failure sets across reruns).
  "ReviveApi.address timed out",
  // IPFS gateway readback timeout in S-INC-ROUNDTRIP. Emitted ONLY by
  // fetchManifestRoundtrip when the gateway cannot return a valid manifest
  // (network / HTTP failure) — the deploy itself has already finalised on-chain
  // and is p2p-retrievable. A genuine manifest CONTENT mismatch is a separate
  // assertion that never emits this string, so retrying cannot mask a real
  // integrity regression.
  "roundtrip budget exhausted",
  // hasContractCode returned null: the runtime code-presence query itself
  // failed. A contract that is genuinely absent answers false and produces a
  // different message, so retrying this cannot mask a missing contract.
  "Code presence at this address could not be verified",
  // Promise.any AggregateError message: every RPC endpoint in the list failed.
  // The only Promise.any in src/ is fetchNonce (src/dotns.ts), whose per-endpoint
  // rejections are all transport-level (WS error/close, 8s timeout, malformed
  // frame, RPC error) — contract reads and reverts never go through it, so a
  // deterministic failure cannot produce this string. Evidence (#1627): red s1
  // direct/js (bulletin 09-29), s-subdomain (p-a-d 10-01), s-inc/kubo (p-a-d
  // 09-23), each green the next night with no code change.
  "All promises were rejected",
];

// Printed by the E2E harness when it outlives its suite. A leak is deterministic,
// and the WS-fault scenarios log flake wording while passing, so it must not retry.
export const HARNESS_GUARD_MARKER = ">> FAIL: e2e harness:";

// EXIT_CODE_NO_RETRY from src/errors.ts, reachable only when the wrapper spawns
// the CLI directly: node --test normalises its child's code to 1, which is why
// the marker is checked too.
export const NO_RETRY_EXIT_CODE = 78;

// Progress lines src/deploy.ts prints for a reconnect that is being RECOVERED:
// "Connection lost (<reason>), reconnecting..." and "Connection lost, reconnecting to
// Bulletin in Ns (i/N)...". They say the opposite of "the run failed", so they are
// never evidence of the failure. The terminal "Connection lost and max reconnections
// (N) exhausted" has no ", reconnecting" and is untouched (#1649).
const RECOVERED_RECONNECT_RE = /Connection lost[^\n]*?, reconnecting[^\n]*/g;

// What a run that FAILED printed last. The failure the run ends on starts at the last of
// these; text before it is progress of attempts that recovered (retried Stale txs,
// reconnects, earlier passing tests) and says nothing about why the run is red.
const FINAL_FAILURE_ANCHORS = [">> FAIL:", "Deployment failed"];

// The text a retry decision may read: the child's output without recovered-reconnect
// progress lines, cut to the last failure block when the output has one. Output with no
// anchor (a bare error line) is read whole.
export function finalFailureRegion(output) {
  const text = output.replace(RECOVERED_RECONNECT_RE, "");
  const start = Math.max(...FINAL_FAILURE_ANCHORS.map((a) => text.lastIndexOf(a)));
  return start < 0 ? text : text.slice(start);
}

// output: combined stdout+stderr text from the child. A flake pattern in the FINAL
// failure makes the run retry-eligible. The harness-guard and no-retry checks keep
// precedence and read the whole output / the exit code, as before.
export function classifyForRetry(output, childExitCode = 1) {
  if (childExitCode === 0) return 0;
  if (childExitCode === NO_RETRY_EXIT_CODE) return NO_RETRY_EXIT_CODE;
  if (output.includes(HARNESS_GUARD_MARKER)) return childExitCode || 1;
  const failure = finalFailureRegion(output);
  for (const pat of FLAKE_PATTERNS) {
    if (failure.includes(pat)) return 75;
  }
  return childExitCode || 1;
}

// CLI entry: when run directly, spawn argv tail as a child and classify.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: release-retry-wrapper.mjs <command> [args...]");
    process.exit(2);
  }
  const child = spawn(cmd, args, { stdio: ["inherit", "pipe", "pipe"] });
  let outputBuf = "";
  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk); // pass through stdout to job log
    outputBuf += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk); // pass through stderr to job log
    outputBuf += chunk.toString();
  });
  child.on("error", (err) => {
    process.stderr.write(`[release-retry-wrapper] failed to spawn: ${err.message}\n`);
    process.exit(1);
  });
  // Use `close` (not `exit`) so both pipes are fully drained before we
  // classify — `exit` can fire before the last `data` chunk lands.
  child.on("close", (code) => {
    const cls = classifyForRetry(outputBuf, code ?? 1);
    if (cls === 75) {
      console.error("[release-retry-wrapper] flake-class match — exiting 75 to signal retry");
    }
    process.exit(cls);
  });
}
