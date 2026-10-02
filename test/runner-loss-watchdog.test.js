// Unit tests for .github/scripts/runner-loss-watchdog.cjs (#1645, #1650, #1651).
// The end-to-end replays of the model's traces live in test/formal-ci-runner-loss.test.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decide, deferralState, parseMarkers, REPORT_JOB, DEFER_STEP } = require("../.github/scripts/runner-loss-watchdog.cjs");

const report = (deferStep, conclusion = "success", id = 7) => ({
  id, name: REPORT_JOB, status: "completed", conclusion,
  steps: deferStep === undefined ? [] : [{ name: DEFER_STEP, conclusion: deferStep }],
});
const LOG = [
  "2026-10-02T04:01:50Z ##[group]Run printf '%s %s\\n' \"runner-loss-watchdog:\" \"dedup_label=${DEDUP_LABEL:?x}\"",
  "2026-10-02T04:01:50Z runner-loss-watchdog: dedup_label=nightly-dedup:stable:2026-10-02",
  "2026-10-02T04:01:50Z runner-loss-watchdog: title=Nightly E2E failure (@latest): 2026-10-02\r",
].join("\n");

function api({ jobs, runAttempt = 1, logStatus = 200, runStatus = 200 }) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("/attempts/")) return new Response(JSON.stringify({ jobs }), { status: 200 });
    if (url.includes("/logs")) return new Response(LOG, { status: logStatus });
    if (/\/actions\/runs\/\d+$/.test(url)) return new Response(JSON.stringify({ run_attempt: runAttempt, triggering_actor: { login: "cattery-scheduler[bot]" } }), { status: runStatus });
    return new Response("not found", { status: 404 });
  };
  return { urls, fetchImpl };
}
const run = (a, extra = {}) => {
  const slept = [];
  return decide({ apiUrl: "https://x", repo: "o/r", runId: 5, attempt: "1", token: "t", graceMs: 180000, sleep: async (ms) => slept.push(ms), fetchImpl: a.fetchImpl, ...extra })
    .then((o) => ({ ...o, slept }));
};

describe("deferralState", () => {
  test("defer step success -> deferred; skipped or failure -> not-deferred", () => {
    assert.equal(deferralState([report("success")]).state, "deferred");
    assert.equal(deferralState([report("skipped")]).state, "not-deferred");
    assert.equal(deferralState([report("failure")]).state, "not-deferred", ">> FAIL: watchdog: a failed defer step means Open failure issue ran");
  });
  test("missing report, red report, or no defer step -> unknown (fail closed)", () => {
    assert.equal(deferralState([]).state, "unknown");
    assert.equal(deferralState([report("success", "failure")]).state, "unknown");
    assert.equal(deferralState([report(undefined)]).state, "unknown");
  });
});

describe("parseMarkers", () => {
  test("reads the printed label and title, not the echoed script line", () => {
    assert.deepEqual(parseMarkers(LOG), { dedupLabel: "nightly-dedup:stable:2026-10-02", title: "Nightly E2E failure (@latest): 2026-10-02" });
    assert.deepEqual(parseMarkers("nothing here"), { dedupLabel: "", title: "" });
  });
});

describe("decide (stubbed GitHub API)", () => {
  test("not deferred: no grace wait, no run lookup", async () => {
    const a = api({ jobs: [report("skipped")] });
    const o = await run(a);
    assert.equal(o.decision, "none");
    assert.deepEqual(o.slept, [], ">> FAIL: watchdog: nothing to wait for when the report filed");
    assert.ok(!a.urls.some((u) => /\/actions\/runs\/5$/.test(u)));
  });
  test("deferred and cattery re-ran: newer-attempt, after the grace wait", async () => {
    const o = await run(api({ jobs: [report("success")], runAttempt: 2 }));
    assert.equal(o.decision, "newer-attempt");
    assert.deepEqual(o.slept, [180000], ">> FAIL: watchdog: the newer-attempt check must come after the grace period");
    assert.match(o.reason, /attempt 2 exists \(started by cattery-scheduler\[bot\]\)/);
  });
  test("deferred and nobody re-ran: file, with the report's label and title", async () => {
    const o = await run(api({ jobs: [report("success")], runAttempt: 1 }));
    assert.equal(o.decision, "file");
    assert.equal(o.dedupLabel, "nightly-dedup:stable:2026-10-02");
    assert.equal(o.title, "Nightly E2E failure (@latest): 2026-10-02");
  });
  test("unknown report state with a newer attempt: that attempt accounts", async () => {
    assert.equal((await run(api({ jobs: [], runAttempt: 2 }))).decision, "newer-attempt");
    assert.equal((await run(api({ jobs: [], runAttempt: 1 }))).decision, "file");
  });
  test("unreadable log or run: throws (the CLI files)", async () => {
    await assert.rejects(run(api({ jobs: [report("success")], logStatus: 502 })), /log -> 502/);
    await assert.rejects(run(api({ jobs: [report("success")], runStatus: 500 })), /-> 500/);
  });
  test("no attempt given: refuses to guess", async () => {
    await assert.rejects(run(api({ jobs: [] }), { attempt: "" }), /RUN_ATTEMPT is required/);
  });
});
