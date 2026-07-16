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
const FLAKE_PATTERNS = [
  "Invalid: Stale",                          // tx Invalid/Stale (nonce race) — papi 1.x format
  '"type": "Stale"',                         // tx Invalid/Stale — papi 2.x JSON format
  "ChainHead disjointed",                    // RPC reorg / WS flake
  "Connection lost",                         // WS hard drop
  "is not pinned",                           // papi ChainHead subscription: node dropped block pin (stop-call)
  "Account mapping did not take effect",     // Revive mapping race
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
];

// output: combined stdout+stderr text from the child. Any flake pattern
// appearing anywhere in the child's output makes the run retry-eligible.
export function classifyForRetry(output, childExitCode = 1) {
  if (childExitCode === 0) return 0;
  for (const pat of FLAKE_PATTERNS) {
    if (output.includes(pat)) return 75;
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
