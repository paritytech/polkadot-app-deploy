// The build checks only what does not change with the date (signature, fields, policy), so a
// shipped copy going stale cannot break `npm ci`. The date check runs as its own step: an expired
// copy stops publishing and the stack update and only warns on PRs; a stale copy only warns.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
const readWorkflow = (name) => fs.readFileSync(`.github/workflows/${name}`, "utf8");
// The twin has no daily stack-update workflow; its tests run once the workflow is ported.
const hasStacksUpdate = fs.existsSync(".github/workflows/stacks-update.yml");
const currentCheck = "node scripts/check-stacks-current.mjs";

function readStep(workflow, name) {
  const step = workflow.split(/\n(?= {6}- )/).find((candidate) => candidate.includes(`- name: ${name}\n`));
  assert.ok(step, `>> FAIL: workflow: the '${name}' step is missing`);
  return step;
}

// Runs a copy of `script` next to a stand-in dist/stacks.js that re-exports the real build with
// `overrides`, so the script checks altered copies without touching .trinity/.
function runCheckScript(script, overrides, githubActions = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-stacks-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.mkdirSync(path.join(dir, "dist"));
  fs.copyFileSync(`scripts/${script}`, path.join(dir, "scripts", script));
  const realStacks = pathToFileURL(path.resolve("dist/stacks.js")).href;
  const shippedCopies = pathToFileURL(path.resolve(".trinity/index.js")).href;
  fs.writeFileSync(path.join(dir, "dist", "stacks.js"), [
    `import * as real from ${JSON.stringify(realStacks)};`,
    `import { stacks } from ${JSON.stringify(shippedCopies)};`,
    `export * from ${JSON.stringify(realStacks)};`,
    overrides,
  ].join("\n"));
  return spawnSync(process.execPath, [path.join(dir, "scripts", script)], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: githubActions } });
}

// Runs the tests.yml date-check step with `script` in place of check-stacks-current.mjs.
function runTestsYmlDateCheck(script) {
  const step = readStep(readWorkflow("tests.yml"), "Check the shipped stack copies are current");
  const shell = step.slice(step.indexOf("run: |\n") + "run: |\n".length).split("\n")
    .filter((line) => line.startsWith("          ")).map((line) => line.slice(10)).join("\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tests-yml-date-check-"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "check-stacks-current.mjs"), script);
  return spawnSync("bash", ["-e", "-c", shell], { cwd: dir, encoding: "utf8" });
}

describe("stack checks: build", () => {
  test("the build script runs the date-independent stack check", () => {
    assert.match(packageJson.scripts.build, /&& node scripts\/check-stacks\.mjs$/,
      ">> FAIL: build script: it must end by running scripts/check-stacks.mjs so a copy that does not verify fails the build");
    assert.equal(packageJson.scripts.prepare, "npm run build",
      ">> FAIL: build script: prepare must run the build, which is what npm ci runs");
  });

  test("the build check does not check dates", () => {
    const script = fs.readFileSync("scripts/check-stacks.mjs", "utf8");
    assert.match(script, /\bassertShippedStacks\(\)/, ">> FAIL: check-stacks.mjs: it must call assertShippedStacks");
    assert.doesNotMatch(script, /assertShippedStacksCurrent/,
      ">> FAIL: check-stacks.mjs: a date check in the build makes every npm ci fail once a copy is past validUntil");
  });

  test("the build check passes on the shipped copies", () => {
    const result = spawnSync(process.execPath, ["scripts/check-stacks.mjs"], { encoding: "utf8" });
    assert.equal(result.status, 0, `>> FAIL: check-stacks.mjs: it fails on the shipped copies: ${result.stderr.trim()}`);
  });

  test("the build check fails on a copy that does not verify", () => {
    // preview's payload with paseo-next-v2's signature.
    const result = runCheckScript("check-stacks.mjs", `
      const forged = { ...JSON.parse(stacks.preview.document), signature: JSON.parse(stacks["paseo-next-v2"].document).signature };
      export const assertShippedStacks = () => real.assertShippedStacks({ ...stacks, preview: { ...stacks.preview, document: JSON.stringify(forged) } });
    `);
    assert.notEqual(result.status, 0, ">> FAIL: check-stacks.mjs: a copy with a wrong signature must fail the build");
    assert.match(result.stderr, /preview/, `>> FAIL: check-stacks.mjs: the failure must name the copy: ${result.stderr.trim()}`);
  });
});

describe("stack checks: date check", () => {
  // Only the publisher can renew a copy, so a stale one must not block a release.
  test("warns on a copy past its validUntil and passes", () => {
    const staleAt2100 = `export const assertShippedStacksUnexpired = () => real.assertShippedStacksUnexpired(stacks, new Date("2100-01-01T00:00:00Z"));`;
    const local = runCheckScript("check-stacks-current.mjs", staleAt2100);
    assert.equal(local.status, 0, `>> FAIL: check-stacks-current.mjs: a stale copy must not fail the check: ${local.stderr.trim()}`);
    assert.match(local.stdout, /^warning: stack copy polkadot in \.trinity is past its validUntil/m,
      `>> FAIL: check-stacks-current.mjs: a stale copy must print a warning naming it: ${local.stdout.trim()}`);
    const actions = runCheckScript("check-stacks-current.mjs", staleAt2100, "true");
    assert.match(actions.stdout, /^::warning title=Shipped stack copy stale::stack copy polkadot in \.trinity is past its validUntil/m,
      `>> FAIL: check-stacks-current.mjs: under GitHub Actions a stale copy must print a warning annotation: ${actions.stdout.trim()}`);
  });

  test("fails on a copy past its expiresAt", () => {
    const result = runCheckScript("check-stacks-current.mjs", `
      const envelope = JSON.parse(stacks.polkadot.document);
      const payload = { ...JSON.parse(Buffer.from(envelope.payload, "base64").toString()), expiresAt: 1900000000 };
      const expired = { ...stacks, polkadot: { ...stacks.polkadot, document: JSON.stringify({ ...envelope, payload: Buffer.from(JSON.stringify(payload)).toString("base64") }) } };
      export const assertShippedStacksUnexpired = () => real.assertShippedStacksUnexpired(expired, new Date("2100-01-01T00:00:00Z"));
    `);
    assert.notEqual(result.status, 0, ">> FAIL: check-stacks-current.mjs: an expired copy must fail the check");
    assert.match(result.stderr, /polkadot: expired at/,
      `>> FAIL: check-stacks-current.mjs: the failure must name the expired copy: ${result.stderr.trim()}`);
  });
});

describe("stack checks: workflows", () => {
  test("tests.yml runs the date check after the unit tests", () => {
    const workflow = readWorkflow("tests.yml");
    assert.ok(workflow.indexOf(currentCheck) > workflow.indexOf("- run: npm test"),
      ">> FAIL: tests.yml: the date check must run after npm test builds dist/");
  });

  // A copy expires on a date, so failing here would block every PR until the refresh merges.
  test("tests.yml reports an expired copy as a warning annotation and passes", () => {
    const result = runTestsYmlDateCheck(`console.error("stack pcf-devnet: expired at 2027-01-30\\nstack polkadot: 100% stale"); process.exit(1);`);
    assert.equal(result.status, 0, `>> FAIL: tests.yml: an expired copy must not fail the job: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(),
      "::warning title=Shipped stack copy expired::stack pcf-devnet: expired at 2027-01-30%0Astack polkadot: 100%25 stale",
      ">> FAIL: tests.yml: the date check must print the whole message as one warning annotation");
  });

  test("tests.yml prints the stale-copy annotations of a passing check", () => {
    const annotation = "::warning title=Shipped stack copy stale::stack copy polkadot in .trinity is past its validUntil";
    const result = runTestsYmlDateCheck(`console.log(${JSON.stringify(annotation)});`);
    assert.equal(result.status, 0, `>> FAIL: tests.yml: a stale copy must not fail the job: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(), annotation, ">> FAIL: tests.yml: the step must print the check's warning, not swallow it");
  });

  test("publish.yml runs the date check before publishing", () => {
    const workflow = readWorkflow("publish.yml");
    const check = workflow.indexOf(currentCheck);
    // The twin hands the tarball to Parity's publish automation instead of running npm publish itself,
    // so the check must come before the dist-tag step that starts that hand-off.
    assert.ok(check > workflow.indexOf("- run: npm test") && check < workflow.indexOf("- name: Determine npm dist-tag"),
      ">> FAIL: publish.yml: an expired shipped copy must stop the release before the publish hand-off");
    assert.match(readStep(workflow, "Check the shipped stack copies are current"), /\n {8}run: node scripts\/check-stacks-current\.mjs\n/,
      ">> FAIL: publish.yml: the date check must fail the release on an expired copy, not only warn");
  });

  test("stacks-update.yml installs without lifecycle scripts and checks dates after the update", { skip: !hasStacksUpdate }, () => {
    const workflow = readWorkflow("stacks-update.yml");
    assert.match(workflow, /run: npm ci --ignore-scripts$/m,
      ">> FAIL: stacks-update.yml: npm ci runs the build, so a stale copy would block the job that replaces it");
    assert.doesNotMatch(workflow, /run: npm ci$/m, ">> FAIL: stacks-update.yml: a plain npm ci still runs the build");
    assert.ok(workflow.indexOf("npx patch-package") > workflow.indexOf("npm ci --ignore-scripts"),
      ">> FAIL: stacks-update.yml: --ignore-scripts skips the postinstall patches, so patch-package must run after it");
    const update = workflow.indexOf("npx trinity-stack update");
    const build = workflow.indexOf("npm run build");
    const check = workflow.indexOf(currentCheck);
    assert.ok(update > 0 && build > update && check > build,
      ">> FAIL: stacks-update.yml: the build and the date check must run on the updated copies, after trinity-stack update");
  });

  // The pull request opens with the default token, so CI does not run on it: these conditions
  // are the only thing that stops a copy failing the checks from getting into a pull request.
  test("stacks-update.yml opens the pull request only after the checks pass on changed copies", { skip: !hasStacksUpdate }, () => {
    const workflow = readWorkflow("stacks-update.yml");
    assert.match(readStep(workflow, "Check the stack copies"), /\n {8}id: check\n/,
      ">> FAIL: stacks-update.yml: the check step must have id: check, or steps.check.outcome is always empty");
    for (const name of ["Prepare the pull request", "Open pull request"]) {
      const condition = readStep(workflow, name).match(/\n {8}if: (.*)\n/)?.[1];
      assert.ok(condition?.includes("steps.update.outputs.changed == 'true'"),
        `>> FAIL: stacks-update.yml '${name}': it must run only when a copy changed`);
      assert.ok(condition?.includes("steps.check.outcome == 'success'"),
        `>> FAIL: stacks-update.yml '${name}': it must run only when the stack checks passed`);
    }
  });

  // Decision: the refresh runs daily with the default GITHUB_TOKEN, no personal or app token.
  test("stacks-update.yml runs daily with the default token and only the permissions its pull request takes", { skip: !hasStacksUpdate }, () => {
    const workflow = readWorkflow("stacks-update.yml");
    assert.match(workflow, /\non:\n(?: {2}.*\n)*? {2}schedule:\n {4}- cron: "[^"]+"\n/,
      ">> FAIL: stacks-update.yml: the refresh must have a schedule trigger, or copies go stale until someone runs it by hand");
    assert.doesNotMatch(workflow, /^\s*(?:github-)?token:/m,
      ">> FAIL: stacks-update.yml: no step may pass its own token; the pull request is opened with the default GITHUB_TOKEN");
    assert.doesNotMatch(workflow, /secrets\./,
      ">> FAIL: stacks-update.yml: the refresh must not read any secret");
    assert.match(workflow, /\npermissions:\n {2}contents: write\n {2}pull-requests: write\n(?! )/,
      ">> FAIL: stacks-update.yml: the default token needs exactly contents: write and pull-requests: write");
  });
});
