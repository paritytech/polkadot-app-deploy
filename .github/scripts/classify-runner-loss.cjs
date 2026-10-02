#!/usr/bin/env node
"use strict";

// Runner-loss classifier (port of bulletin #1638 / #1622): is every red leg of an E2E run a lost
// parity-default runner rather than a real failure?
//
// A lost runner leaves one of these failure annotations (or no log at all):
//   "The self-hosted runner lost communication with the server. ..."
//   "The runner has received a shutdown signal. ..."
//   "The operation was canceled."
// 31 red legs in 30 days were exactly that, each filing a nightly failure
// issue a human closed as "runner lost, nothing to fix".
//
// Verdicts:
//   all-runner-loss  at least one red job, and every red job is a lost runner
//   mixed            some red jobs are lost runners, at least one is not
//   none             no red job is a lost runner (including: no red jobs)
//   error            the run could not be read, or a counted job has no
//                    conclusion yet (CLI only). Fails CLOSED: anything but
//                    all-runner-loss files the failure issue (#1651).
//
// Used by e2e.yml's nightly-report job, which defers its failure issue to the
// runner-loss watchdog (e2e-runner-loss-rerun.yml) on an all-runner-loss
// first attempt of a scheduled run. The watchdog does not classify: it reads
// the report's deferral marker for the attempt that triggered it.
//
// Counted jobs: every job of the attempt except the report itself and the
// jobs matching EXCLUDE_JOBS. nightly-report passes the jobs OUTSIDE its
// `needs` there, so the verdict covers exactly the jobs the report waited for
// and cannot change after the report has run (#1652).
//
// CLI usage: env GITHUB_TOKEN, GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT (the
// attempt to classify; without it the latest attempt is listed), and
// optionally GITHUB_API_URL and EXCLUDE_JOBS (a regex over job names).
// Fetches the attempt's jobs, each red job's failure annotations and whether
// it has a log, prints the verdict, and appends `verdict=<v>` to
// $GITHUB_OUTPUT when set.

const fs = require("fs");

const RUNNER_LOSS_PATTERNS = [
  /lost communication with the server/i,
  /received a shutdown signal/i,
  /^\s*the operation was canceled\.?\s*$/i,
];

// The report job is part of the run it classifies and still in progress
// while it classifies, so it is never counted.
const REPORT_JOB_RE = /E2E Report/;

// The jobs the verdict is about: not the report, not an excluded job.
function isCountedJob(j, excludeRe) {
  return !REPORT_JOB_RE.test(j.name) && !(excludeRe && excludeRe.test(j.name));
}

function isRedJob(j) {
  return (j.conclusion === "failure" || j.conclusion === "cancelled") && !REPORT_JOB_RE.test(j.name);
}

function isRunnerLossMessage(message) {
  return RUNNER_LOSS_PATTERNS.some((re) => re.test(String(message || "")));
}

// A red job is a lost runner iff its failure messages (annotations, or the
// log's `##[error]` lines when there are no annotations) are non-empty and ALL
// are runner-loss wordings, or it has no such message and no log.
function isRunnerLossJob({ annotations, hasLog }) {
  if (annotations.length > 0) return annotations.every(isRunnerLossMessage);
  return !hasLog;
}

// jobs: [{ name, conclusion, annotations: string[] (failure level), hasLog: boolean }]
function classifyRunnerLoss(jobs) {
  const runnerLoss = [];
  const other = [];
  for (const j of (jobs || []).filter(isRedJob)) (isRunnerLossJob(j) ? runnerLoss : other).push(j.name);
  let verdict = "none";
  if (runnerLoss.length > 0) verdict = other.length === 0 ? "all-runner-loss" : "mixed";
  return { verdict, runnerLoss, other };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// `##[error]<message>` lines of a raw job log (each prefixed by a timestamp).
function errorLines(logText) {
  return logText
    .split("\n")
    .map((l) => l.match(/##\[error\](.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim());
}

const ghHeaders = (token) => ({ Authorization: `bearer ${token}`, Accept: "application/vnd.github+json" });

// A GET helper that throws on any non-2xx, so every read error surfaces.
function apiGetter({ token, fetchImpl = fetch }) {
  return async (url) => {
    const res = await fetchImpl(url, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  };
}

// Paginated jobs listing duplicates bulletin-deploy tools/verify-release-gate.mjs fetchAllJobs:
// those helpers are ESM (.mjs) and this script must stay a plain CommonJS file
// that workflows run with bare `node`, like classify-version-bump.cjs. Shared
// with runner-loss-watchdog.cjs.
async function listJobs({ apiUrl, repo, runId, attempt, get }) {
  const jobs = [];
  for (let page = 1; ; page++) {
    const base = attempt
      ? `${apiUrl}/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?`
      : `${apiUrl}/repos/${repo}/actions/runs/${runId}/jobs?filter=latest&`;
    const body = await get(`${base}per_page=100&page=${page}`);
    jobs.push(...body.jobs);
    if (body.jobs.length < 100) break;
  }
  return jobs;
}

async function collectJobs({ apiUrl, repo, runId, token, attempt, excludeRe, fetchImpl = fetch }) {
  const headers = ghHeaders(token);
  const get = apiGetter({ token, fetchImpl });
  const jobs = await listJobs({ apiUrl, repo, runId, attempt, get });
  const counted = jobs.filter((j) => isCountedJob(j, excludeRe));
  // A counted job without a conclusion is still queued or running: the verdict
  // could change after it is read, so refuse to give one (fail closed).
  const pending = counted.filter((j) => j.conclusion == null);
  if (pending.length > 0) throw new Error(`unknown state: ${pending.length} counted job(s) not finished (${pending.map((j) => j.name).join(", ")})`);
  const red = counted.filter(isRedJob);
  return mapLimit(red, 8, async (j) => {
    const annotations = (await get(`${apiUrl}/repos/${repo}/check-runs/${j.id}/annotations?per_page=100`))
      .filter((a) => a.annotation_level === "failure")
      .map((a) => a.message);
    // A lost runner may leave no annotation at all: the shutdown signal then
    // appears only as a `##[error]` line in the job log (run 36403307544, S9),
    // or neither annotation nor log exists. Fall back to the log in that case.
    let hasLog = true;
    if (annotations.length === 0) {
      const res = await fetchImpl(`${apiUrl}/repos/${repo}/actions/jobs/${j.id}/logs`, { headers });
      hasLog = res.ok;
      if (res.ok) annotations.push(...errorLines(await res.text()));
      else if (res.body) await res.body.cancel().catch(() => {});
    }
    return { name: j.name, conclusion: j.conclusion, annotations, hasLog };
  });
}

module.exports = { classifyRunnerLoss, isRunnerLossMessage, isRunnerLossJob, errorLines, collectJobs, listJobs, apiGetter, ghHeaders };

async function main() {
  const jobs = await collectJobs({
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    repo: process.env.GITHUB_REPOSITORY,
    runId: process.env.RUN_ID,
    attempt: process.env.RUN_ATTEMPT,
    excludeRe: process.env.EXCLUDE_JOBS ? new RegExp(process.env.EXCLUDE_JOBS) : undefined,
    token: process.env.GITHUB_TOKEN,
  });
  const result = classifyRunnerLoss(jobs);
  console.log(`runner-loss verdict=${result.verdict} (runner-loss legs: ${result.runnerLoss.length}, other red legs: ${result.other.length})`);
  for (const n of result.runnerLoss) console.log(`  runner-loss: ${n}`);
  for (const n of result.other) console.log(`  other:       ${n}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${result.verdict}\n`);
}

if (require.main === module) {
  main().catch((e) => {
    // Fail closed (#1651): an unreadable run must never look like
    // all-runner-loss, and the failed step says why the issue was filed.
    console.log(`runner-loss verdict=error (classifier error: ${e.message})`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, "verdict=error\n");
    process.exitCode = 1;
  });
}
