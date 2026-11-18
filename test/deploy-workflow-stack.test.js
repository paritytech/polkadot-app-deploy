// The shared deploy workflow lets a caller pick a custom stack (`stack`) or a built-in one
// (`env`). These tests read .github/workflows/deploy.yml as text and run the flag-building
// lines of its Deploying step in bash, so they check the argv the CLI actually receives.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const workflow = fs.readFileSync(".github/workflows/deploy.yml", "utf8");
const steps = workflow.split(/\n(?= {6}- )/);
const deployStep = steps.find((step) => /- name: Deploying$/m.test(step));

function readInput(name) {
  const inputs = workflow.slice(workflow.indexOf("  workflow_call:\n    inputs:\n"), workflow.indexOf("\n    outputs:"));
  return inputs.match(new RegExp(`\\n      ${name}:\\n((?: {8}.*\\n)+)`))?.[1];
}

// Runs the `--env`/`--stack` lines of the Deploying step with the passed step env and
// returns the FLAGS array they build.
function buildFlags(stepEnv) {
  const lines = deployStep.split("\n").map((line) => line.trim()).filter((line) => /FLAGS\+=\(--(env|stack) /.test(line));
  const script = `FLAGS=()\n${lines.join("\n")}\nprintf '%s\\n' "\${FLAGS[@]}"`;
  const result = spawnSync("bash", ["-c", script], { env: { PATH: process.env.PATH, ...stepEnv }, encoding: "utf8" });
  assert.equal(result.status, 0, `>> FAIL: deploy.yml flags: the flag lines do not run in bash: ${result.stderr.trim()}`);
  return result.stdout.split("\n").filter(Boolean);
}

describe("deploy.yml: stack input", () => {
  test("declares a string `stack` input defaulting to empty", () => {
    const input = readInput("stack");
    assert.ok(input, ">> FAIL: deploy.yml stack input: workflow_call.inputs has no `stack` entry, so callers cannot pass a custom stack");
    assert.match(input, /^ {8}type: string$/m, ">> FAIL: deploy.yml stack input: `stack` must be a string input");
    assert.match(input, /^ {8}default: ''$/m, ">> FAIL: deploy.yml stack input: `stack` must default to '' so a caller that omits it stays on the built-in default stack");
  });

  test("arrives in the step as an env var set from inputs.stack, not interpolated into the script", () => {
    assert.ok(deployStep, ">> FAIL: deploy.yml stack wiring: the 'Deploying' step is missing");
    assert.match(deployStep, /^ {10}STACK: \$\{\{ inputs\.stack \}\}$/m,
      ">> FAIL: deploy.yml stack wiring: the Deploying step must set STACK from inputs.stack in its env block");
    assert.match(deployStep, /^ {10}DEPLOY_ENV: \$\{\{ inputs\.env \}\}$/m,
      ">> FAIL: deploy.yml stack wiring: the Deploying step must set DEPLOY_ENV from inputs.env in its env block");
    const command = deployStep.slice(deployStep.indexOf("command: |"));
    assert.doesNotMatch(command, /inputs\.(stack|env)\b/,
      ">> FAIL: deploy.yml stack wiring: inputs.stack/inputs.env interpolated into the script text runs a quote in the value as shell");
  });

  test("passes --stack with the value as one argument, and no --env when env is empty", () => {
    assert.deepEqual(buildFlags({ STACK: "./stacks/my stack.json", DEPLOY_ENV: "" }), ["--stack", "./stacks/my stack.json"],
      ">> FAIL: deploy.yml stack wiring: a set `stack` with an empty `env` must arrive at the CLI as exactly --stack \"$STACK\"");
  });

  test("passes --env only when env is non-empty", () => {
    assert.deepEqual(buildFlags({ STACK: "", DEPLOY_ENV: "preview" }), ["--env", "preview"],
      ">> FAIL: deploy.yml env wiring: a set `env` must arrive at the CLI as --env \"$DEPLOY_ENV\"");
    assert.deepEqual(buildFlags({ STACK: "", DEPLOY_ENV: "" }), [],
      ">> FAIL: deploy.yml env wiring: with both inputs empty the CLI must get neither flag and use its default stack");
  });

  test("the built flags arrive at the polkadot-app-deploy invocation", () => {
    const invocations = deployStep.split("\n").filter((line) => line.includes('"$BULLETIN_DEPLOY_BIN"'));
    assert.ok(invocations.length > 0, ">> FAIL: deploy.yml stack wiring: no polkadot-app-deploy invocation in the Deploying step");
    for (const line of invocations) {
      assert.match(line, /"\$\{FLAGS\[@\]\}"/, `>> FAIL: deploy.yml stack wiring: an invocation drops FLAGS, so --stack never arrives at the CLI: ${line.trim()}`);
    }
  });
});

// Runs the `run: |` script of the step with this title in bash, in `cwd`, and returns the key=value
// pairs it wrote to $GITHUB_OUTPUT.
function runStep(name, stepEnv, cwd) {
  const step = steps.find((candidate) => candidate.includes(`- name: ${name}\n`));
  assert.ok(step, `>> FAIL: deploy.yml: the '${name}' step is missing`);
  const script = step.slice(step.indexOf("run: |\n") + "run: |\n".length).split("\n")
    .filter((line) => line.startsWith("          ") || line === "").map((line) => line.slice(10)).join("\n");
  const outputFile = path.join(cwd, "github-output");
  fs.writeFileSync(outputFile, "");
  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd, env: { PATH: process.env.PATH, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: path.join(cwd, "summary"), ...stepEnv }, encoding: "utf8",
  });
  assert.equal(result.status, 0, `>> FAIL: deploy.yml '${name}': the step script fails in bash: ${result.stderr.trim()}`);
  return Object.fromEntries(fs.readFileSync(outputFile, "utf8").split("\n").filter(Boolean)
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

const deployed = { CID: "bafycid", DOMAIN: "my-app", FULL_DOMAIN: "my-app.paseo", BROWSER_URL: "https://my-app.paseo.li" };
const gatewayInputs = { GATEWAY: "dot.li", PATH_STYLE: "false" };

describe("deploy.yml: deployment cache", () => {
  // A cache hit skips polkadot-app-deploy, so the domain and URL it resolved for the stack are
  // only available from what the miss stored; otherwise the summary shows a guessed TLD.
  test("a cache hit reports the fullDomain and browserUrl the original deploy resolved", () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-cache-"));
    runStep("Save deployment to cache", deployed, cacheDir);
    const hitDir = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-cache-hit-"));
    fs.cpSync(path.join(cacheDir, ".deploy-cache"), path.join(hitDir, ".deploy-cache"), { recursive: true });
    assert.deepEqual(runStep("Set deployment outputs", {}, hitDir),
      { cid: "bafycid", domain: "my-app", fullDomain: "my-app.paseo", browserUrl: "https://my-app.paseo.li" },
      ">> FAIL: deploy.yml cache hit: the outputs must be the stored cid, domain, fullDomain and browserUrl");
  });

  // The key decides whether the deploy runs at all: a hit for another stack or label would
  // skip the deploy and report the earlier target's domain and URL.
  test("the cache key covers env, stack and dotns-domain", () => {
    assert.match(workflow, /key: deploy-\$\{\{ steps\.hash\.outputs\.hash \}\}-\$\{\{ steps\.hash\.outputs\.target \}\}\n/,
      ">> FAIL: deploy.yml cache key: the key must include the deploy target");
    const hashStep = steps.find((step) => step.includes("- name: Compute build hash\n"));
    for (const [variable, input] of [["DEPLOY_ENV", "env"], ["STACK", "stack"], ["DOTNS_DOMAIN", "dotns-domain"]]) {
      assert.ok(hashStep.includes(`${variable}: \${{ inputs.${input} }}\n`),
        `>> FAIL: deploy.yml cache key: the hash step must read inputs.${input}`);
    }
    const target = (stepEnv) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hash-"));
      fs.mkdirSync(path.join(cwd, "build"));
      fs.writeFileSync(path.join(cwd, "build", "index.html"), "<html></html>");
      return runStep("Compute build hash", { BUILD_DIR: "build", DEPLOY_ENV: "", STACK: "", DOTNS_DOMAIN: "my-app", ...stepEnv }, cwd).target;
    };
    const base = target({});
    assert.equal(target({}), base, ">> FAIL: deploy.yml cache key: the same target must give the same key");
    for (const changed of [{ DEPLOY_ENV: "preview" }, { STACK: "./stack.json" }, { DOTNS_DOMAIN: "my-app-pr07" }]) {
      assert.notEqual(target(changed), base,
        `>> FAIL: deploy.yml cache key: changing ${Object.keys(changed)[0]} must change the key`);
    }
  });

  // A descriptor file can change while the build and its path stay the same; a hit would then skip
  // the deploy to the edited stack and report the old domain.
  test("the cache key covers a descriptor file's content", () => {
    const hashFor = (descriptor) => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hash-file-"));
      fs.mkdirSync(path.join(cwd, "build"));
      fs.writeFileSync(path.join(cwd, "build", "index.html"), "<html></html>");
      fs.writeFileSync(path.join(cwd, "stack.json"), descriptor);
      return runStep("Compute build hash", { BUILD_DIR: "build", DEPLOY_ENV: "", STACK: "./stack.json", DOTNS_DOMAIN: "my-app" }, cwd);
    };
    const before = hashFor('{"tld":"paseo"}');
    assert.equal(before.cacheable, "true", ">> FAIL: deploy.yml cache key: a descriptor file in the checkout must stay cacheable");
    assert.equal(hashFor('{"tld":"paseo"}').target, before.target, ">> FAIL: deploy.yml cache key: the same descriptor file must give the same key");
    assert.notEqual(hashFor('{"tld":"testnet"}').target, before.target,
      ">> FAIL: deploy.yml cache key: editing the descriptor file must change the key");
  });

  // A link or URL is fetched at deploy time, so the same string can stand for another document.
  test("a stack link or URL skips the deployment cache", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hash-url-"));
    fs.mkdirSync(path.join(cwd, "build"));
    fs.writeFileSync(path.join(cwd, "build", "index.html"), "<html></html>");
    for (const stack of ["https://example.test/stack.json", "polkadotapp://stack?url=https%3A%2F%2Fexample.test%2Fs.json"]) {
      assert.equal(runStep("Compute build hash", { BUILD_DIR: "build", DEPLOY_ENV: "", STACK: stack, DOTNS_DOMAIN: "my-app" }, cwd).cacheable, "false",
        `>> FAIL: deploy.yml cache: ${stack} must not be cached`);
    }
    assert.match(workflow, /- name: Check deployment cache\n\s+id: cache\n\s+if: inputs\.skip-cache != true && steps\.hash\.outputs\.cacheable == 'true'\n/,
      ">> FAIL: deploy.yml cache: the cache step must run only when the hash step marks the target cacheable");
  });

  test("no step falls back to a `.dot` domain", () => {
    assert.doesNotMatch(workflow, /'\{0\}\.dot'/,
      ">> FAIL: deploy.yml domain: a hardcoded .dot fallback shows the wrong TLD for every other stack");
  });
});

describe("deploy.yml: outputs", () => {
  // Callers configure apps with the full name; without it they hardcode a TLD per stack.
  test("exports full-domain from the deploy job", () => {
    const outputs = workflow.slice(workflow.indexOf("\n    outputs:\n"), workflow.indexOf("\njobs:\n"));
    assert.match(outputs, /\n      full-domain:\n {8}description: .+\n {8}value: \$\{\{ jobs\.deploy\.outputs\.full-domain \}\}\n/,
      ">> FAIL: deploy.yml outputs: workflow_call must export full-domain from the job");
    assert.match(workflow, /\n {6}full-domain: \$\{\{ steps\.final\.outputs\.fullDomain \}\}\n/,
      ">> FAIL: deploy.yml outputs: the deploy job must set full-domain from the final step");
  });
});

describe("deploy.yml: deployment summary", () => {
  const summaryStep = steps.find((step) => step.includes("- name: Deployment summary\n"));

  // Evaluates the step's FULL_DOMAIN expression the way Actions does for strings.
  function summaryHeading(outputs) {
    assert.match(summaryStep, /FULL_DOMAIN: \$\{\{ steps\.final\.outputs\.fullDomain \|\| steps\.final\.outputs\.domain \}\}\n/,
      ">> FAIL: deploy.yml summary: FULL_DOMAIN must be fullDomain, else domain");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-summary-"));
    runStep("Deployment summary", {
      DOMAIN: outputs.domain, FULL_DOMAIN: outputs.fullDomain || outputs.domain, CID: "bafycid", BROWSER_URL: "",
    }, cwd);
    return fs.readFileSync(path.join(cwd, "summary"), "utf8").split("\n")[0];
  }

  test("the heading is the full domain polkadot-app-deploy reported", () => {
    assert.equal(summaryHeading({ domain: "my-app", fullDomain: "my-app.paseo" }), "### my-app.paseo",
      ">> FAIL: deploy.yml summary: the heading must show the stack's full domain");
  });

  test("the heading falls back to the label when no full domain was reported", () => {
    assert.equal(summaryHeading({ domain: "my-app", fullDomain: "" }), "### my-app",
      ">> FAIL: deploy.yml summary: without fullDomain the heading must show the label, not a guessed TLD");
  });
});

describe("deploy.yml: browser URL", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "deploy-url-"));

  test("uses the browserUrl polkadot-app-deploy resolved", () => {
    const env = { DOMAIN: "my-app", FULL_DOMAIN: "my-app.paseo", RESOLVED_URL: "https://my-app.paseo.li/?net=x", ...gatewayInputs };
    assert.equal(runStep("Compute browser URL", env, tmp()).url, "https://my-app.paseo.li/?net=x",
      ">> FAIL: deploy.yml browser URL: the URL must be polkadot-app-deploy's browserUrl");
  });

  test("is empty for a stack that lists no web-gateway, not built from the default gateway input", () => {
    const env = { DOMAIN: "my-app", FULL_DOMAIN: "my-app.custom", RESOLVED_URL: "", ...gatewayInputs };
    assert.equal(runStep("Compute browser URL", env, tmp()).url, "",
      ">> FAIL: deploy.yml browser URL: a stack without a web-gateway must not get a dot.li URL that does not serve it");
  });

  test("falls back to the gateway inputs only without a fullDomain", () => {
    const env = { DOMAIN: "my-app", FULL_DOMAIN: "", RESOLVED_URL: "" };
    assert.equal(runStep("Compute browser URL", { ...env, ...gatewayInputs }, tmp()).url, "https://my-app.dot.li",
      ">> FAIL: deploy.yml browser URL: the subdomain fallback must be https://{label}.{gateway}");
    assert.equal(runStep("Compute browser URL", { ...env, GATEWAY: "paseo.li", PATH_STYLE: "true" }, tmp()).url, "https://paseo.li/my-app",
      ">> FAIL: deploy.yml browser URL: the path-style fallback must be https://{gateway}/{label}");
  });
});
