// Unit tests for the per-leg e2e-result.json builder and the dominant-cause
// reducer (#1625). The builder lives under .github/scripts so it survives the
// published-tier harness overlay; see docs-internal/superpowers/plans/2026-10-02-1625-e2e-result-files.md.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  extractSignature,
  classifyLeg,
  buildResult,
  normalizeJobName,
  latestPerJob,
  legCause,
  dominantCause,
  causeLabel,
  artifactName,
} from "../.github/scripts/e2e-result.mjs";

const LOST_COMM =
  "The self-hosted runner lost communication with the server. Verify the machine is running and has a healthy network connection.";

describe("extractSignature", () => {
  test("first >> FAIL: line wins, timestamp and CR stripped", () => {
    const log = [
      "2026-10-02T01:02:03.456Z noise",
      "2026-10-02T01:02:04.000Z >> FAIL: S8 deploy: connection_lost (exit 1)\r",
      ">> FAIL: a later line",
    ].join("\n");
    assert.equal(extractSignature(log), ">> FAIL: S8 deploy: connection_lost (exit 1)");
  });
  test("falls back to the Deployment failed line", () => {
    assert.equal(extractSignature("ok\nDeployment failed: Invalid: Stale\nmore"), "Deployment failed: Invalid: Stale");
  });
  test(">> FAIL: is preferred over an earlier Deployment failed line", () => {
    assert.equal(extractSignature("Deployment failed: x\n>> FAIL: y"), ">> FAIL: y");
  });
  test("empty / missing input gives an empty signature", () => {
    assert.equal(extractSignature(""), "");
    assert.equal(extractSignature(undefined), "");
    assert.equal(extractSignature("just noise"), "");
  });
  test("clips very long lines", () => {
    assert.ok(extractSignature(">> FAIL: " + "x".repeat(2000)).length <= 300);
  });
});

describe("classifyLeg", () => {
  test("exit 0 is pass", () => assert.equal(classifyLeg({ exit: 0, text: ">> FAIL: ghost" }), "pass"));
  test("runner-loss wording wins over the stderr table", () => {
    assert.equal(classifyLeg({ exit: 1, text: LOST_COMM + " Connection lost" }), "runner_loss");
  });
  test("harness guard marker is harness_leak", () => {
    assert.equal(classifyLeg({ exit: 78, text: ">> FAIL: e2e harness: process still alive 30s after the suite finished" }), "harness_leak");
  });
  test("uses classifyDeployStderr for known flakes", () => {
    assert.equal(classifyLeg({ exit: 1, text: "Error: Invalid: Stale" }), "nonce_stale");
    assert.equal(classifyLeg({ exit: 1, text: "ChainHead disjointed" }), "chainhead_disjointed");
  });
  test("unrecognised text is unknown; cancelled status is cancelled", () => {
    assert.equal(classifyLeg({ exit: 1, text: "who knows" }), "unknown");
    assert.equal(classifyLeg({ exit: 1, text: "", status: "cancelled" }), "cancelled");
  });
});

describe("buildResult", () => {
  const base = { scenario: "s8", env: "preview", signer: "direct", merkle: "js", job: "Nightly S8 (preview)", runAttempt: "2" };

  test("success leg: exit 0, class pass, all required fields present", () => {
    const r = buildResult({ ...base, status: "success" });
    assert.deepEqual(Object.keys(r).sort(), ["class", "env", "exit", "job", "merkle", "run_attempt", "scenario", "signature", "signer", "status"].sort());
    assert.equal(r.exit, 0);
    assert.equal(r.class, "pass");
    assert.equal(r.signature, "");
    assert.equal(r.run_attempt, 2);
  });
  test("failed leg from a captured log: class + signature", () => {
    const r = buildResult({ ...base, status: "failure", log: "x\n>> FAIL: S8: boom\nError: Invalid: Stale\n" });
    assert.equal(r.exit, 1);
    assert.equal(r.class, "nonce_stale");
    assert.equal(r.signature, ">> FAIL: S8: boom");
  });
  test("missing fields default to empty strings / attempt 1", () => {
    const r = buildResult({ status: "failure" });
    assert.equal(r.scenario, "");
    assert.equal(r.job, "");
    assert.equal(r.run_attempt, 1);
    assert.equal(r.class, "unknown");
    assert.equal(r.exit, 1);
  });
  test("harness file supplies class and signature when there is no log", () => {
    const harness = { exit: 1, class: "contract_revert", signature: ">> FAIL: S1: reverted", scenario: "s1", env: "x", signer: "pool", merkle: "kubo" };
    const r = buildResult({ status: "failure", harness, job: "J" });
    assert.equal(r.class, "contract_revert");
    assert.equal(r.signature, ">> FAIL: S1: reverted");
    assert.equal(r.scenario, "s1");
    assert.equal(r.merkle, "kubo");
  });
  test("job.status is authoritative: harness says pass but the job failed", () => {
    const r = buildResult({ status: "failure", harness: { exit: 0, class: "pass", signature: "" }, job: "J" });
    assert.equal(r.exit, 1);
    assert.equal(r.class, "post_suite_failure");
  });
  test("harness guard marker in the log makes it harness_leak even if the harness said pass", () => {
    const r = buildResult({ status: "failure", harness: { exit: 0, class: "pass" }, log: ">> FAIL: e2e harness: still alive" });
    assert.equal(r.class, "harness_leak");
  });
  test("job succeeded: stays pass even with a log full of expected-failure noise (S3 is a negative test)", () => {
    const r = buildResult({ ...base, status: "success", log: "Deployment failed: owned by Bob\n>> FAIL: expected" });
    assert.equal(r.class, "pass");
    assert.equal(r.exit, 0);
  });
  test("a log with garbage bytes does not throw", () => {
    assert.doesNotThrow(() => buildResult({ status: "failure", log: "\u0000\u0001 >> FAIL: x" }));
  });
});

describe("artifactName / normalizeJobName", () => {
  test("artifact names carry attempt, are unique per job name, and contain only safe characters", () => {
    const a = artifactName({ scenario: "s1", env: "preview", signer: "pool", merkle: "js", job: "Nightly S1 pool/js on parity-default (preview)", run_attempt: 1 });
    const b = artifactName({ scenario: "s1", env: "preview", signer: "pool", merkle: "js", job: "Nightly @ HEAD · s1 pool/js (preview)", run_attempt: 1 });
    const c = artifactName({ scenario: "s1", env: "preview", signer: "pool", merkle: "js", job: "Nightly S1 pool/js on parity-default (preview)", run_attempt: 2 });
    assert.match(a, /^e2e-result-[A-Za-z0-9._-]+-a1$/);
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
  test("reusable-workflow suffix is stripped, other slashes are kept", () => {
    assert.equal(normalizeJobName("Nightly S1 pool/js on parity-default (preview) / Deploy on preview"), "Nightly S1 pool/js on parity-default (preview)");
    assert.equal(normalizeJobName("Nightly S1 pool/js (preview)"), "Nightly S1 pool/js (preview)");
  });
});

describe("latestPerJob", () => {
  test("keeps only the highest run_attempt per job", () => {
    const m = latestPerJob([
      { job: "A", run_attempt: 1, class: "nonce_stale" },
      { job: "A", run_attempt: 2, class: "pass" },
      { job: "B", run_attempt: 1, class: "unknown" },
      { job: "A / Deploy on x", run_attempt: 3, class: "connection_lost" },
    ]);
    assert.equal(m.get("A").class, "connection_lost");
    assert.equal(m.get("B").class, "unknown");
    assert.equal(m.size, 2);
  });
  test("input order does not matter", () => {
    const m = latestPerJob([{ job: "A", run_attempt: 2, class: "pass" }, { job: "A", run_attempt: 1, class: "x" }]);
    assert.equal(m.get("A").class, "pass");
  });
});

describe("legCause", () => {
  test("a recorded class wins", () => assert.equal(legCause({ class: "nonce_stale" }, ""), "nonce_stale"));
  test("no result: runner-loss annotation maps to runner_loss", () => assert.equal(legCause(undefined, LOST_COMM), "runner_loss"));
  test("no result: signature text is classified", () => assert.equal(legCause(undefined, "Error: ChainHead disjointed"), "chainhead_disjointed"));
  test("no result, no signature: unknown", () => assert.equal(legCause(undefined, ""), "unknown"));
  test("an unknown/pass recorded class is refined from the signature", () => {
    assert.equal(legCause({ class: "unknown" }, "Connection lost"), "connection_lost");
    assert.equal(legCause({ class: "pass" }, "Connection lost"), "connection_lost");
  });
});

describe("dominantCause", () => {
  test("most common class wins, with counts", () => {
    assert.deepEqual(dominantCause(["a", "b", "a", "c", "a", "b"]), { class: "a", count: 3, total: 6 });
  });
  test("ties break alphabetically, deterministically", () => {
    assert.equal(dominantCause(["zeta", "alpha"]).class, "alpha");
    assert.equal(dominantCause(["alpha", "zeta"]).class, "alpha");
  });
  test("unknown loses ties to any known class", () => {
    assert.equal(dominantCause(["unknown", "zeta"]).class, "zeta");
    assert.equal(dominantCause(["unknown", "unknown", "zeta"]).class, "unknown");
  });
  test("empty input is null", () => assert.equal(dominantCause([]), null));
});

describe("causeLabel", () => {
  test("prefixes and sanitises", () => assert.equal(causeLabel("Nonce Stale!"), "nightly-cause:nonce_stale_"));
  test("never exceeds GitHub's 50-char label limit and has no commas", () => {
    const l = causeLabel("a,".repeat(60));
    assert.ok(l.length <= 50);
    assert.ok(!l.includes(","));
  });
  test("empty class becomes unknown", () => assert.equal(causeLabel(""), "nightly-cause:unknown"));
});

describe("e2e-result CLI", () => {
  const script = path.resolve(".github/scripts/e2e-result.mjs");
  const run = async (args, env) => {
    const { spawnSync } = await import("node:child_process");
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  };

  test("write: merges the harness file and the log, writes the uniquely named file and the step outputs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-result-"));
    const harnessPath = path.join(dir, "e2e-result.json");
    fs.writeFileSync(harnessPath, JSON.stringify({ exit: 1, class: "unknown", signature: "" }));
    const logPath = path.join(dir, "x.log");
    fs.writeFileSync(logPath, "stuff\n>> FAIL: S3: wrong owner\nError: Invalid: Stale\n");
    const out = path.join(dir, "out");
    const ghOut = path.join(dir, "gh-output");
    const r = await run(["write"], {
      E2E_SCENARIO: "s3", E2E_ENV: "preview", E2E_SIGNER: "", E2E_MERKLE: "js",
      E2E_JOB_NAME: "Nightly S3 owned-elsewhere (preview)", E2E_JOB_STATUS: "failure",
      E2E_LOG_PATH: logPath, E2E_RESULT_PATH: harnessPath, E2E_RESULT_OUT_DIR: out,
      GITHUB_RUN_ATTEMPT: "3", GITHUB_OUTPUT: ghOut,
    });
    assert.equal(r.status, 0, r.stderr);
    const files = fs.readdirSync(out);
    assert.equal(files.length, 1);
    assert.match(files[0], /^e2e-result-s3-preview-.*-a3\.json$/);
    const j = JSON.parse(fs.readFileSync(path.join(out, files[0]), "utf8"));
    assert.equal(j.class, "nonce_stale");
    assert.equal(j.signature, ">> FAIL: S3: wrong owner");
    assert.equal(j.run_attempt, 3);
    const outputs = fs.readFileSync(ghOut, "utf8");
    assert.match(outputs, new RegExp(`artifact=${files[0].replace(/\.json$/, "")}`));
  });

  test("write: succeeds with no log, no harness file and no status (writes a minimal failed leg)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-result-"));
    const r = await run(["write"], { E2E_RESULT_OUT_DIR: dir, E2E_JOB_NAME: "J", E2E_LOG_PATH: path.join(dir, "missing.log") });
    assert.equal(r.status, 0, r.stderr);
    const [f] = fs.readdirSync(dir);
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    assert.equal(j.class, "unknown");
  });

  test("index: latest attempt per job, normalised names, TSV of job/class/signature", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-idx-"));
    const w = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
    w("a1.json", { job: "A / Deploy on x", run_attempt: 1, class: "nonce_stale", signature: "old" });
    w("a2.json", { job: "A / Deploy on x", run_attempt: 2, class: "connection_lost", signature: ">> FAIL: new" });
    w("junk.json", "not an object");
    fs.writeFileSync(path.join(dir, "bad.json"), "{nope");
    const r = await run(["index", dir], {});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "A\tconnection_lost\t>> FAIL: new");
  });

  test("index: missing directory prints nothing and exits 0", async () => {
    const r = await run(["index", "/definitely/not/here"], {});
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });

  test("classify-text and dominant", async () => {
    const c = await run(["classify-text", LOST_COMM], {});
    assert.equal(c.stdout.trim(), "runner_loss");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-dom-"));
    const f = path.join(dir, "causes.tsv");
    fs.writeFileSync(f, "j1\tnonce_stale\nj2\tnonce_stale\nj3\tunknown\n");
    const d = await run(["dominant", f], {});
    assert.equal(d.stdout.trim(), "nonce_stale\t2\t3\tnightly-cause:nonce_stale");
    fs.writeFileSync(f, "");
    assert.equal((await run(["dominant", f], {})).stdout.trim(), "");
  });
});

describe("installE2eResultHook (harness side)", () => {
  const helper = path.resolve("test/helpers/e2e-result.js");
  const runSuite = async (body, env = {}) => {
    const { spawnSync } = await import("node:child_process");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-hook-"));
    const suite = path.join(dir, "suite.test.mjs");
    fs.writeFileSync(
      suite,
      `import { describe, test } from "node:test";
       import assert from "node:assert/strict";
       import { installE2eResultHook } from ${JSON.stringify(helper)};
       describe("e2e", () => {
         installE2eResultHook({ scenario: "s9", signer: "direct", merkle: "js", env: "preview" });
         ${body}
       });`,
    );
    const out = path.join(dir, "res", "e2e-result.json");
    const r = spawnSync(process.execPath, ["--test", suite], { encoding: "utf8", env: { PATH: process.env.PATH, E2E_RESULT_PATH: out, GITHUB_RUN_ATTEMPT: "2", ...env } });
    return { r, out, read: () => JSON.parse(fs.readFileSync(out, "utf8")) };
  };

  test("a passing suite writes exit 0 / class pass", async () => {
    const { out, read } = await runSuite(`test("ok", () => { assert.ok(true); });`);
    assert.ok(fs.existsSync(out), "result file not written");
    const j = read();
    assert.equal(j.exit, 0);
    assert.equal(j.class, "pass");
    assert.equal(j.scenario, "s9");
    assert.equal(j.run_attempt, 2);
  });

  test("a failing test writes its >> FAIL: signature and a class", async () => {
    const { read } = await runSuite(`test("bad", () => { throw new Error(">> FAIL: S9 deploy: nonce_stale (exit 1)\\n   Invalid: Stale"); });`);
    const j = read();
    assert.equal(j.exit, 1);
    assert.equal(j.signature, ">> FAIL: S9 deploy: nonce_stale (exit 1)");
    assert.equal(j.class, "nonce_stale");
  });

  test("a failure without the convention still records the first message line as the signature", async () => {
    const { read } = await runSuite(`test("bad", () => { throw new Error("plain boom"); });`);
    const j = read();
    assert.equal(j.exit, 1);
    assert.equal(j.signature, "plain boom");
  });

  test("no E2E_RESULT_PATH: writes nothing and does not break the suite", async () => {
    const { r, out } = await runSuite(`test("ok", () => {});`, { E2E_RESULT_PATH: "" });
    assert.equal(r.status, 0, r.stdout);
    assert.ok(!fs.existsSync(out));
  });
});
