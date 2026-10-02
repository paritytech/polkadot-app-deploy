#!/usr/bin/env node
// Per-leg e2e-result.json: builder, reducer and CLI (#1625).
//
// Every nightly scenario leg writes one small JSON on success AND failure:
//   { scenario, env, signer, merkle, exit, class, signature, run_attempt, job, status }
// nightly-report reads those instead of downloading up to 60 job logs and
// grepping them (70 of 357 signatures last month came out "not found").
//
// Lives under .github/ on purpose: on published-version tiers the harness
// (test/, tools/) is overlaid from the release tag and a tag older than this
// change has no writer. .github/ always comes from the workflow's own SHA, so
// the composite action .github/actions/e2e-result can always derive the file
// from job.status + the step's captured log (the "fallback" path).
//
// CLI modes (all print to stdout, exit 0 on bad input so a reporting hiccup
// never turns a green run red):
//   write                          composite action: env-driven, writes the file + $GITHUB_OUTPUT
//   index <dir>                    nightly-report: TSV "job<TAB>class<TAB>signature", latest attempt per job
//   classify-text <text>           print the cause class for a signature string
//   dominant <causes.tsv>          "class<TAB>count<TAB>total<TAB>label" over "job<TAB>class" rows, or nothing

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Same wording list the runner-loss workflow uses: one list, no drift.
const { isRunnerLossMessage } = require("./classify-runner-loss.cjs");

// The harness-guard marker and the flake table come from modules that exist on
// every tag (test/helpers/e2e-failure.js since #529) but may not on a future
// layout change; a failed import degrades to "unknown", never to a crash.
async function tryImport(rel, pick, fallback) {
  try {
    const mod = await import(pathToFileURL(path.resolve(here, rel)).href);
    return pick(mod) ?? fallback;
  } catch {
    return fallback;
  }
}
// Fallback literal mirrors HARNESS_GUARD_MARKER in tools/release-retry-wrapper.mjs.
const HARNESS_GUARD_MARKER = await tryImport("../../tools/release-retry-wrapper.mjs", (m) => m.HARNESS_GUARD_MARKER, ">> FAIL: e2e harness:");
const classifyDeployStderr = await tryImport(
  "../../test/helpers/e2e-failure.js",
  (m) => m.classifyDeployStderr,
  () => ({ class: "unknown" }),
);

const MAX_SIGNATURE = 300;
const MAX_LOG_BYTES = 4 * 1024 * 1024;

function cleanLine(line) {
  return String(line)
    .replace(/\r/g, "")
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
    .replace(/^##\[error\]/, "")
    .trim();
}

/** First `>> FAIL:` line, else first `Deployment failed` line, else "". */
export function extractSignature(text) {
  const lines = String(text ?? "").split("\n").map(cleanLine);
  const hit = lines.find((l) => l.includes(">> FAIL:")) ?? lines.find((l) => l.includes("Deployment failed"));
  return hit ? hit.slice(0, MAX_SIGNATURE) : "";
}

/** Cause class for a failed leg. `pass` iff exit is 0. */
export function classifyLeg({ exit, text, status }) {
  if (Number(exit) === 0) return "pass";
  const t = String(text ?? "");
  if (isRunnerLossMessage(t) || t.split("\n").some(isRunnerLossMessage)) return "runner_loss";
  if (t.includes(HARNESS_GUARD_MARKER)) return "harness_leak";
  const cls = classifyDeployStderr(t).class;
  if (cls && cls !== "unknown") return cls;
  return status === "cancelled" ? "cancelled" : "unknown";
}

const str = (v) => (v == null ? "" : String(v));
const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
/** A recorded class that says something (not blank, unknown or pass). */
const informative = (c) => Boolean(c) && c !== "unknown" && c !== "pass";

/**
 * Build the result object.
 * `status` is job.status and is authoritative for pass/fail; `harness` is the
 * parsed file the in-process harness hook wrote (or null); `log` the captured
 * step output (or "").
 */
export function buildResult({ scenario, env, signer, merkle, job, status, log, harness, runAttempt, exit } = {}) {
  const h = harness && typeof harness === "object" ? harness : {};
  const failed = status ? status !== "success" : true;
  const harnessExit = num(h.exit);
  const code = failed ? harnessExit || num(exit) || 1 : harnessExit ?? num(exit) ?? 0;

  const text = str(log);
  const signature = str(h.signature) || extractSignature(text);
  let cls = "pass";
  if (code !== 0) {
    cls = informative(h.class) ? h.class : classifyLeg({ exit: code, text: text || signature, status });
    if (cls === "unknown" && harnessExit === 0) cls = "post_suite_failure";
  }
  const attempt = Number.parseInt(runAttempt ?? h.run_attempt, 10);
  return {
    scenario: str(scenario) || str(h.scenario),
    env: str(env) || str(h.env),
    signer: str(signer) || str(h.signer),
    merkle: str(merkle) || str(h.merkle),
    exit: code,
    class: cls,
    signature,
    run_attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    job: str(job) || str(h.job),
    status: str(status),
  };
}

const safe = (s) => str(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

/** Unique per leg and per attempt: upload-artifact refuses a name that already exists in the run. */
export function artifactName({ scenario, env, signer, merkle, job, run_attempt: runAttempt }) {
  const hash = createHash("sha1").update(str(job)).digest("hex").slice(0, 8);
  const parts = [scenario, env, signer, merkle].map(safe).filter((p) => p !== "x");
  return `e2e-result-${parts.join("-") || "leg"}-${hash}-a${Number.parseInt(runAttempt, 10) || 1}`;
}

/** The reusable workflow's jobs surface as "<caller name> / Deploy on <env>". */
export function normalizeJobName(name) {
  return str(name).replace(/ \/ Deploy on \S+$/, "").trim();
}

/** Map normalised job name to its highest-run_attempt result. */
export function latestPerJob(results) {
  const out = new Map();
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const key = normalizeJobName(r.job);
    const prev = out.get(key);
    if (!prev || (Number(r.run_attempt) || 1) >= (Number(prev.run_attempt) || 1)) out.set(key, r);
  }
  return out;
}

/** Cause for a RED leg: the recorded class, refined from the signature when it says nothing. */
export function legCause(result, signature) {
  if (informative(result?.class)) return result.class;
  const sig = str(signature);
  if (!sig) return "unknown";
  return classifyLeg({ exit: 1, text: sig });
}

/** Most common class; ties go alphabetically, with "unknown" losing every tie. */
export function dominantCause(classes) {
  if (!classes.length) return null;
  const counts = new Map();
  for (const c of classes) counts.set(c, (counts.get(c) || 0) + 1);
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] === "unknown") - (b[0] === "unknown") || (a[0] < b[0] ? -1 : 1),
  );
  return { class: ranked[0][0], count: ranked[0][1], total: classes.length };
}

/** GitHub caps label names at 50 characters; the dedup query joins labels with commas. */
export function causeLabel(cls) {
  const body = str(cls).toLowerCase().replace(/[^a-z0-9._-]/g, "_") || "unknown";
  return `nightly-cause:${body}`.slice(0, 50);
}

function readTail(file) {
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(size, MAX_LOG_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function modeWrite(env) {
  const input = {
    scenario: env.E2E_SCENARIO,
    env: env.E2E_ENV,
    signer: env.E2E_SIGNER,
    merkle: env.E2E_MERKLE,
    job: env.E2E_JOB_NAME,
    status: env.E2E_JOB_STATUS,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    log: env.E2E_LOG_PATH ? readTail(env.E2E_LOG_PATH) : "",
    harness: env.E2E_RESULT_PATH ? readJson(env.E2E_RESULT_PATH) : null,
  };
  const result = buildResult(input);
  const name = artifactName(result);
  const outDir = env.E2E_RESULT_OUT_DIR || path.join(env.RUNNER_TEMP || ".", "e2e-result-out");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `artifact=${name}\nfile=${file}\n`);
  console.log(`e2e-result: ${file}`);
  console.log(JSON.stringify(result));
}

function modeIndex(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return;
  }
  const results = names.map((n) => readJson(path.join(dir, n))).filter(Boolean);
  for (const [job, r] of latestPerJob(results)) {
    const flat = (s) => str(s).replace(/[\t\r\n]+/g, " ");
    console.log(`${flat(job)}\t${flat(legCause(r, r.signature))}\t${flat(r.signature)}`);
  }
}

function modeDominant(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {}
  const classes = text.split("\n").filter(Boolean).map((l) => l.split("\t")[1]).filter(Boolean);
  const d = dominantCause(classes);
  if (d) console.log(`${d.class}\t${d.count}\t${d.total}\t${causeLabel(d.class)}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const [mode, arg] = process.argv.slice(2);
  try {
    if (mode === "write") modeWrite(process.env);
    else if (mode === "index") modeIndex(arg);
    else if (mode === "classify-text") console.log(legCause(undefined, arg));
    else if (mode === "dominant") modeDominant(arg);
    else {
      console.error("usage: e2e-result.mjs write | index <dir> | classify-text <text> | dominant <causes.tsv>");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error(`e2e-result ${mode}: ${err?.message ?? err}`);
  }
}
