import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classifyRunnerLoss, isRunnerLossMessage, errorLines, collectJobs } = require("../.github/scripts/classify-runner-loss.cjs");

// Real annotation texts from parity-default runner losses (bulletin #1622).
const LOST_COMM =
  "The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.";
const SHUTDOWN = "The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.";
const CANCELED = "The operation was canceled.";
const EXIT1 = "Process completed with exit code 1.";

const job = (name, conclusion, annotations = [], hasLog = true) => ({ name, conclusion, annotations, hasLog });

describe("isRunnerLossMessage", () => {
  test("matches the three runner-loss wordings", () => {
    for (const m of [LOST_COMM, SHUTDOWN, CANCELED]) assert.equal(isRunnerLossMessage(m), true, m);
  });
  test("does not match ordinary failures or timeouts", () => {
    assert.equal(isRunnerLossMessage(EXIT1), false);
    assert.equal(isRunnerLossMessage("The job running on runner parity-default has exceeded the maximum execution time of 35 minutes."), false);
  });
});

describe("classifyRunnerLoss", () => {
  test("all-runner-loss: every red job is a lost runner (annotation or no log)", () => {
    const r = classifyRunnerLoss([
      job("Nightly S1 (preview)", "failure", [LOST_COMM]),
      job("Nightly S8 (preview)", "cancelled", [SHUTDOWN]),
      job("Nightly S5 (preview)", "failure", [CANCELED]),
      job("Nightly S6 (preview)", "failure", [], false),
      job("Nightly S3", "success"),
      job("Nightly S9", "skipped"),
    ]);
    assert.equal(r.verdict, "all-runner-loss", ">> FAIL: classifier: all runner-loss legs must yield all-runner-loss");
    assert.equal(r.runnerLoss.length, 4);
    assert.deepEqual(r.other, []);
  });

  test("mixed: one real failure among runner losses", () => {
    const r = classifyRunnerLoss([
      job("Nightly S1", "failure", [LOST_COMM]),
      job("Nightly S2", "failure", [EXIT1]),
    ]);
    assert.equal(r.verdict, "mixed");
    assert.deepEqual(r.runnerLoss, ["Nightly S1"]);
    assert.deepEqual(r.other, ["Nightly S2"]);
  });

  test("none: red jobs but no runner loss, or no red jobs at all", () => {
    assert.equal(classifyRunnerLoss([job("a", "failure", [EXIT1])]).verdict, "none");
    assert.equal(classifyRunnerLoss([job("a", "success"), job("b", "skipped")]).verdict, "none");
    assert.equal(classifyRunnerLoss([]).verdict, "none");
  });

  test("a job with a log and no annotation is a real failure, not runner loss", () => {
    assert.equal(classifyRunnerLoss([job("a", "failure", [], true)]).verdict, "none");
  });

  test("a no-log job carrying an unrecognised failure annotation is not runner loss", () => {
    assert.equal(classifyRunnerLoss([job("a", "failure", [EXIT1], false)]).verdict, "none");
  });

  test("a runner-loss annotation alongside a real failure annotation is not runner loss", () => {
    assert.equal(classifyRunnerLoss([job("a", "failure", [EXIT1, SHUTDOWN])]).verdict, "none");
  });

  test("the report job itself is ignored (in progress in nightly-report, finished in the rerun workflow)", () => {
    const r = classifyRunnerLoss([
      job("Nightly S1", "failure", [LOST_COMM]),
      job("Nightly E2E Report", "failure", [EXIT1]),
    ]);
    assert.equal(r.verdict, "all-runner-loss");
  });
});

describe("collectJobs (stubbed GitHub API)", () => {
  const ts = "2026-09-28T09:39:10.5386636Z";
  // S9 of run 36403307544: no check-run annotation, shutdown signal only in the log.
  const S9_LOG = `${ts} Download action repository 'actions/checkout@v6'\n${ts} ##[error]${SHUTDOWN}\n${ts} Cleaning up orphan processes\n`;

  function stubFetch(routes) {
    return async (url) => {
      for (const [frag, make] of routes) if (url.includes(frag)) return make();
      throw new Error(`unrouted ${url}`);
    };
  }
  const json = (body) => () => ({ ok: true, status: 200, json: async () => body });
  const text = (body) => () => ({ ok: true, status: 200, text: async () => body });
  const notFound = () => ({ ok: false, status: 404, body: null });

  test("errorLines pulls ##[error] messages out of a timestamped log", () => {
    assert.deepEqual(errorLines(S9_LOG), [SHUTDOWN]);
  });

  test("annotation-less job whose log only shows a shutdown signal is runner loss", async () => {
    const fetchImpl = stubFetch([
      ["/jobs?", json({ jobs: [{ id: 1, name: "Nightly S9", conclusion: "failure" }, { id: 2, name: "Nightly S1", conclusion: "success" }] })],
      ["/check-runs/1/annotations", json([])],
      ["/actions/jobs/1/logs", text(S9_LOG)],
    ]);
    const jobs = await collectJobs({ apiUrl: "https://x", repo: "o/r", runId: 9, token: "t", fetchImpl });
    assert.equal(classifyRunnerLoss(jobs).verdict, "all-runner-loss");
  });

  test("failure annotation wins; log is not fetched (real check-run 110599161716 wording)", async () => {
    const fetchImpl = stubFetch([
      ["/jobs?", json({ jobs: [{ id: 3, name: "Nightly s-transfer", conclusion: "failure" }] })],
      ["/check-runs/3/annotations", json([{ annotation_level: "failure", message: LOST_COMM }, { annotation_level: "notice", message: "x" }])],
    ]);
    const jobs = await collectJobs({ apiUrl: "https://x", repo: "o/r", runId: 9, token: "t", fetchImpl });
    assert.deepEqual(jobs[0].annotations, [LOST_COMM]);
    assert.equal(classifyRunnerLoss(jobs).verdict, "all-runner-loss");
  });

  test("no annotation and a 404 log (BlobNotFound) is runner loss; a normal failing log is not", async () => {
    const fetchImpl = stubFetch([
      ["/jobs?", json({ jobs: [{ id: 4, name: "A", conclusion: "failure" }, { id: 5, name: "B", conclusion: "failure" }] })],
      ["/annotations", json([])],
      ["/actions/jobs/4/logs", notFound],
      ["/actions/jobs/5/logs", text(`${ts} ##[error]${EXIT1}\n`)],
    ]);
    const jobs = await collectJobs({ apiUrl: "https://x", repo: "o/r", runId: 9, token: "t", fetchImpl });
    const r = classifyRunnerLoss(jobs);
    assert.equal(r.verdict, "mixed");
    assert.deepEqual(r.runnerLoss, ["A"]);
  });
});
