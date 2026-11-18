// e2e.yml's select-env step reads the shipped stacks with inline `node -e` scripts before any
// build. These tests extract those scripts and run them in a copy of the files they may read,
// without dist/ or node_modules, so a reader that needs a build, a renamed export or a moved file
// fails here instead of on the next E2E run.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { listShippedStacks, readShippedDescriptor } from "../tools/lib/stack-copies.mjs";

const workflow = fs.readFileSync(".github/workflows/e2e.yml", "utf8");

// What the select-env job has before `npm ci`: the checkout's stack copies, policy and tools/lib.
const checkoutWithoutBuild = fs.mkdtempSync(path.join(os.tmpdir(), "bd-select-env-"));
for (const relative of [".trinity", "assets/stack-policy.json", "tools/lib"]) {
  fs.cpSync(relative, path.join(checkoutWithoutBuild, relative), { recursive: true });
}

function readInlineScript(variable) {
  const script = workflow.match(new RegExp(`${variable}=\\$\\((?:\\w+="[^"]*" )?node --input-type=module -e '([^']*)'`))?.[1];
  assert.ok(script, `>> FAIL: e2e.yml select-env: the inline ${variable} reader is missing`);
  return script;
}

function runInlineScript(script, env = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: checkoutWithoutBuild, encoding: "utf8", env: { PATH: process.env.PATH, ...env },
  });
  assert.equal(result.status, 0, `>> FAIL: e2e.yml select-env: an inline reader fails without dist/ or node_modules: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

describe("e2e.yml select-env inline readers", () => {
  test("ALL_ELIGIBLE lists the shipped stacks whose policy is e2eEligible", () => {
    const expected = listShippedStacks().filter(({ policy }) => policy.e2eEligible).map(({ id }) => id);
    assert.ok(expected.includes("paseo-next-v2"), ">> FAIL: e2e.yml select-env: fixture assumption broken, paseo-next-v2 is not e2eEligible");
    assert.deepEqual(runInlineScript(readInlineScript("ALL_ELIGIBLE")).split("\n"), expected,
      ">> FAIL: e2e.yml select-env: the probe list must be the e2eEligible shipped stacks");
  });

  test("SELECTED_TLD prints the selected stack's descriptor tld", () => {
    const script = readInlineScript("SELECTED_TLD");
    assert.equal(runInlineScript(script, { SELECTED_ENV_ID: "paseo-next-v2" }), readShippedDescriptor("paseo-next-v2").tld,
      ">> FAIL: e2e.yml select-env: selected_tld must be the descriptor tld, or E2E builds domains with the wrong suffix");
  });

  // An alias passed as primary-env must probe and select the canonical id: later steps read
  // `.trinity/<selected_env>.json`, and the probe order skips the primary by exact id.
  test("PRIMARY_ENV resolves an alias to its built-in id and leaves other values unchanged", () => {
    const script = readInlineScript("PRIMARY_ENV");
    assert.equal(runInlineScript(script, { PRIMARY_ENV: "PreviewNet" }), "preview",
      ">> FAIL: e2e.yml select-env: an alias primary-env must become the built-in id before the probe order is built");
    assert.equal(runInlineScript(script, { PRIMARY_ENV: "paseo-next-v2" }), "paseo-next-v2",
      ">> FAIL: e2e.yml select-env: a built-in id primary-env must stay unchanged");
    assert.equal(runInlineScript(script, { PRIMARY_ENV: "no-such-stack" }), "no-such-stack",
      ">> FAIL: e2e.yml select-env: an unknown primary-env must pass through so the probe reports it");
  });
});

describe("e2e.yml S-ext-signer script", () => {
  const script = workflow.match(/cat > \/tmp\/bd-s-ext\/run-s-ext\.mjs << 'SCRIPT'\n([\s\S]*?)\n\s*SCRIPT\n/)?.[1];

  // The job imitates an external library user, so it selects the network the way one would.
  test("connects DotNS by stack id on versions without loadEnvironments", () => {
    assert.ok(script, ">> FAIL: e2e.yml: the S-ext-signer script is missing");
    assert.match(script, /if \(!bulletinDeploy\.loadEnvironments\) return \{ env: envId \};/,
      ">> FAIL: e2e.yml S-ext-signer: current versions must connect DotNS with { env }");
    assert.doesNotMatch(script, /\.trinity\/|DOTNS_REGISTRAR_CONTROLLER/,
      ">> FAIL: e2e.yml S-ext-signer: the script must not read stack copies or carry its own DotNS contract list");
  });
});
