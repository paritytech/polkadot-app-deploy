#!/usr/bin/env node
// scripts/e2e-sigint-scenario.mjs — S7 chaos scenario for issue #181 Proposal 4.
//
// Usage:
//   FIXTURE_DIR=/path/to/build LABEL=e2epoolns01 DEPLOY_TAG=e2e-ci-nightly \
//   node scripts/e2e-sigint-scenario.mjs
//
// What it does:
//   1. Spawns `bulletin-deploy <FIXTURE_DIR> <LABEL>.dot --js-merkle --tag <DEPLOY_TAG>`.
//   2. Streams the child's stdout, watching for `Submitting <N> data chunks` —
//      the anchor that means chunk-upload has begun (src/deploy.ts:374).
//   3. Waits 3s after the anchor (gives the upload a chance to actually start
//      pumping bytes), then sends SIGINT to the child.
//   4. Asserts the child exited with code 130 (POSIX 128 + SIGINT=2).
//   5. Reads the run-state file at the platform-correct path
//      (src/run-state.ts) and asserts it contains
//      `status:"crashed"`, `reason:"SIGINT"`, `lastPeakRssMb` is a number.
//   6. Spawns `bulletin-deploy` a second time against e2eowned.dot
//      (Bob's domain — exits 78 with a clear error). The actual deploy
//      attempt isn't the point; what we're capturing is the relaunch
//      warning the binary prints BEFORE the deploy runs (bin/bulletin-deploy:93).
//      Asserts stderr contains `Previous deploy was interrupted (Ctrl-C). Continuing.`.
//   7. Exits 0 on all assertions passing, 1 on any failure.
//
// Sentry-side checks (deploy.killed:"SIGINT", deploy.sad:"true") live in
// tools/verify_nightly_telemetry.py (#181 P1, PR #190) — kept separate so
// this script doesn't need a Sentry token.
//
// State-dir caveat: on macOS the state directory is hardcoded to
// ~/Library/Application Support/polkadot-app-deploy and cannot be redirected
// via env var. Running this script locally on macOS will overwrite the
// user's `last-run.json`. CI (Linux) is unaffected since
// XDG_STATE_HOME=$RUNNER_TEMP/state isolates the test.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const FIXTURE_DIR = required("FIXTURE_DIR");
const PAD_ENV = process.env.PAD_ENV ?? process.env.DOTNS_ENV ?? "";
if (process.env.DOTNS_ENV && !process.env.PAD_ENV) {
  console.warn("DOTNS_ENV is deprecated; use PAD_ENV. Will be removed in a future release.");
}
const LABEL = process.env.LABEL ?? (PAD_ENV === "paseo-next-v2" ? "e2epoolns01" : "e2epool");
const OWNED_LABEL = process.env.OWNED_LABEL ?? (PAD_ENV === "paseo-next-v2" ? "e2eownedns02" : "e2eowned");
const DEPLOY_TAG = process.env.DEPLOY_TAG ?? "e2e-local-s7";
const RPC = process.env.BULLETIN_RPC ?? "wss://paseo-bulletin-rpc.polkadot.io";
const MNEMONIC = process.env.MNEMONIC ?? process.env.DOTNS_MNEMONIC;
const ANCHOR_TIMEOUT_MS = 10 * 60 * 1000;     // ceiling for the deploy to reach chunk-upload
const POST_ANCHOR_DELAY_MS = 3000;            // let upload start pumping bytes before SIGINT
const SHUTDOWN_TIMEOUT_MS = 30_000;           // SIGKILL escalation if SIGINT doesn't take
const SECOND_RUN_TIMEOUT_MS = 60_000;         // e2eowned.dot fails fast (~10s); generous ceiling

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`::error::${name} env var is required`);
    process.exit(2);
  }
  return v;
}

// Mirrors src/run-state.ts:39-56 (resolveStateDir + stateFilePath). Kept in
// sync by the "harness state path matches src/run-state.ts" anchor test in
// test/test.js. Importing the compiled dist/run-state.js isn't worth the CI
// cost (would force npm install + build before nightly-s7).
function stateFilePath() {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "polkadot-app-deploy", "last-run.json");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "polkadot-app-deploy", "last-run.json");
  }
  const base = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
    ? process.env.XDG_STATE_HOME
    : path.join(os.homedir(), ".local", "state");
  return path.join(base, "polkadot-app-deploy", "last-run.json");
}

function fail(reason) {
  console.error(`::error::S7 FAIL — ${reason}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✓ ${msg}`);
}

// ── Run 1: kill mid-chunk-upload ─────────────────────────────────
console.log("─── S7 Run 1: spawn bulletin-deploy and SIGINT mid-chunk-upload ───");

const envFlag = PAD_ENV ? ["--env", PAD_ENV] : [];
const args1 = [FIXTURE_DIR, `${LABEL}.dot`, "--js-merkle", "--tag", DEPLOY_TAG, ...envFlag];
const env1 = PAD_ENV ? { ...process.env } : { ...process.env, BULLETIN_RPC: RPC };
if (MNEMONIC) env1.MNEMONIC = MNEMONIC;

// Honor PAD_BIN so the source-build path in nightly CI can point
// at a local bin/bulletin-deploy instead of relying on $PATH. Falls back to
// "bulletin-deploy" for the npm-install path and for local invocations.
const PAD_BIN = process.env.PAD_BIN ?? "bulletin-deploy";

const child = spawn(PAD_BIN, args1, { env: env1, stdio: ["ignore", "pipe", "pipe"] });

let buffer = "";
let anchored = false;
let killTimer = null;

const exitPromise = new Promise((resolve) => {
  child.on("close", (code, signal) => resolve({ code, signal }));
});

const anchorPromise = new Promise((resolve, reject) => {
  const anchorTimeout = setTimeout(
    () => reject(new Error(`anchor "Submitting N data chunks" not seen within ${ANCHOR_TIMEOUT_MS}ms`)),
    ANCHOR_TIMEOUT_MS,
  );
  child.stdout.on("data", (chunk) => {
    const s = chunk.toString();
    buffer += s;
    process.stdout.write(s);
    if (!anchored && /Submitting \d+ data chunks/.test(buffer)) {
      anchored = true;
      clearTimeout(anchorTimeout);
      resolve();
    }
  });
  child.stderr.on("data", (chunk) => {
    const s = chunk.toString();
    buffer += s;
    process.stderr.write(s);
  });
  child.on("close", () => {
    clearTimeout(anchorTimeout);
    if (!anchored) reject(new Error("child exited before anchor was seen"));
  });
});

try {
  await anchorPromise;
  ok(`anchor "Submitting N data chunks" detected — waiting ${POST_ANCHOR_DELAY_MS}ms before SIGINT`);
  await delay(POST_ANCHOR_DELAY_MS);
  child.kill("SIGINT");
  killTimer = setTimeout(() => {
    console.error("child did not exit within shutdown timeout — escalating to SIGKILL");
    child.kill("SIGKILL");
  }, SHUTDOWN_TIMEOUT_MS);
} catch (err) {
  fail(`Run 1 setup: ${err.message}`);
}

const { code: exit1, signal: signal1 } = await exitPromise;
if (killTimer) clearTimeout(killTimer);

if (exit1 !== 130) {
  fail(`Run 1 expected exit 130 (POSIX SIGINT), got exit=${exit1} signal=${signal1 ?? "none"}`);
}
ok(`Run 1 exited with code 130 as expected`);

// ── State-file inspection ────────────────────────────────────────
const stateFile = stateFilePath();
console.log(`reading state file: ${stateFile}`);

let state;
try {
  state = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
} catch (err) {
  fail(`could not read or parse state file at ${stateFile}: ${err.message}`);
}

if (state.status !== "crashed") fail(`state.status expected "crashed", got "${state.status}"`);
if (state.reason !== "SIGINT") fail(`state.reason expected "SIGINT", got "${state.reason}"`);
if (typeof state.lastPeakRssMb !== "number" || state.lastPeakRssMb <= 0) {
  fail(`state.lastPeakRssMb expected positive number, got ${state.lastPeakRssMb}`);
}
ok(`state file: status="crashed" reason="SIGINT" lastPeakRssMb=${state.lastPeakRssMb}`);

// ── Run 2: relaunch warning ──────────────────────────────────────
console.log("─── S7 Run 2: relaunch should warn about the SIGINT'd previous run ───");

// Bob's domain returns exit 78 fast — perfect for capturing
// the relaunch warning that bin/bulletin-deploy:93 prints BEFORE the deploy
// proceeds. We don't care about the deploy outcome; we care about stderr.
const args2 = [FIXTURE_DIR, `${OWNED_LABEL}.dot`, "--js-merkle", "--tag", DEPLOY_TAG, ...envFlag];
const child2 = spawn(PAD_BIN, args2, { env: env1, stdio: ["ignore", "pipe", "pipe"] });

let stderr2 = "";
let stdout2 = "";
const exit2Promise = new Promise((resolve) => {
  child2.on("close", (code) => resolve(code));
});
child2.stdout.on("data", (chunk) => { const s = chunk.toString(); stdout2 += s; process.stdout.write(s); });
child2.stderr.on("data", (chunk) => { const s = chunk.toString(); stderr2 += s; process.stderr.write(s); });

const guard = setTimeout(() => child2.kill("SIGTERM"), SECOND_RUN_TIMEOUT_MS);
const exit2 = await exit2Promise;
clearTimeout(guard);

const combined = stdout2 + stderr2;
if (!combined.includes("Previous deploy was interrupted (Ctrl-C). Continuing.")) {
  fail(`Run 2 missing the relaunch warning. Combined output tail: ${combined.slice(-800)}`);
}
ok(`Run 2 emitted the relaunch warning ("Previous deploy was interrupted (Ctrl-C). Continuing.")`);

console.log(`\nS7 PASS — crash-capture infrastructure verified end-to-end.`);
console.log(`  exit codes: run1=${exit1} (SIGINT) run2=${exit2}`);
console.log(`  state file: ${stateFile}`);
process.exit(0);
