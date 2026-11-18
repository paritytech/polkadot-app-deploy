// DotNS.connect takes the network from one place: a stack selected by `env` or `stack`, or,
// without either, the caller's own contracts and endpoints. Mixing the two would let a caller
// point a stack's session at another chain's contracts or flip a mainnet stack to testnet.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectOptionsFromStack, DotNS } from "../dist/dotns.js";
import { GenesisMismatchError } from "../dist/genesis.js";
import { buildStack, describeStackOrigin, loadStack, readShippedStack, STACK_REQUIREMENTS } from "../dist/stacks.js";
import { NonRetryableError } from "../dist/errors.js";
import { rejectAfterTimeout, startFakeChain } from "./helpers/fake-chain.js";
import { UNREACHABLE_ENDPOINT, writeLocalStack } from "./helpers/isolated-home.js";

const OTHER_GENESIS = "0x" + "ee".repeat(32);
const MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const VALID_CONTRACTS = Object.fromEntries(STACK_REQUIREMENTS.contracts.map((name, index) =>
  [name, "0x" + (index + 1).toString(16).padStart(40, "0")]));
// preview with every chain on an unreachable local port: a connect that a guard should have
// stopped fails here instead of connecting to previewnet.
const localStackDir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-dotns-connect-"));
after(() => fs.rmSync(localStackDir, { recursive: true, force: true }));
const LOCAL_PREVIEW_FILE = writeLocalStack(localStackDir, { id: "preview" });

// A connect that a removed guard lets through goes on to read the chain and never resolves.
const connectWithin = (dotns, options, failMessage) => rejectAfterTimeout(dotns.connect(options), 10_000, failMessage);

// Connects to a fake Asset Hub on another chain: connect() applies the stack's values, then
// fails the genesis check, so the test reads the values without a live chain.
async function connectToOtherChain(options) {
  const other = await startFakeChain(OTHER_GENESIS);
  const dotns = new DotNS();
  try {
    await assert.rejects(
      () => connectWithin(dotns, { ...options, rpc: other.url, mnemonic: MNEMONIC }, ">> FAIL: DotNS.connect: connect did not stop at the Asset Hub genesis check"),
      GenesisMismatchError,
      ">> FAIL: DotNS.connect: an Asset Hub on another chain than the stack's must fail the genesis check");
  } finally {
    dotns.disconnect?.();
    await other.close();
  }
  return dotns;
}

function assertStackValues(dotns, stack, label, registerStorageDeposit) {
  assert.equal(dotns._tld, stack.tld, `>> FAIL: ${label}: the tld must come from the stack`);
  assert.equal(dotns._network, stack.network, `>> FAIL: ${label}: the network must come from the stack`);
  assert.equal(dotns._environmentId, stack.id, `>> FAIL: ${label}: the environment id must be the stack's id`);
  assert.equal(dotns._registerStorageDeposit, registerStorageDeposit, `>> FAIL: ${label}: the register deposit floor must be ${registerStorageDeposit}`);
  assert.deepEqual(dotns.assetHubEndpoints, stack.chains.AssetHub.rpc, `>> FAIL: ${label}: the Asset Hub endpoints must be the stack's`);
  assert.deepEqual(dotns._contracts, stack.contracts, `>> FAIL: ${label}: the contracts must be the stack's`);
  assert.equal(dotns._contractSource, describeStackOrigin(stack), `>> FAIL: ${label}: every contract must be attributed to the stack`);
}

// Every built-in policy's register floor equals DotNS's own default, so only floors that differ
// from it show that connect() takes them from the stack rather than keeping the default.
test("connectOptionsFromStack carries the stack's deposit floors, tld, network, contracts and id", () => {
  const stack = buildStack(readShippedStack("preview").descriptor, {
    id: "floors-0011aabb", builtIn: false, source: "file", location: "./floors.json",
    policy: { aliases: [], description: "", autoAccountMapping: true, registerStorageDeposit: 70_000_000_000, recordStorageDeposit: 30_000_000_000 },
  });
  const defaults = new DotNS();
  assert.ok(stack.registerStorageDeposit !== defaults._registerStorageDeposit && stack.recordStorageDeposit !== defaults._recordStorageDeposit,
    ">> FAIL: connect options fixture: the stack's floors must differ from DotNS's defaults, or the test cannot tell them apart");
  const options = connectOptionsFromStack(stack);
  assert.equal(options.registerStorageDeposit, 70_000_000_000n, ">> FAIL: connect options: the register deposit floor must come from the stack");
  assert.equal(options.recordStorageDeposit, 30_000_000_000n, ">> FAIL: connect options: the record deposit floor must come from the stack");
  assert.equal(options.tld, stack.tld, ">> FAIL: connect options: the tld must come from the stack");
  assert.equal(options.network, stack.network, ">> FAIL: connect options: the network must come from the stack");
  assert.deepEqual(options.contracts, stack.contracts, ">> FAIL: connect options: the contracts must be the stack's");
  assert.equal(options.environmentId, "floors-0011aabb", ">> FAIL: connect options: the environment id must be the stack's id");
  assert.deepEqual(options.assetHubEndpoints, stack.chains.AssetHub.rpc, ">> FAIL: connect options: the Asset Hub endpoints must be the stack's");
  assert.match(fs.readFileSync("src/dotns.ts", "utf8"), /stack = await loadStack\(\{ env, stack: stackSource \}\);\s*options = \{ \.\.\.connectOptions, \.\.\.connectOptionsFromStack\(stack\) \};/,
    ">> FAIL: connect options: DotNS.connect must take a loaded stack's values through connectOptionsFromStack");
});

describe("DotNS.connect with a stack selection", () => {
  test("stack: a descriptor file supplies contracts, tld, network and endpoints", async () => {
    const dotns = await connectToOtherChain({ stack: LOCAL_PREVIEW_FILE });
    // A custom stack sets no register floor, so DotNS's own default applies.
    assertStackValues(dotns, await loadStack({ stack: LOCAL_PREVIEW_FILE }), "DotNS stack file", new DotNS()._registerStorageDeposit);
  });

  test("env: a built-in stack supplies contracts, tld, network and endpoints", async () => {
    // An unreachable published descriptor makes loadStack use the shipped copy, so no network is used.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    try {
      const dotns = await connectToOtherChain({ env: "preview" });
      const stack = readShippedStack("preview");
      assert.equal(stack.registerStorageDeposit, 50_000_000_000n, ">> FAIL: DotNS env: fixture assumption broken, preview's policy must set a register floor");
      assertStackValues(dotns, stack, "DotNS env", stack.registerStorageDeposit);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  const networkOptions = {
    contracts: VALID_CONTRACTS,
    tld: "dot",
    network: "testnet",
    assetHubEndpoints: ["ws://127.0.0.1:1"],
    registerStorageDeposit: 1n,
    recordStorageDeposit: 1n,
    popSelfServe: null,
    environmentId: "preview",
    autoAccountMapping: false,
  };
  for (const [name, value] of Object.entries(networkOptions)) {
    test(`stack together with ${name} is rejected naming ${name}`, async () => {
      await assert.rejects(() => connectWithin(new DotNS(), { stack: LOCAL_PREVIEW_FILE, [name]: value }, `>> FAIL: DotNS.connect: ${name} next to a stack was not rejected`),
        (error) => error instanceof NonRetryableError && error.message.includes(name),
        `>> FAIL: DotNS.connect: ${name} next to a stack must fail naming it, since the stack is the only source of it`);
    });
  }

  test("env together with contracts is rejected naming contracts", async () => {
    // An offline fetch and an unreachable rpc: a connect the guard should have stopped goes nowhere live.
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("offline"); };
    try {
      await assert.rejects(() => connectWithin(new DotNS(), { env: "preview", contracts: VALID_CONTRACTS, rpc: UNREACHABLE_ENDPOINT }, ">> FAIL: DotNS.connect: contracts next to env was not rejected"),
        (error) => error instanceof NonRetryableError && error.message.includes("contracts"),
        ">> FAIL: DotNS.connect: contracts next to env must fail naming it, or the session mixes two networks");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  // DOTNS_RPC replaces the stack's Asset Hub endpoints, so the chain it points at must be checked too.
  test("DOTNS_RPC on another chain fails the Asset Hub genesis check, with the override's URL in the message", async () => {
    const other = await startFakeChain(OTHER_GENESIS);
    const previous = process.env.DOTNS_RPC;
    process.env.DOTNS_RPC = other.url;
    try {
      await assert.rejects(
        () => connectWithin(new DotNS(), { stack: LOCAL_PREVIEW_FILE, mnemonic: MNEMONIC }, ">> FAIL: DOTNS_RPC: connect did not stop at the Asset Hub genesis check"),
        (error) => error instanceof GenesisMismatchError
          && error.message.startsWith(`AssetHub at ${other.url} has genesis hash ${OTHER_GENESIS}`)
          && error.message.includes(`${other.url} is not one of the stack's AssetHub endpoints`),
        ">> FAIL: DOTNS_RPC: an override on another chain must fail the Asset Hub genesis check, with the override's URL in the message");
    } finally {
      if (previous === undefined) delete process.env.DOTNS_RPC;
      else process.env.DOTNS_RPC = previous;
      await other.close();
    }
  });
});

describe("DotNS.connect without a stack selection", () => {
  function withoutDotnsRpc(fn) {
    return async () => {
      const previous = process.env.DOTNS_RPC;
      delete process.env.DOTNS_RPC;
      try {
        await fn();
      } finally {
        if (previous !== undefined) process.env.DOTNS_RPC = previous;
      }
    };
  }

  test("no options fails naming env, stack and the contracts a caller can pass", withoutDotnsRpc(async () => {
    await assert.rejects(() => new DotNS().connect({}), (error) => {
      assert.ok(error instanceof NonRetryableError, ">> FAIL: DotNS.connect: a missing network must be non-retryable");
      assert.match(error.message, /needs env, stack \(a descriptor file, URL or link\), or a contracts option with /,
        `>> FAIL: DotNS.connect: the error must name the options a library caller can pass; got: ${error.message}`);
      for (const name of STACK_REQUIREMENTS.contracts) {
        assert.ok(error.message.includes(name), `>> FAIL: DotNS.connect: the error must list the required contract ${name}; got: ${error.message}`);
      }
      assert.match(error.message, /assetHubEndpoints or rpc/, `>> FAIL: DotNS.connect: the error must name the endpoint options; got: ${error.message}`);
      assert.doesNotMatch(error.message, /loadStack/, ">> FAIL: DotNS.connect: loadStack is not public, so the error must not point at it");
      return true;
    });
  }));

  test("contracts without assetHubEndpoints or rpc fails naming them", withoutDotnsRpc(async () => {
    await assert.rejects(() => new DotNS().connect({ contracts: VALID_CONTRACTS }),
      (error) => error instanceof NonRetryableError
        && /needs env, stack \(a descriptor file, URL or link\), or assetHubEndpoints or rpc/.test(error.message)
        && !/loadStack/.test(error.message),
      ">> FAIL: DotNS.connect: contracts without an endpoint must fail naming env, stack, assetHubEndpoints and rpc");
  }));

  test("a contracts option lacking a required name is rejected", async () => {
    await assert.rejects(() => connectWithin(new DotNS(), { rpc: UNREACHABLE_ENDPOINT, contracts: { DOTNS_REGISTRY: VALID_CONTRACTS.DOTNS_REGISTRY } }, ">> FAIL: DotNS contracts: an incomplete contracts map was not rejected before connecting"),
      (error) => error instanceof NonRetryableError && /DOTNS_REGISTRAR.*POP_RULES/.test(error.message),
      ">> FAIL: DotNS contracts: a map missing required keys must fail listing them, not fail later with undefined addresses");
  });

  test("a malformed address in the contracts option fails naming the contracts option", async () => {
    const contracts = { ...VALID_CONTRACTS, DOTNS_REGISTRY: "0x" + "0".repeat(40) };
    await assert.rejects(() => connectWithin(new DotNS(), { rpc: UNREACHABLE_ENDPOINT, contracts }, ">> FAIL: DotNS contracts: a malformed address was not rejected before connecting"),
      (error) => /Invalid contract address for DOTNS_REGISTRY/.test(error.message)
        && error.message.includes("the contracts option of DotNS.connect()"),
      ">> FAIL: DotNS contracts: a caller's malformed address must fail before any chain call, naming where it came from");
  });
});
