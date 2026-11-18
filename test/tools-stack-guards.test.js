// Tools in tools/ that write with dev keys must stop on mainnet, and every tool must report a
// stack it cannot load as a plain message. These tests spawn the tools with selections that fail
// before any network access, and read the source where a run needs a live chain.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createCliTestEnv } from "./helpers/isolated-home.js";

// The twin ships a subset of upstream's tools; a check for a tool it lacks is skipped, not dropped,
// so it runs as soon as the tool is ported.
const hasTool = (name) => fs.existsSync(`tools/${name}.mjs`);
const onlyShipped = (names) => names.filter(hasTool);

const KUSAMA_REMOVED = "environment 'kusama' has no Bulletin chain";
// Each tool runs with a temp home and every non-local connection blocked, so a regressed guard
// fails here instead of writing on a live chain.
const runNode = (args) => spawnSync(process.execPath, args, {
  encoding: "utf8", timeout: 60_000, env: createCliTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), "pad-tools-home-"))),
});

describe("tools/lib/testnet-only.mjs", () => {
  const runGuard = (stack) => runNode(["--input-type=module", "-e",
    `import { exitUnlessTestnet } from "./tools/lib/testnet-only.mjs"; exitUnlessTestnet(${JSON.stringify(stack)}); console.log("continued");`]);

  test("stops a mainnet stack before the tool writes", () => {
    const result = runGuard({ id: "polkadot", network: "mainnet" });
    assert.equal(result.status, 1, ">> FAIL: exitUnlessTestnet: a mainnet stack must exit 1");
    assert.equal(result.stderr.trim(), "not writing on mainnet stack polkadot",
      ">> FAIL: exitUnlessTestnet: the message must contain the stack id");
    assert.equal(result.stdout, "", ">> FAIL: exitUnlessTestnet: nothing after the guard may run on mainnet");
  });

  test("lets a testnet stack continue", () => {
    const result = runGuard({ id: "preview", network: "testnet" });
    assert.equal(result.status, 0, `>> FAIL: exitUnlessTestnet: a testnet stack must continue: ${result.stderr.trim()}`);
    assert.equal(result.stdout.trim(), "continued", ">> FAIL: exitUnlessTestnet: a testnet stack must continue");
  });

  // Funding, mapping, authorizing and registering run right after the stack loads.
  for (const tool of onlyShipped(["provision-pad-e2e-signers", "setup-e2e-derivation-signers", "register-test-fixture", "prove-register-then-transfer"])) {
    test(`${tool} checks the stack right after loading it`, () => {
      const source = fs.readFileSync(`tools/${tool}.mjs`, "utf8");
      assert.match(source, /= await loadStack\([^\n]*\);\n\s*exitUnlessTestnet\(stack\);\n/,
        `>> FAIL: tools/${tool}.mjs: exitUnlessTestnet(stack) must follow loadStack before any write`);
    });
  }
});

describe("tools: stack loading", () => {
  test("personhood-bootstrap reports a stack it cannot load and exits 1", { skip: !hasTool("personhood-bootstrap") }, () => {
    const result = runNode(["tools/personhood-bootstrap.mjs", "--mnemonic", "bottom drive obey lake curtain smoke basket hold race lonely fit walk", "--env", "kusama"]);
    assert.equal(result.status, 1, `>> FAIL: personhood-bootstrap: a removed env must exit 1: ${result.stderr.trim()}`);
    assert.ok(result.stderr.includes(`Bootstrap failed: ${KUSAMA_REMOVED}`),
      `>> FAIL: personhood-bootstrap: the stack-load error must be printed: ${result.stderr.trim()}`);
  });

  test("personhood-bootstrap hands the loaded stack to runBootstrap", { skip: !hasTool("personhood-bootstrap") }, () => {
    const source = fs.readFileSync("tools/personhood-bootstrap.mjs", "utf8");
    assert.match(source, /runBootstrap\(\{ mnemonic, stack \}\)/,
      ">> FAIL: personhood-bootstrap: runBootstrap reads the chains from `stack`");
    assert.match(source, /envId \?\?= stacks\.DEFAULT_STACK_ID;/,
      ">> FAIL: personhood-bootstrap: without --env it must use the default stack, not a fixed id");
  });

  test("check-pop-status reports a stack it cannot load and exits 1", { skip: !hasTool("check-pop-status") }, () => {
    const result = runNode(["tools/check-pop-status.mjs", "--env", "kusama"]);
    assert.equal(result.status, 1, `>> FAIL: check-pop-status: a removed env must exit 1: ${result.stderr.trim()}`);
    assert.ok(result.stderr.startsWith(KUSAMA_REMOVED),
      `>> FAIL: check-pop-status: the stack-load error must be printed: ${result.stderr.trim()}`);
    assert.doesNotMatch(result.stderr, /\n\s+at /, ">> FAIL: check-pop-status: the stack-load error must print without a stack trace");
  });
});

describe("tools: chain connections", () => {
  const tools = fs.readdirSync("tools").filter((name) => name.endsWith(".mjs"));

  // DotNS.connect loads the network from an env id or a stack source string, never a Stack object.
  test("no tool passes a loaded Stack object to DotNS.connect", () => {
    for (const tool of tools) {
      assert.doesNotMatch(fs.readFileSync(`tools/${tool}`, "utf8"), /\.connect\(\{\s*stack\b/,
        `>> FAIL: tools/${tool}: pass { ...stackSelectionOf(stack) } to DotNS.connect`);
    }
  });

  // These tools sign with dev keys, so they must connect only to the chains the stack lists.
  for (const tool of onlyShipped(["bulletin-auth-keepalive", "provision-pad-e2e-signers", "setup-e2e-derivation-signers", "register-test-fixture"])) {
    test(`${tool} connects through the genesis check`, () => {
      const source = fs.readFileSync(`tools/${tool}.mjs`, "utf8");
      assert.match(source, /await connectChainClient\(stack, "(Bulletin|AssetHub)"/,
        `>> FAIL: tools/${tool}.mjs: connect with connectChainClient(stack, role)`);
      assert.doesNotMatch(source, /createClient\(getWsProvider/,
        `>> FAIL: tools/${tool}.mjs: a raw client skips the genesis check`);
    });
  }
});
