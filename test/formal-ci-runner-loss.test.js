// Replays of the upstream TLA+ CI-orchestration counterexamples against the
// REAL code: the scripts under .github/scripts/ run as their CLIs, with exactly
// the env their workflow steps set, against a stubbed GitHub API; and the real
// `run:` blocks of the workflows under bash with a stub curl. Nothing touches
// the network.
//
// Twin port: same file name as upstream; its helpers live upstream under
// formal/tla-ci/replay/, which is not mirrored, so they are copied unchanged
// into test/helpers/workflow-replay/. Only the import paths differ.
//
// The fix (option D: upstream's cattery-scheduler[bot] owns re-running, and
// e2e-runner-loss-rerun.yml became a watchdog that never re-runs) is asserted
// here. Every case first asserts the workflow text that the fix introduced, so
// on the pre-fix code it fails on a real assertion, not on a missing step.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extractStep, jobNeeds, substitute, runStep, withScratch } from "./helpers/workflow-replay/workflow-step.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RR = path.join(root, ".github/workflows/e2e-runner-loss-rerun.yml");
const E2E = path.join(root, ".github/workflows/e2e.yml");
const CLASSIFIER = path.join(root, ".github/scripts/classify-runner-loss.cjs");
const WATCHDOG = path.join(root, ".github/scripts/runner-loss-watchdog.cjs");
const FETCH_STUB = path.join(root, "test/helpers/workflow-replay/fetch-stub.cjs");
const rrText = fs.readFileSync(RR, "utf8");
// The workflow without its comments, which may name what it no longer does.
const rrCode = rrText.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

const API = "https://api.github.test";
const REPO = "paritytech/polkadot-app-deploy";
const RUN_ID = "36959033277";
const LOST_COMM =
  "The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.";
const EXIT1 = "Process completed with exit code 1.";
const DEDUP = "nightly-dedup:head:2026-10-02";
const TITLE = "Nightly E2E failure (main HEAD): 2026-10-02";
const DEFER_STEP = "Defer the failure issue to the runner-loss watchdog";

// The values GitHub would substitute into the steps' ${{ }} expressions.
const EXPRS = {
  "secrets.GITHUB_TOKEN": "stub-token",
  "github.repository": REPO,
  "github.api_url": API,
  "github.server_url": "https://github.test",
  "github.run_id": "36962760557",
  "github.event.workflow_run.html_url": `https://github.test/${REPO}/actions/runs/${RUN_ID}`,
  "github.event_name": "schedule",
  "github.run_attempt": "1",
  "github.event.workflow_run.id || inputs.run_id": RUN_ID,
  "github.event.workflow_run.run_attempt || inputs.run_attempt": "1",
  "inputs.grace_seconds || '180'": "0",
  "steps.decide.outputs.dedup_label": DEDUP,
  "steps.decide.outputs.title": TITLE,
  "steps.decide.outputs.reason": "no newer attempt after the grace period",
};

const job = (id, name, status, conclusion, steps) => ({ id, name, status, conclusion, ...(steps ? { steps } : {}) });
const step = (name, conclusion) => ({ name, status: "completed", conclusion });
// Run 36959033277 (#1645): the two legs cattery-scheduler re-ran, the report,
// and one green leg standing in for the other 90 copied jobs.
const SUBDOMAIN = "Nightly @ HEAD · s-subdomain pool/js (paseo-next-v2)";
const MANIFEST = "Nightly @ HEAD · s-product-manifest direct/js (paseo-next-v2)";
const reportJob = (id, deferred) =>
  job(id, "Nightly E2E Report", "completed", "success", [
    step("Classify runner loss", "success"),
    step(DEFER_STEP, deferred ? "success" : "skipped"),
    step("Open failure issue", deferred ? "skipped" : "success"),
  ]);
const ATTEMPT1_JOBS = [
  job(101, SUBDOMAIN, "completed", "failure"),
  job(102, MANIFEST, "completed", "failure"),
  job(103, "Nightly S1 pool (paseo-next-v2)", "completed", "success"),
  reportJob(104, true),
];
// Attempt 2 as filter=latest lists it at 04:03:41Z: the re-run legs are queued.
const ATTEMPT2_INFLIGHT_JOBS = [
  job(201, SUBDOMAIN, "in_progress", null),
  job(202, MANIFEST, "in_progress", null),
  job(203, "Nightly S1 pool (paseo-next-v2)", "completed", "success"),
  job(204, "Nightly E2E Report", "queued", null),
];
const REPORT_LOG = [
  "2026-10-02T04:01:50.1Z ##[group]Run printf '%s %s\\n' \"runner-loss-watchdog:\" \"dedup_label=${DEDUP_LABEL:?Resolve step did not set DEDUP_LABEL}\"",
  `2026-10-02T04:01:50.2Z runner-loss-watchdog: dedup_label=${DEDUP}`,
  `2026-10-02T04:01:50.2Z runner-loss-watchdog: title=${TITLE}`,
].join("\n");
const lostAnnotations = (ids) => ids.map((id) => ({ match: `/check-runs/${id}/annotations`, json: [{ annotation_level: "failure", message: LOST_COMM }] }));
const attemptJobs = (n, jobs) => ({ match: `/runs/${RUN_ID}/attempts/${n}/jobs?`, json: { jobs } });
const latestJobs = (jobs) => ({ match: `/runs/${RUN_ID}/jobs?filter=latest&`, json: { jobs } });
const runInfo = (attempt) => ({ match: `/actions/runs/${RUN_ID}`, json: { id: Number(RUN_ID), run_attempt: attempt, triggering_actor: { login: "cattery-scheduler[bot]" } } });
const reportLog = (id) => ({ match: `/actions/jobs/${id}/logs`, text: REPORT_LOG });

// Runs a real .github/scripts CLI with the env a workflow step gives it.
function cli(script, { stepEnv, routes, extraEnv = {} }) {
  return withScratch("formal-ci-cli-", (dir) => {
    const routesFile = path.join(dir, "routes.json");
    const log = path.join(dir, "urls.log");
    const output = path.join(dir, "github_output");
    fs.writeFileSync(routesFile, JSON.stringify(routes));
    fs.writeFileSync(log, "");
    fs.writeFileSync(output, "");
    const env = { PATH: process.env.PATH, STUB_ROUTES: routesFile, STUB_LOG: log, GITHUB_OUTPUT: output };
    for (const [k, v] of Object.entries(stepEnv)) env[k] = substitute(v, EXPRS);
    Object.assign(env, extraEnv);
    const r = spawnSync(process.execPath, ["-r", FETCH_STUB, script], { env, encoding: "utf8" });
    const out = fs.readFileSync(output, "utf8");
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      urls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
      output: out,
      outputs: Object.fromEntries(out.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
    };
  });
}

const reportClassify = extractStep(E2E, "Classify runner loss");
const reportDefer = () => extractStep(E2E, DEFER_STEP);
const reportOpenIssue = extractStep(E2E, "Open failure issue");
const classify = (opts) => cli(CLASSIFIER, opts);
// The watchdog's steps: RUN_ID / RUN_ATTEMPT are JOB-level env, so a step's env is job env + step env.
const wdDecide = () => extractStep(RR, "Check whether the night is accounted");
const wdEnv = () => { const s = wdDecide(); return { ...s.jobEnv, ...s.env }; };
const wdFile = () => extractStep(RR, "File the deferred failure issue");
const watchdog = (opts) => cli(WATCHDOG, { stepEnv: wdEnv(), ...opts });

describe("formal-ci replay: #1645 calibration (VerdictFromTriggeringAttempt)", () => {
  test("the watchdog reads the attempt that triggered it, not the latest attempt", () => {
    assert.match(rrText, /RUN_ATTEMPT: \$\{\{ github\.event\.workflow_run\.run_attempt \|\| inputs\.run_attempt \}\}/,
      ">> FAIL: #1645: the watchdog must pin RUN_ATTEMPT to github.event.workflow_run.run_attempt");
    // Same API state as run 36962760557 saw: filter=latest is attempt 2 in flight; attempt 1 deferred its issue.
    const routes = [latestJobs(ATTEMPT2_INFLIGHT_JOBS), attemptJobs(1, ATTEMPT1_JOBS), reportLog(104), runInfo(1)];
    const r = watchdog({ routes });
    assert.equal(r.status, 0, `>> FAIL: #1645: watchdog exited ${r.status}: ${r.stdout}${r.stderr}`);
    assert.ok(r.urls.some((u) => u.includes(`/runs/${RUN_ID}/attempts/1/jobs?`)), ">> FAIL: #1645: the watchdog must list /attempts/1/jobs");
    assert.ok(!r.urls.some((u) => u.includes("filter=latest")), ">> FAIL: #1645: the watchdog must never list filter=latest");
    assert.equal(r.outputs.decision, "file", ">> FAIL: #1645: attempt 1 deferred and nobody re-ran: the watchdog must file");
    assert.equal(r.outputs.dedup_label, DEDUP, ">> FAIL: #1645: the dedup label must come from attempt 1's report");
  });

  test("nightly-report's in-run classifier pins its own attempt", () => {
    assert.equal(reportClassify.env.RUN_ATTEMPT, "${{ github.run_attempt }}", ">> FAIL: #1645 item 1: nightly-report must pass RUN_ATTEMPT");
    const r = classify({
      stepEnv: reportClassify.env,
      // filter=latest deliberately disagrees, so only the pinned listing yields all-runner-loss.
      routes: [latestJobs(ATTEMPT2_INFLIGHT_JOBS), attemptJobs(1, ATTEMPT1_JOBS), ...lostAnnotations([101, 102])],
      extraEnv: { RUN_ID },
    });
    assert.ok(r.urls.some((u) => u.includes(`/attempts/1/jobs?`)), ">> FAIL: #1645 item 1: in-run classifier must list /attempts/1/jobs");
    assert.ok(!r.urls.some((u) => u.includes("filter=latest")), ">> FAIL: #1645 item 1: in-run classifier must not list filter=latest");
    assert.equal(r.output, "verdict=all-runner-loss\n", ">> FAIL: #1645 item 1: in-run verdict for attempt 1");
  });
});

describe("formal-ci replay: FV-B-1 / #1650 a re-run by someone else never files a spurious issue (NoSpuriousIssue)", () => {
  test("cattery re-ran the night: the watchdog files nothing, and there is no re-run POST to be refused", () => {
    assert.doesNotMatch(rrCode, /rerun-failed-jobs/, ">> FAIL: #1650: the watchdog must not POST rerun-failed-jobs (cattery owns re-running)");
    // TLC trace Pinned-NoSpuriousIssue: attempt 1 deferred, BotRerun, then our workflow looks.
    const r = watchdog({ routes: [attemptJobs(1, ATTEMPT1_JOBS), reportLog(104), runInfo(2)] });
    assert.equal(r.status, 0, `>> FAIL: #1650: watchdog exited ${r.status}: ${r.stdout}${r.stderr}`);
    assert.equal(r.outputs.decision, "newer-attempt", ">> FAIL: #1650: a newer attempt exists, its own report accounts for the night");
    assert.match(r.stdout, /attempt 2 exists/, ">> FAIL: #1650: the watchdog should log which attempt took over");
    assert.ok(!r.urls.some((u) => u.includes("/rerun")), ">> FAIL: #1650: no re-run request of any kind");
    const file = wdFile();
    assert.match(file.if, /steps\.decide\.outputs\.decision == 'file'/, ">> FAIL: #1650: the filing step must be gated on decision == 'file'");
  });

  test("nobody re-ran: the watchdog's issue carries the night's dedup label, so 'Re-run passed' and later attempts find it", () => {
    const f = runStep(wdFile(), {
      exprs: EXPRS,
      rules: [
        { method: "GET", match: `/repos/${REPO}/issues?`, status: 200, body: "[]" },
        { method: "POST", match: `/repos/${REPO}/labels`, status: 201, body: "{}" },
        { method: "POST", match: `/repos/${REPO}/issues`, status: 201, body: '{"number":7}' },
      ],
    });
    assert.equal(f.status, 0, `>> FAIL: #1650: filing step exited ${f.status}: ${f.stderr.split("\n").find((l) => l.trim()) ?? ""}`);
    const lookup = f.calls.find((c) => c.method === "GET");
    assert.ok(lookup && decodeURIComponent(lookup.url).includes(`labels=${DEDUP}`), ">> FAIL: #1650: the watchdog must look the dedup label up first");
    const issue = f.calls.find((c) => c.method === "POST" && c.url.endsWith(`/repos/${REPO}/issues`));
    assert.ok(issue, ">> FAIL: #1650: expected the watchdog to file the issue");
    const payload = JSON.parse(issue.data);
    assert.deepEqual(payload.labels, [DEDUP], ">> FAIL: #1650: the issue must carry the nightly-dedup label");
    assert.equal(payload.title, TITLE, ">> FAIL: #1650: the issue must reuse nightly-report's title");
  });

  test("an open issue already carries the label: the watchdog comments instead of duplicating", () => {
    const f = runStep(wdFile(), {
      exprs: EXPRS,
      rules: [
        { method: "GET", match: `/repos/${REPO}/issues?`, status: 200, body: '[{"number":42}]' },
        { method: "POST", match: `/issues/42/comments`, status: 201, body: "{}" },
      ],
    });
    assert.equal(f.status, 0, `>> FAIL: #1650: filing step exited ${f.status}`);
    assert.ok(f.calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/42/comments")), ">> FAIL: #1650: expected a comment on #42");
    assert.ok(!f.calls.some((c) => c.method === "POST" && c.url.endsWith(`/repos/${REPO}/issues`)), ">> FAIL: #1650: no second issue");
  });
});

describe("formal-ci replay: FV-B-2 / #1651 an unreadable run fails closed (EveryRedNightAccounted)", () => {
  test("jobs API 502 in the watchdog: decision=file and the step fails, so the filing step runs", () => {
    assert.match(wdFile().if, /steps\.decide\.outcome == 'failure'/, ">> FAIL: #1651: a failed decision step must still file");
    const r = watchdog({ routes: [{ match: "/attempts/1/jobs", status: 502, text: "bad gateway" }] });
    assert.notEqual(r.status, 0, ">> FAIL: #1651: a watchdog read error must fail its step");
    assert.equal(r.outputs.decision, "file", ">> FAIL: #1651: a watchdog read error must decide 'file'");
    assert.match(r.stdout, /502/, ">> FAIL: #1651: the error must be logged");
  });

  test("annotations API 502 in nightly-report: verdict=error, never all-runner-loss, so the issue is not deferred", () => {
    const r = classify({
      stepEnv: reportClassify.env,
      routes: [attemptJobs(1, ATTEMPT1_JOBS), { match: "/check-runs/", status: 502, text: "bad gateway" }],
      extraEnv: { RUN_ID },
    });
    assert.notEqual(r.status, 0, ">> FAIL: #1651: a classifier error must fail its step");
    assert.match(r.stdout, /runner-loss verdict=error \(classifier error: GET .* -> 502\)/, ">> FAIL: #1651: expected the fail-closed verdict line");
    assert.equal(r.output, "verdict=error\n", ">> FAIL: #1651: GITHUB_OUTPUT must carry verdict=error");
    assert.match(reportDefer().if, /steps\.runner-loss\.outputs\.verdict == 'all-runner-loss'/, ">> FAIL: #1651: deferral must require all-runner-loss exactly");
  });

  test("the report job itself is unaccounted (lost runner): the watchdog treats it as unknown and files", () => {
    const lostReport = [job(101, SUBDOMAIN, "completed", "failure"), job(104, "Nightly E2E Report", "completed", "failure", [])];
    const r = watchdog({ routes: [attemptJobs(1, lostReport), runInfo(1)] });
    assert.equal(r.outputs.decision, "file", ">> FAIL: #1651: an unaccounted report must file");
    assert.equal(r.outputs.dedup_label ?? "", "", ">> FAIL: #1651: no marker, so no dedup label is invented");
  });

  test("the report filed its own issue: the watchdog does nothing", () => {
    const r = watchdog({ routes: [attemptJobs(1, [job(101, SUBDOMAIN, "completed", "failure"), reportJob(104, false)]), runInfo(1)] });
    assert.equal(r.status, 0);
    assert.equal(r.outputs.decision, "none", ">> FAIL: #1651: not deferred means accounted by nightly-report");
    assert.ok(!r.urls.some((u) => u.endsWith(`/actions/runs/${RUN_ID}`)), ">> FAIL: no grace/newer-attempt check needed when nothing was deferred");
  });
});

describe("formal-ci replay: FV-B-3 / #1652 the in-run verdict counts only nightly-report's needs (EveryRedNightAccounted)", () => {
  test("a still-queued DotNS-drift job is outside needs: excluded at report time and after, so the verdict cannot flip", () => {
    const needs = jobNeeds(E2E, "nightly-report");
    for (const j of ["nightly-dotns-address-drift", "nightly-chain-identity"]) {
      assert.equal(needs.includes(j), false, `>> FAIL: #1652 replay: ${j} is now in nightly-report needs; re-derive this replay`);
    }
    assert.ok(reportClassify.env.EXCLUDE_JOBS, ">> FAIL: #1652: nightly-report must pass EXCLUDE_JOBS (the jobs outside its needs)");
    const DRIFT = "Nightly · DotNS address drift";
    const atReport = [job(101, SUBDOMAIN, "completed", "failure"), job(105, DRIFT, "queued", null), job(104, "Nightly E2E Report", "in_progress", null)];
    const afterRun = [job(101, SUBDOMAIN, "completed", "failure"), job(105, DRIFT, "completed", "failure"), job(104, "Nightly E2E Report", "completed", "success")];
    const routesFor = (jobs) => [
      attemptJobs(1, jobs),
      ...lostAnnotations([101]),
      { match: "/check-runs/105/annotations", json: [{ annotation_level: "failure", message: EXIT1 }] },
    ];
    const inRun = classify({ stepEnv: reportClassify.env, routes: routesFor(atReport), extraEnv: { RUN_ID } });
    assert.equal(inRun.output, "verdict=all-runner-loss\n", ">> FAIL: #1652: report-time verdict");
    const postRun = classify({ stepEnv: reportClassify.env, routes: routesFor(afterRun), extraEnv: { RUN_ID } });
    assert.equal(postRun.output, "verdict=all-runner-loss\n", ">> FAIL: #1652: the same job set after the run gives the same verdict");
    assert.ok(!postRun.urls.some((u) => u.includes("/check-runs/105/")), ">> FAIL: #1652: the excluded job must not even be read");
  });

  test("a job inside needs with no conclusion is an unknown state: verdict=error, not a skip", () => {
    const r = classify({
      stepEnv: reportClassify.env,
      routes: [attemptJobs(1, [job(101, SUBDOMAIN, "completed", "failure"), job(106, "Nightly S8 WS fault injection (previewnet)", "in_progress", null)]), ...lostAnnotations([101])],
      extraEnv: { RUN_ID },
    });
    assert.equal(r.output, "verdict=error\n", ">> FAIL: #1652: an unfinished counted job must fail closed");
  });
});

describe("formal-ci replay: #1645 item 2 nothing of ours re-runs a night (NoDoubleRerun)", () => {
  test("cattery's attempt 2 also went red: the watchdog neither re-runs nor files, attempt 2's report accounts", () => {
    assert.match(rrCode, /actions: read/, ">> FAIL: #1645 item 2: the watchdog needs actions: read only");
    assert.doesNotMatch(rrCode, /actions: write/, ">> FAIL: #1645 item 2: the watchdog must not hold actions: write");
    const r = watchdog({ routes: [attemptJobs(1, ATTEMPT1_JOBS), reportLog(104), runInfo(2)] });
    assert.equal(r.outputs.decision, "newer-attempt", ">> FAIL: #1645 item 2: attempt 2 exists");
    // The fetch stub serves GETs only; every URL the watchdog asked for is a read.
    assert.ok(r.urls.every((u) => !/rerun|cancel|dispatches/.test(u)), ">> FAIL: #1645 item 2: no state-changing Actions call");
  });
});
