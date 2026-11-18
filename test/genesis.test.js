// A run must not write to a chain other than the one its stack describes: every client is
// checked against the stack's genesis hash when it connects, the failure explains why it differs,
// and nothing retries it or reports it as another problem.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { assertGenesisHash, connectChainClient, GenesisMismatchError } from "../dist/genesis.js";
import { setBulletinStack, setBulletinEndpoints, openBulletinClient, selectStorageReconnect } from "../dist/deploy.js";
import { withTransientRetry, waitForBulletinAuthorization } from "../dist/storage-signer.js";
import { withRetry } from "../dist/dotns.js";
import { readShippedStack, buildStack, customStackPolicy } from "../dist/stacks.js";
import { NonRetryableError } from "../dist/errors.js";
import { classifyDeployError, classifyErrorKind } from "../dist/telemetry.js";
import { connectPeopleClient } from "../dist/personhood/people-client.js";
import { runBootstrap } from "../dist/personhood/bootstrap.js";
import { rejectAfterTimeout, startFakeChain, waitFor, withChainEndpoint } from "./helpers/fake-chain.js";
import { createCliTestEnv, UNREACHABLE_ENDPOINT } from "./helpers/isolated-home.js";

const OTHER_GENESIS = "0x" + "ee".repeat(32);
const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

const builtIn = readShippedStack("paseo-next-v2");
const published = { ...builtIn, source: "published" };
const custom = buildStack(builtIn.descriptor, {
  id: "my-stack-0011aabb", builtIn: false, source: "file", location: "./my-stack.json", policy: customStackPolicy(builtIn.descriptor),
});

// The mismatch error assertGenesisHash throws for `stack` at `endpoint` (its own first endpoint by default).
function mismatchOf(stack, role, endpoint = stack.chains[role].rpc[0]) {
  try {
    assertGenesisHash(OTHER_GENESIS, { stack, role }, endpoint);
  } catch (error) {
    return error;
  }
  assert.fail(">> FAIL: genesis: another genesis hash must fail");
}

async function assertSocketsClosed(chain, scenario) {
  await waitFor(() => chain.openSockets === 0).catch(() =>
    assert.fail(`>> FAIL: ${scenario}: a failed client must be destroyed, but ${chain.openSockets} socket(s) to ${chain.url} stay open`));
}

describe("assertGenesisHash", () => {
  test("passes when the chain reports the stack's genesis hash, in any case", () => {
    const { genesisHash, rpc } = builtIn.chains.AssetHub;
    assertGenesisHash(genesisHash.toUpperCase().replace("0X", "0x"), { stack: builtIn, role: "AssetHub" }, rpc[0]);
  });

  test("a built-in stack's own endpoint on another chain blames a restart the published descriptor does not cover", () => {
    const endpoint = published.chains.Bulletin.rpc[0];
    const error = mismatchOf(published, "Bulletin");
    assert.ok(error instanceof GenesisMismatchError && error instanceof NonRetryableError,
      ">> FAIL: genesis built-in: a mismatch must be a non-retryable GenesisMismatchError, since a retry connects to the same chain");
    assert.ok(error.message.startsWith(`Bulletin at ${endpoint} has genesis hash ${OTHER_GENESIS}, but stack paseo-next-v2 expects ${published.chains.Bulletin.genesisHash}`),
      `>> FAIL: genesis built-in: the message must contain the endpoint and both hashes; got: ${error.message}`);
    assert.match(error.message, /the chain restarted and the published descriptor of stack paseo-next-v2 \(sequence \d+\) does not describe the new chain yet/,
      `>> FAIL: genesis built-in: the message must say the chain restarted ahead of its published descriptor; got: ${error.message}`);
    assert.match(error.message, /pass --stack/,
      `>> FAIL: genesis built-in: the message must point at --stack as the way out; got: ${error.message}`);
  });

  // The run fell back to the shipped copy, so a published descriptor of the new chain may exist.
  test("a built-in stack on its shipped copy explains that the published descriptor could not be used this run", () => {
    const { message } = mismatchOf(builtIn, "Bulletin");
    assert.ok(/used the copy of stack paseo-next-v2 shipped with polkadot-app-deploy \(sequence \d+\) because the published descriptor could not be used/.test(message)
      && !/does not describe the new chain yet/.test(message),
    `>> FAIL: genesis shipped: a run on the shipped copy must not claim the published descriptor lacks the new chain; got: ${message}`);
  });

  test("a custom stack's own endpoint on another chain blames its descriptor", () => {
    assert.match(mismatchOf(custom, "People").message, /the descriptor of stack my-stack-0011aabb describes another chain/,
      ">> FAIL: genesis custom: a custom stack's mismatch must say its descriptor describes another chain");
  });

  test("an endpoint outside the stack (an --rpc or BULLETIN_RPC override) is reported as pointing at another chain", () => {
    const { message } = mismatchOf(builtIn, "Bulletin", "wss://elsewhere.example.test");
    assert.ok(/wss:\/\/elsewhere\.example\.test is not one of the stack's Bulletin endpoints, so it points at another chain/.test(message)
      && !/chain restarted/.test(message),
    `>> FAIL: genesis override: an override endpoint on another chain must be blamed on the override, not on a restart; got: ${message}`);
  });

  // A restart the operator publishes later is the chain's; an override or a descriptor the user
  // passed is theirs to fix and must not count as an unexplained failure.
  test("each mismatch text is classified by whose endpoint or descriptor is wrong", () => {
    const cases = [
      ["published restart", mismatchOf(published, "Bulletin"), "environment"],
      ["shipped restart", mismatchOf(builtIn, "Bulletin"), "environment"],
      ["built-in passed with --stack", mismatchOf({ ...builtIn, source: "file", location: ".trinity/paseo-next-v2.json" }, "Bulletin"), "user"],
      ["custom stack", mismatchOf(custom, "People"), "user"],
      ["override endpoint", mismatchOf(builtIn, "Bulletin", "ws://127.0.0.1:9944"), "user"],
    ];
    for (const [scenario, error, category] of cases) {
      assert.equal(classifyErrorKind(error.message), "chain.genesis_mismatch", `>> FAIL: genesis classification ${scenario}: wrong kind for: ${error.message}`);
      assert.equal(classifyDeployError(error.message), category, `>> FAIL: genesis classification ${scenario}: must be ${category}: ${error.message}`);
    }
  });
});

describe("connectChainClient", () => {
  test("returns a client on the stack's chain and fails on another", async () => {
    const right = await startFakeChain(builtIn.chains.People.genesisHash);
    const wrong = await startFakeChain(OTHER_GENESIS);
    try {
      const client = await connectChainClient(withChainEndpoint(builtIn, "People", right.url), "People", [right.url]);
      client.destroy();
      await assert.rejects(
        () => connectChainClient(withChainEndpoint(builtIn, "People", wrong.url), "People", [wrong.url]),
        (error) => error instanceof GenesisMismatchError && error.message.startsWith(`People at ${wrong.url} has genesis hash ${OTHER_GENESIS}`),
        ">> FAIL: checked client: a client on another chain must fail with GenesisMismatchError naming the role and endpoint",
      );
      await assertSocketsClosed(wrong, "checked client");
    } finally {
      await right.close();
      await wrong.close();
    }
  });

  // Most callers connect to the stack's own endpoints for the role, so they pass none.
  test("connects to the stack's endpoints for the role when none are passed", async () => {
    const people = await startFakeChain(builtIn.chains.People.genesisHash);
    try {
      const client = await connectChainClient(withChainEndpoint(builtIn, "People", people.url), "People");
      client.destroy();
      assert.equal(people.genesisReads, 1, ">> FAIL: default endpoints: the client must connect to the stack's People endpoint and check its genesis hash");
    } finally {
      await people.close();
    }
  });

  // The provider moves to the next endpoint when one is down, so the error must name the
  // endpoint that answered, not the first one listed.
  test("reports the endpoint it connected to when the first one is down", async () => {
    const down = await startFakeChain(OTHER_GENESIS);
    const downUrl = down.url;
    await down.close();
    const other = await startFakeChain(OTHER_GENESIS);
    const stack = { ...builtIn, chains: { ...builtIn.chains, Bulletin: { ...builtIn.chains.Bulletin, rpc: [downUrl, other.url] } } };
    const statuses = [];
    try {
      await assert.rejects(
        () => connectChainClient(stack, "Bulletin", [downUrl, other.url], { onStatusChanged: (status) => statuses.push(status) }),
        (error) => error instanceof GenesisMismatchError
          && error.message.startsWith(`Bulletin at ${other.url} has genesis hash ${OTHER_GENESIS}`)
          && !error.message.includes(downUrl),
        ">> FAIL: connected endpoint: the mismatch must contain the endpoint the client connected to, not endpoints[0]",
      );
      assert.ok(statuses.some((status) => status.type === "CONNECTED" && status.uri === other.url),
        `>> FAIL: connected endpoint: the caller's onStatusChanged must still receive the provider's status changes; got: ${JSON.stringify(statuses)}`);
    } finally {
      await other.close();
    }
  });

  // On the session path a plain timeout is otherwise reported as an unusable slot.
  test("fails naming the role and endpoint when the chain does not report its genesis hash, and closes the socket", async () => {
    const silent = await startFakeChain(builtIn.chains.AssetHub.genesisHash, { unanswered: ["chainSpec_v1_genesisHash"] });
    try {
      await assert.rejects(
        () => rejectAfterTimeout(
          connectChainClient(withChainEndpoint(builtIn, "AssetHub", silent.url), "AssetHub", [silent.url], { genesisTimeoutMs: 300 }),
          5_000, ">> FAIL: genesis timeout: connectChainClient must fail after genesisTimeoutMs, not wait for the genesis hash forever"),
        (error) => {
          assert.equal(error.message, `AssetHub at ${silent.url} did not report its genesis hash within 300ms`,
            `>> FAIL: genesis timeout: the error must name the role, the endpoint and the timeout; got: ${error.message}`);
          assert.equal(classifyErrorKind(error.message), "chain.genesis_timeout", ">> FAIL: genesis timeout: must be classified as a genesis timeout");
          return true;
        },
      );
      assert.equal(silent.genesisReads, 1, ">> FAIL: genesis timeout: the client must have asked for the genesis hash");
      await assertSocketsClosed(silent, "genesis timeout");
    } finally {
      await silent.close();
    }
  });

  test("fails non-retryable without an endpoint", async () => {
    await assert.rejects(() => connectChainClient(builtIn, "Bulletin", []),
      (error) => error instanceof NonRetryableError && /no Bulletin endpoint/.test(error.message),
      ">> FAIL: checked client: an empty endpoint list must fail before connecting");
  });
});

describe("Bulletin clients", () => {
  // The stack's own Bulletin endpoint is unreachable, so a client that ignores the override fails
  // here instead of connecting to the live chain.
  const localBuiltIn = withChainEndpoint(builtIn, "Bulletin", UNREACHABLE_ENDPOINT);
  const previousRpc = process.env.BULLETIN_RPC;
  let other;
  beforeEach(async () => {
    delete process.env.BULLETIN_RPC;
    other = await startFakeChain(OTHER_GENESIS);
  });
  afterEach(async () => {
    if (previousRpc === undefined) delete process.env.BULLETIN_RPC;
    else process.env.BULLETIN_RPC = previousRpc;
    await other.close();
  });

  test("an --rpc override pointing at another chain fails before any store, naming the override", async () => {
    setBulletinStack(localBuiltIn, other.url);
    await assert.rejects(
      () => openBulletinClient(),
      (error) => error instanceof GenesisMismatchError && error.message.includes(`${other.url} is not one of the stack's Bulletin endpoints`),
      ">> FAIL: bulletin genesis --rpc: an override on another chain must fail before any store, naming the override",
    );
  });

  test("a BULLETIN_RPC override pointing at another chain fails the same way", async () => {
    process.env.BULLETIN_RPC = other.url;
    setBulletinStack(localBuiltIn);
    await assert.rejects(
      () => openBulletinClient(),
      (error) => error instanceof GenesisMismatchError && error.message.includes(`${other.url} is not one of the stack's Bulletin endpoints`),
      ">> FAIL: bulletin genesis BULLETIN_RPC: an env-var override on another chain must fail, naming the override",
    );
  });

  // A reconnect after a lost connection can land on another endpoint of the same list.
  test("every Bulletin client is checked, not only the first per endpoint list", async () => {
    const right = await startFakeChain(builtIn.chains.Bulletin.genesisHash);
    try {
      setBulletinStack(localBuiltIn, right.url);
      (await openBulletinClient()).destroy();
      (await openBulletinClient()).destroy();
      assert.equal(right.genesisReads, 2, ">> FAIL: bulletin genesis per client: a reconnect can land on another endpoint, so every new client must be checked");
    } finally {
      await right.close();
    }
  });

  test("no selected Bulletin chain fails non-retryable", async () => {
    setBulletinEndpoints([]);
    await assert.rejects(() => openBulletinClient(), (error) => error instanceof NonRetryableError && /no Bulletin chain selected/.test(error.message),
      ">> FAIL: bulletin selection: a client without a selected chain must fail instead of connecting nowhere");
  });

  // On a session deploy the slot signer is the first Bulletin connection; a wrong chain there is
  // not a slot problem, and "logout && login" would not fix it.
  test("a mismatch on the slot signer path is not retried and does not fall back to the pool", async () => {
    setBulletinStack(localBuiltIn, other.url);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      const reconnect = selectStorageReconnect({ storageSigner: () => {}, storageSignerAddress: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" });
      await assert.rejects(reconnect, (error) => error instanceof GenesisMismatchError,
        ">> FAIL: slot genesis: the caller must get the mismatch unchanged");
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(other.genesisReads, 1, ">> FAIL: slot genesis: a mismatch must not be retried, a retry connects to the same chain");
    assert.ok(!warnings.some((line) => /Falling back to the shared pool/.test(line)), `>> FAIL: slot genesis: a mismatch must not be reported as an unusable slot; got: ${warnings}`);
  });

  test("login polls the stack's Bulletin chain, checked against its genesis hash", async () => {
    setBulletinEndpoints([]);
    await assert.rejects(
      () => rejectAfterTimeout(
        waitForBulletinAuthorization("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", { quiet: true, stack: withChainEndpoint(builtIn, "Bulletin", other.url), timeoutMs: 3_000 }),
        10_000, ">> FAIL: login poll: the poll did not fail on the genesis check"),
      (error) => error instanceof GenesisMismatchError && error.message.startsWith(`Bulletin at ${other.url}`),
      ">> FAIL: login poll: the poll must connect to the stack's Bulletin rpc and check it",
    );
    const login = fs.readFileSync("src/commands/login.ts", "utf8");
    assert.match(login, /waitForBulletinAuthorization\(slotAddress, \{[^}]*\bstack,/,
      ">> FAIL: login poll: runLogin must pass its stack, so the poll connects to the selected stack's Bulletin chain");
  });
});

describe("personhood clients", () => {
  test("connectPeopleClient fails with the mismatch on another chain", async () => {
    const other = await startFakeChain(OTHER_GENESIS);
    try {
      await assert.rejects(() => connectPeopleClient(withChainEndpoint(builtIn, "People", other.url)),
        (error) => error instanceof GenesisMismatchError && error.message.startsWith(`People at ${other.url} has genesis hash ${OTHER_GENESIS}`),
        ">> FAIL: people client genesis: the DotNS reprove path must not read or write People on another chain");
      await assertSocketsClosed(other, "people client genesis");
    } finally {
      await other.close();
    }
  });

  // Bootstrap connects to both chains at once; the one that matched must not stay open.
  test("runBootstrap with Asset Hub on another chain fails with the mismatch and closes the People client", async () => {
    const people = await startFakeChain(builtIn.chains.People.genesisHash);
    const assetHub = await startFakeChain(OTHER_GENESIS);
    try {
      const stack = withChainEndpoint(withChainEndpoint(builtIn, "People", people.url), "AssetHub", assetHub.url);
      await assert.rejects(() => rejectAfterTimeout(runBootstrap({ mnemonic: DEV_PHRASE, stack }), 10_000, ">> FAIL: bootstrap genesis: runBootstrap did not fail on the Asset Hub genesis check"),
        (error) => error instanceof GenesisMismatchError && error.message.startsWith(`AssetHub at ${assetHub.url} has genesis hash ${OTHER_GENESIS}`),
        ">> FAIL: bootstrap genesis: Asset Hub on another chain must fail with the mismatch before any write");
      assert.equal(people.genesisReads, 1, ">> FAIL: bootstrap genesis: the People client must have connected, or this test does not show it is closed");
      await assertSocketsClosed(people, "bootstrap genesis");
    } finally {
      await people.close();
      await assetHub.close();
    }
  });
});

describe("retry wrappers", () => {
  test("withTransientRetry and withRetry rethrow a NonRetryableError on the first attempt", async () => {
    for (const retry of [(fn) => withTransientRetry(fn, { retries: 2, delayMs: 1 }), (fn) => withRetry(fn, { attempts: 3, sleep: async () => {} })]) {
      let attempts = 0;
      const mismatch = new GenesisMismatchError("Bulletin at wss://x has genesis hash 0x00");
      await assert.rejects(() => retry(async () => { attempts += 1; throw mismatch; }), (error) => error === mismatch,
        ">> FAIL: retry: the caller must get the error unchanged, not rewrapped");
      assert.equal(attempts, 1, ">> FAIL: retry: a non-retryable error must not be retried");
    }
  });
});

describe("polkadot-app-bootstrap", () => {
  test("--stack <file> --rpc <another chain> exits non-zero naming the chain", async () => {
    const other = await startFakeChain(OTHER_GENESIS);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bd-bootstrap-"));
    // The stack's own chains are unreachable; only the --rpc override is reachable, on another chain.
    const env = createCliTestEnv(home);
    let child;
    try {
      child = spawn(process.execPath, ["bin/polkadot-app-bootstrap", "--stack", env.PAD_STACK, "--rpc", other.url], { env });
      let output = "";
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      const status = await rejectAfterTimeout(new Promise((resolve) => child.on("exit", resolve)), 30_000,
        ">> FAIL: bootstrap genesis: polkadot-app-bootstrap did not exit within 30s, so it did not stop at the Bulletin genesis check");
      assert.notEqual(status, 0, `>> FAIL: bootstrap genesis: must exit non-zero; got ${status}: ${output}`);
      assert.match(output, new RegExp(`Bulletin at ${other.url} has genesis hash ${OTHER_GENESIS}`),
        `>> FAIL: bootstrap genesis: the error must contain the chain it connected to; got: ${output}`);
    } finally {
      child?.kill("SIGKILL");
      await other.close();
    }
  });
});
