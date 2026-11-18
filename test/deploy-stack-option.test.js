// deploy() takes the network as `env` (a built-in id) or `stack` (a link, URL or descriptor file)
// and loads it itself, since the stack catalog is not part of the public API.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deploy } from "../dist/index.js";
import { loadStack, readShippedStack } from "../dist/stacks.js";
import { rejectAfterTimeout, startFakeChain } from "./helpers/fake-chain.js";
import { setupIsolatedHome, writeLocalStack } from "./helpers/isolated-home.js";

// deploy() records its progress in the user's state dir; the tests use a temp home.
const isolation = setupIsolatedHome();
after(() => isolation.restore());
// paseo-next-v2 on an unreachable local port: a deploy that a regressed guard lets through fails
// here instead of connecting to the live chain.
const LOCAL_STACK = writeLocalStack(isolation.tmp);

const OTHER_GENESIS = "0x" + "ab".repeat(32);
const DEV_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

describe("deploy({ stack })", () => {
  test("a descriptor file path is loaded as the run's stack", async () => {
    const chain = await startFakeChain(OTHER_GENESIS);
    const { dir, file } = writeDescriptorFile("paseo-next-v2", () => chain.url);
    try {
      // Every chain of the file points at a node with another genesis hash, so the first
      // connect fails naming the stack the file became, which shows deploy() read it.
      await assert.rejects(
        () => deploy(new Uint8Array([1]), "deploystackopt00", { stack: file, mnemonic: DEV_MNEMONIC }),
        (error) => error.name === "GenesisMismatchError" && error.message.includes("stack paseo-next-v2-") && error.message.includes(chain.url),
        ">> FAIL: deploy({ stack: file }): the deploy must load the descriptor file and connect to its chains",
      );
    } finally {
      await chain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("env and stack together are rejected", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    try {
      await assert.rejects(
        () => rejectAfterTimeout(deploy(new Uint8Array([1]), "deploystackopt00", { env: "preview", stack: LOCAL_STACK, mnemonic: DEV_MNEMONIC }), 10_000,
          "deploy() with env and stack was not rejected"),
        /--stack and --env both select the network/, ">> FAIL: deploy({ env, stack }): both selections must be refused, not one silently chosen");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("a Stack object is rejected: stack is a descriptor file, URL or link", async () => {
    const stackObject = await loadStack({ stack: LOCAL_STACK });
    await assert.rejects(
      () => rejectAfterTimeout(deploy(new Uint8Array([1]), "deploystackopt00", { stack: stackObject, mnemonic: DEV_MNEMONIC }), 10_000,
        "deploy() with a Stack object was not rejected"),
      (error) => error.name === "NonRetryableError" && /stack must be a stack descriptor file, URL or link/.test(error.message),
      ">> FAIL: deploy({ stack: <Stack object> }): a non-string stack must be refused, the library API takes only a selection string");
  });
});

/** Writes `id`'s shipped descriptor to a temp file with every chain served at `urlFor(role)`. */
function writeDescriptorFile(id, urlFor) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-deploy-stack-"));
  const file = path.join(dir, "stack.json");
  const { descriptor } = readShippedStack(id);
  fs.writeFileSync(file, JSON.stringify({ ...descriptor, chains: descriptor.chains.map((entry) => ({ ...entry, rpc: [urlFor(entry.role)] })) }));
  return { dir, file };
}

describe("deploy() banner", () => {
  // A polkadot deploy announced as a testnet deploy hides that the run spends real funds.
  test("a mainnet stack prints DEPLOYING TO MAINNET", async () => {
    const chain = await startFakeChain(OTHER_GENESIS);
    const { dir, file } = writeDescriptorFile("polkadot", () => chain.url);
    const lines = [];
    const realLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      await assert.rejects(() => deploy(new Uint8Array([1]), "deploystackopt00", { stack: file, mnemonic: DEV_MNEMONIC }));
    } finally {
      console.log = realLog;
      await chain.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.ok(lines.some((line) => line.includes("DEPLOYING TO MAINNET")), ">> FAIL: deploy banner: a polkadot stack must print DEPLOYING TO MAINNET");
    assert.ok(!lines.some((line) => line.includes("DEPLOYING TO TESTNET")), ">> FAIL: deploy banner: a polkadot stack must not print DEPLOYING TO TESTNET");
  });
});

describe("deploy({ suri }) without a login session", () => {
  // Only a session is read from People; a --suri deploy must work while People is unreachable.
  test("does not connect to People", async () => {
    const people = await startFakeChain(OTHER_GENESIS);
    const others = await startFakeChain(OTHER_GENESIS);
    const { dir, file } = writeDescriptorFile("paseo-next-v2", (role) => (role === "People" ? people.url : others.url));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-no-session-"));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await assert.rejects(() => deploy(new Uint8Array([1]), "deploystackopt00", { stack: file, suri: "//Alice" }),
        (error) => error.name === "GenesisMismatchError",
        ">> FAIL: deploy({ suri }) setup: expected the first chain connect to fail on the fake genesis hash");
      assert.equal(people.connections, 0, `>> FAIL: deploy({ suri }) without a session opened ${people.connections} People connection(s); People must only be read for a session`);
    } finally {
      process.env.HOME = savedHome;
      await people.close();
      await others.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("removed environments module", () => {
  test("the build ships no dist/environments.js and the package exports no environments path", () => {
    assert.equal(fs.existsSync("dist/environments.js"), false, ">> FAIL: dist/environments.js still exists, so the removed loader stays importable from the published package");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
    assert.ok(!Object.keys(pkg.exports).some((key) => key.includes("environments")), ">> FAIL: package.json exports still name an environments entry");
  });
});
