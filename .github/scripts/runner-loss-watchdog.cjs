#!/usr/bin/env node
"use strict";

// Runner-loss watchdog (#1645, #1650, #1651): did a deferred nightly failure
// issue get accounted for?
//
// nightly-report defers its failure issue on a first-attempt scheduled run
// whose every red leg is a lost runner (step "Defer the failure issue to the
// runner-loss watchdog"). cattery-scheduler[bot] re-runs red attempts within
// about 30 s, and the newer attempt's own report files the issue if the night
// is still red, because attempts >= 2 never defer. This script checks, for
// the attempt that triggered it, that the deferral was followed by a newer
// attempt. It re-runs nothing.
//
// Decisions:
//   none           the report did not defer: it filed the issue itself, or
//                  there was nothing to file
//   newer-attempt  the report deferred, and the run has a newer attempt
//                  whose own report accounts for the night
//   file           the report deferred and no newer attempt appeared within
//                  the grace period, or the report's state is unknown (job
//                  missing or not green, so it may not have accounted for the
//                  night), or anything could not be read (fail closed)
//
// CLI usage: env GITHUB_TOKEN, GITHUB_REPOSITORY, RUN_ID, RUN_ATTEMPT (the
// triggering attempt), optionally GITHUB_API_URL and GRACE_SECONDS (default
// 180). Appends decision, reason, dedup_label and title to $GITHUB_OUTPUT.
// Exits 1 after writing decision=file when anything could not be read.

const fs = require("fs");
const { listJobs, apiGetter, ghHeaders } = require("./classify-runner-loss.cjs");

const REPORT_JOB = "Nightly E2E Report";
const DEFER_STEP = "Defer the failure issue to the runner-loss watchdog";
// Printed by the defer step. The printf there keeps "runner-loss-watchdog: "
// and the key apart in the echoed script, so only the real output matches.
const MARKER_RE = /runner-loss-watchdog: (dedup_label|title)=(.*)$/;

// The report job's deferral state for one attempt: "deferred", "not-deferred"
// or "unknown" (with why).
function deferralState(jobs) {
  const reports = jobs.filter((j) => j.name === REPORT_JOB);
  if (reports.length !== 1) return { state: "unknown", why: `${reports.length} "${REPORT_JOB}" jobs in the attempt` };
  const report = reports[0];
  if (report.conclusion !== "success") return { state: "unknown", why: `the report job concluded ${report.conclusion ?? report.status}`, report };
  const step = (report.steps || []).find((s) => s.name === DEFER_STEP);
  if (!step) return { state: "unknown", why: `the report job has no "${DEFER_STEP}" step`, report };
  if (step.conclusion === "success") return { state: "deferred", report };
  // skipped: not a runner-loss night; failure: the Open failure issue step ran instead.
  if (step.conclusion === "skipped" || step.conclusion === "failure") return { state: "not-deferred", report };
  return { state: "unknown", why: `the defer step concluded ${step.conclusion}`, report };
}

// The dedup label and title the defer step printed, from the report job's log.
function parseMarkers(logText) {
  const out = {};
  for (const line of logText.split("\n")) {
    const m = line.replace(/\r$/, "").match(MARKER_RE);
    if (m && m[2] && !(m[1] in out)) out[m[1]] = m[2].trim();
  }
  return { dedupLabel: out.dedup_label || "", title: out.title || "" };
}

async function decide({ apiUrl, repo, runId, attempt, token, graceMs, fetchImpl = fetch, sleep, log = () => {} }) {
  if (!attempt) throw new Error("RUN_ATTEMPT is required: the watchdog judges the attempt that triggered it");
  const get = apiGetter({ token, fetchImpl });
  const jobs = await listJobs({ apiUrl, repo, runId, attempt, get });
  const d = deferralState(jobs);
  if (d.state === "not-deferred") return { decision: "none", reason: `attempt ${attempt}'s report did not defer its failure issue` };

  if (d.state === "unknown") log(`attempt ${attempt}'s report state is unknown (${d.why}); treating the night as unaccounted`);

  if (graceMs > 0) {
    log(`waiting ${graceMs / 1000}s for cattery-scheduler to re-run the night`);
    await sleep(graceMs);
  }
  const run = await get(`${apiUrl}/repos/${repo}/actions/runs/${runId}`);
  const latest = Number(run.run_attempt);
  if (!Number.isInteger(latest)) throw new Error(`run ${runId} has no run_attempt`);
  if (latest > Number(attempt)) {
    const actor = run.triggering_actor?.login ?? "someone";
    return { decision: "newer-attempt", reason: `attempt ${latest} exists (started by ${actor}); its own report accounts for the night` };
  }
  if (d.state !== "deferred") return { decision: "file", reason: d.why, dedupLabel: "", title: "" };
  // Only now, with an issue to file, read the label and title the defer step printed.
  const res = await fetchImpl(`${apiUrl}/repos/${repo}/actions/jobs/${d.report.id}/logs`, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GET report job log -> ${res.status}`);
  const markers = parseMarkers(await res.text());
  if (!markers.dedupLabel) log(`warning: no dedup label in attempt ${attempt}'s report log; the issue will carry none`);
  return { decision: "file", reason: "no newer attempt after the grace period", ...markers };
}

module.exports = { decide, deferralState, parseMarkers, REPORT_JOB, DEFER_STEP };

function writeOutputs(o) {
  if (!process.env.GITHUB_OUTPUT) return;
  // One line per key; values never contain newlines (titles, labels, reasons).
  const line = (k, v) => `${k}=${String(v ?? "").replace(/[\r\n]+/g, " ")}\n`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, line("decision", o.decision) + line("reason", o.reason) + line("dedup_label", o.dedupLabel) + line("title", o.title));
}

if (require.main === module) {
  const grace = process.env.GRACE_SECONDS === undefined || process.env.GRACE_SECONDS === "" ? 180 : Number(process.env.GRACE_SECONDS);
  decide({
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    repo: process.env.GITHUB_REPOSITORY,
    runId: process.env.RUN_ID,
    attempt: process.env.RUN_ATTEMPT,
    token: process.env.GITHUB_TOKEN,
    graceMs: (Number.isFinite(grace) && grace > 0 ? grace : 0) * 1000,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => console.log(m),
  })
    .then((o) => {
      console.log(`watchdog decision=${o.decision} (${o.reason})`);
      writeOutputs(o);
    })
    .catch((e) => {
      // Fail closed (#1651): a night we cannot read is filed, never dropped.
      console.log(`watchdog decision=file (watchdog error: ${e.message})`);
      writeOutputs({ decision: "file", reason: `watchdog error: ${e.message}` });
      process.exitCode = 1;
    });
}
