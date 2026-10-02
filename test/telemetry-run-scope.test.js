// #1646: the telemetry verifiers scope their Sentry query to the current CI run
// via deploy.ci_run_id. Python tests are not run by `npm test`, so spawn them here.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getDeployAttributes } from "../dist/telemetry.js";

describe("deploy.ci_run_id / deploy.ci_run_attempt seeds (#1646)", () => {
  const saved = { id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  const restore = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  afterEach(() => {
    restore("GITHUB_RUN_ID", saved.id);
    restore("GITHUB_RUN_ATTEMPT", saved.attempt);
  });

  test("returned as strings when set", () => {
    process.env.GITHUB_RUN_ID = "36333001909";
    process.env.GITHUB_RUN_ATTEMPT = "2";
    const a = getDeployAttributes("test-domain");
    assert.strictEqual(a["deploy.ci_run_id"], "36333001909");
    assert.strictEqual(a["deploy.ci_run_attempt"], "2");
  });

  test('"none" when unset (both-values rule)', () => {
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_RUN_ATTEMPT;
    const a = getDeployAttributes("test-domain");
    assert.strictEqual(a["deploy.ci_run_id"], "none");
    assert.strictEqual(a["deploy.ci_run_attempt"], "none");
  });
});

describe("telemetry verifier run scoping (#1646)", () => {
  test("python unit tests for sentry_run_scope pass", () => {
    const r = spawnSync("python3", ["tools/test_sentry_run_scope.py"], { encoding: "utf8" });
    assert.equal(r.status, 0, `>> FAIL: sentry_run_scope python tests: ${r.stdout}\n${r.stderr}`);
  });

  // The twin has no verify_nightly_telemetry.py (its telemetry-assertions job is
  // disabled in the public snapshot), so only the pool verifier is checked here.
  for (const script of ["verify_pool_distribution.py"]) {
    test(`${script} --help lists --run-id`, () => {
      const r = spawnSync("python3", [`tools/${script}`, "--help"], { encoding: "utf8" });
      assert.equal(r.status, 0, `>> FAIL: ${script} --help: ${r.stderr}`);
      assert.match(r.stdout, /--run-id/, `>> FAIL: ${script} must accept --run-id`);
    });
  }
});
