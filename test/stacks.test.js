// Network selection from Trinity stack descriptors (src/stacks.ts). No test here uses the
// network: published descriptors come from an injected or stubbed `fetch`, built-in copies from
// an injected `shipped` map signed with a test key, and values the built-in stacks pin are read
// from the shipped copies so a refresh of .trinity/ does not break them.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { generateSecret, publicKey, publish, encodeLink } from "@parity/trinity-stack";
import { domainUrlsFor } from "../dist/deploy.js";
import { createCliTestEnv, writeLocalStack } from "./helpers/isolated-home.js";
import {
  loadStack,
  loadStackSource,
  readShippedStack,
  listStacks,
  formatStackTable,
  findBuiltInStackId,
  resolveStackSelection,
  stackSelectionFlag,
  describeStackOrigin,
  buildStack,
  customStackPolicy,
  assertShippedStacks,
  assertShippedStacksUnexpired,
  stackSelectionOf,
  BUILT_IN_STACK_IDS,
  DEFAULT_STACK_ID,
  DOTNS_CONTRACT_KEYS,
  MAINNET_GENESIS,
  RETIRED_SELECTION_ERRORS,
} from "../dist/stacks.js";
import { stacks as realCopies } from "../.trinity/index.js";
import * as publicApi from "../dist/index.js";
import { NonRetryableError } from "../dist/errors.js";
import { isValidContractAddress, validateContractAddresses } from "../dist/dotns.js";
import { classifyDeployError } from "../dist/telemetry.js";

const POLICY = JSON.parse(fs.readFileSync("assets/stack-policy.json", "utf8"));
const KUSAMA_RELAY_GENESIS = "0xb0a8d493285c2df73290dfb7e61f870f17b41801197a149ca93654499ea3dafe";
const KUSAMA_ASSET_HUB_GENESIS = "0x48239ef607d7928874027a43a67689209727dfb3d3dc5e5b03a39bdc2eda771a";
const KUSAMA_PEOPLE_GENESIS = "0xc1af4cb4eb3918e5db15086c0cc5ec17fb334f728b7c65dd44bfe1e174ff8b3f";
const QUIET = { warn: () => {} };

const ROOT_EXPORTS = [
  "BULLETIN_BLOCKS_PER_DAY", "DEFAULT_MNEMONIC", "DEFAULT_TEXT_RECORD_BUDGET_BYTES", "DEPLOY_PATH_PREFIX", "DotNS",
  "FALLBACK_MAX_COMMITMENT_AGE_SECONDS", "GenesisMismatchError", "MANIFEST_DIR", "MANIFEST_FILENAME", "MANIFEST_PATH",
  "MANIFEST_VERSION", "PLACEHOLDER_CID", "VERSION", "accountsNeedingReauthorization", "assertWithinBudget",
  "assetHubTopUpAmount", "checkProductConfigFilesExist", "classifyFile", "clearCommitmentRecord",
  "commitmentLockFilePath", "commitmentRecordKey", "commitmentStateFilePath", "computeStats", "defineConfig", "deploy",
  "derivePoolAccounts", "ensureAuthorized", "fetchPoolAuthorizations",
  "fetchPreviousManifest", "finaliseEmbeddedManifest", "formatConfigLoadError", "getTextRecordBudgetBytes",
  "isValidContractAddress", "isVolatilePath", "loadCommitmentRecord", "loadProductConfig",
  "loadRunState", "merkleizeJS", "merkleizeWithStableOrder", "parseDomainName", "parseManifest", "pessimisticSizePreflight",
  "poolAccountDerivationPath", "preflightProductConfig", "probablyOomRssMb", "probeChunks", "publishManifest",
  "reconcileManifestDomain", "renderSummary", "replaceCommitmentRecord", "resolveStateDir", "sanitizeDomainLabel",
  "selectAccount", "shouldShowOomHint", "shouldSkipStaleWarning", "stateFilePath", "telemetryAttributes",
  "tryAcquireCommitmentLock", "tryLoadProductConfig", "usesTmpdirFallback", "validateContractAddresses",
  "validateExecutableManifest", "validateProductConfig", "validateRootManifest", "verifyEmbeddedAppManifests",
  "writeCommitmentRecord", "writeEmbeddedAppManifests", "writeEmbeddedManifestPlaceholder", "writeRunState",
];

// Runs `run` with a global fetch that counts its calls and fails like an unreachable server.
async function withCountedFetch(run) {
  const realFetch = globalThis.fetch;
  const counter = { fetches: 0 };
  globalThis.fetch = async () => {
    counter.fetches += 1;
    throw new TypeError("fetch failed");
  };
  try {
    await run(counter);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// Signed fixtures: a test key stands in for a built-in stack's operator key.
// ---------------------------------------------------------------------------

const SECRET = generateSecret();
const POINTER = { url: "https://stack.example.test/.well-known/trinity-stack.json", key: publicKey(SECRET) };
const LOAD_TIME = new Date("2026-11-03T00:00:00Z");
const text = (bytes) => new TextDecoder().decode(bytes);
const encode = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));

function modelOf(id) {
  const { $v, sequence, generation, ...model } = readShippedStack(id).descriptor;
  return { model, generation };
}
const { model: MODEL, generation: GENERATION } = modelOf("paseo-next-v2");

// A signed document of `model`; a later `publishedAt` gives a higher sequence.
async function signed(model, publishedAt, secret = SECRET) {
  return publish(model, { generation: GENERATION, secret, now: new Date(publishedAt) });
}

const shippedAs = (document, id = "paseo-next-v2", pointer = POINTER) => ({ [id]: { pointer, document: text(document) } });
const serving = (document) => async () => new Response(document, { status: 200 });
const unreachable = async () => { throw new TypeError("fetch failed"); };
const withoutDotns = (model, ...keys) => ({ ...model, dotns: Object.fromEntries(Object.entries(model.dotns).filter(([key]) => !keys.includes(key))) });

async function loadWithWarnings(selection, options) {
  const warnings = [];
  const stack = await loadStack(selection, { now: LOAD_TIME, warn: (message) => warnings.push(message), ...options });
  return { stack, warnings };
}

function writeTmp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-stack-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

const V1 = await signed(MODEL, "2026-11-01T00:00:00Z");
const V2 = await signed({ ...MODEL, name: "Paseo Next v2 updated" }, "2026-11-02T00:00:00Z");

// ---------------------------------------------------------------------------
// Built-in stacks
// ---------------------------------------------------------------------------

describe("built-in stacks", () => {
  test("deploys default to paseo-next-v2", () => {
    assert.equal(DEFAULT_STACK_ID, "paseo-next-v2", ">> FAIL: default stack: a run with no --env or --stack must target paseo-next-v2");
  });

  test("the built-in set is preview, paseo-next-v2, pcf-devnet and polkadot, in that order", () => {
    assert.deepEqual([...BUILT_IN_STACK_IDS], ["preview", "paseo-next-v2", "pcf-devnet", "polkadot"],
      ">> FAIL: built-in set: dropped stacks (paseo-next, summit, kusama, ...) must not come back and none may go missing");
  });

  // Network facts belong to @parity/trinity-stack, so polkadot-app-deploy's public API is the deploy
  // itself: the stack catalog stays internal, and each public export is a semver commitment.
  test("the package root exports exactly the allow-listed exports, and no stack type", () => {
    assert.deepEqual(Object.keys(publicApi).sort(), [...ROOT_EXPORTS].sort(),
      ">> FAIL: package root: an export was added or removed; every root export is public API, so update the allow-list only on purpose");
    assert.doesNotMatch(fs.readFileSync("dist/index.d.ts", "utf8"), /from ['"]\.\/stacks\.js['"]/,
      ">> FAIL: package root: the Stack types must not be public; library callers select a stack with env or a stack string");
  });

  // Bootstrapping and funding the pool take a loaded Stack, which no public function returns, so
  // through the root they could only run without a stack's policy; the CLI and tools import dist/pool.js.
  test("the package root does not export pool bootstrap or funding", () => {
    for (const name of ["bootstrapPool", "ensurePoolAccountsFundedOnAssetHub", "isAutoReauthorizeAllowed"]) {
      assert.ok(!(name in publicApi), `>> FAIL: package root: ${name} must stay internal to the CLI and tools`);
    }
    const types = fs.readFileSync("dist/index.d.ts", "utf8");
    for (const name of ["EnsurePoolFundedOptions", "BootstrapPoolOptions", "AutoReauthorizeEnv"]) {
      assert.doesNotMatch(types, new RegExp(`\\b${name}\\b`), `>> FAIL: package root: the ${name} type must not be public`);
    }
  });

  test("each built-in stack's tld is its descriptor's tld", () => {
    for (const id of BUILT_IN_STACK_IDS) {
      const stack = readShippedStack(id);
      assert.ok(stack.tld, `>> FAIL: tld ${id}: every descriptor carries a tld, and DotNS domains and the product id use it`);
      assert.equal(stack.tld, stack.descriptor.tld, `>> FAIL: tld ${id}: the stack's tld must be the descriptor's, not a default`);
    }
  });

  test("exactly preview and paseo-next-v2 are e2eEligible", () => {
    const eligible = BUILT_IN_STACK_IDS.filter((id) => readShippedStack(id).e2eEligible);
    assert.deepEqual(eligible, ["preview", "paseo-next-v2"],
      ">> FAIL: e2eEligible: only preview and paseo-next-v2 may run E2E (opt-in flag, anything but true means not eligible)");
  });

  test("each stack's network comes from its chains, and the policy file carries none", () => {
    const networks = Object.fromEntries(BUILT_IN_STACK_IDS.map((id) => [id, readShippedStack(id).network]));
    assert.deepEqual(networks, { preview: "testnet", "paseo-next-v2": "testnet", "pcf-devnet": "testnet", polkadot: "mainnet" },
      ">> FAIL: network: only polkadot lists Polkadot chains, so only it is mainnet");
    for (const id of BUILT_IN_STACK_IDS) {
      assert.ok(!("network" in POLICY.stacks[id]), `>> FAIL: network ${id}: the policy must not carry a network, which could disagree with the chains`);
    }
  });

  // Chain-specific calls (XCM locations, sibling accounts) read paraId; a default would point them at another chain.
  test("each chain's paraId is the descriptor's, and absent when the descriptor has none", () => {
    for (const id of BUILT_IN_STACK_IDS) {
      const stack = readShippedStack(id);
      for (const role of ["Bulletin", "AssetHub", "People", "Relay"]) {
        const described = stack.descriptor.chains.find((chain) => chain.role === role);
        assert.equal(stack.chains[role].paraId, described.paraId ?? undefined, `>> FAIL: paraId ${id} ${role}: must be the descriptor's paraId`);
      }
    }
  });

  // One copy of each chain: a stack's chains cannot drift from the descriptor it was built from.
  test("each stack chain is the descriptor's own entry for that role", () => {
    for (const id of BUILT_IN_STACK_IDS) {
      const stack = readShippedStack(id);
      for (const role of ["Bulletin", "AssetHub", "People", "Relay"]) {
        assert.equal(stack.chains[role], stack.descriptor.chains.find((chain) => chain.role === role),
          `>> FAIL: chains ${id} ${role}: must be the descriptor's entry, not a copy`);
      }
    }
  });

  // Every shipped chain maps accounts on first use; off, every fresh deploy signer fails its first Revive call.
  test("autoAccountMapping is each policy's value, true for every built-in stack", () => {
    for (const id of BUILT_IN_STACK_IDS) {
      assert.equal(readShippedStack(id).autoAccountMapping, POLICY.stacks[id].autoAccountMapping, `>> FAIL: autoAccountMapping ${id}: must be the policy's value`);
      assert.equal(readShippedStack(id).autoAccountMapping, true, `>> FAIL: autoAccountMapping ${id}: every built-in policy turns it on`);
    }
  });

  test("--env polkadot resolves to mainnet without Bulletin auto-authorization", async () => {
    const { stack } = await loadWithWarnings({ env: "polkadot" }, { fetch: unreachable });
    assert.equal(stack.id, "polkadot", ">> FAIL: --env polkadot: must resolve to the polkadot built-in stack");
    assert.equal(stack.network, "mainnet", ">> FAIL: --env polkadot: must be a mainnet stack, so testnet-only paths stay off");
    assert.equal(stack.bulletinAutoAuthorize, false, ">> FAIL: --env polkadot: a mainnet deploy must never authorize Bulletin storage itself");
  });

  // TransactionStorage.authorize_account is accepted only from a key in that chain's
  // AllowedAuthorizers. previewnet's is //Eve, and //Alice there fails with BadSigner (#1209).
  test("each stack sets the Bulletin authorizer its chain accepts (issue #1209)", () => {
    assert.equal(readShippedStack("preview").bulletinAuthorizer, "//Eve",
      ">> FAIL: bulletin-authorizer preview: previewnet rejects //Alice, so preview must authorize with //Eve");
    assert.equal(readShippedStack("paseo-next-v2").bulletinAuthorizer, "//Alice",
      ">> FAIL: bulletin-authorizer paseo-next-v2: must authorize with //Alice");
    // PCF-devnet is community-operated and its authorizer is unknown; guessing one produces an
    // on-chain rejection rather than a clear "no authorizer key" message.
    const devnet = readShippedStack("pcf-devnet");
    assert.equal(devnet.bulletinAuthorizer, undefined, ">> FAIL: bulletin-authorizer pcf-devnet: must not declare an authorizer nobody verified");
    assert.equal(devnet.bulletinAutoAuthorize, false, ">> FAIL: bulletin-authorizer pcf-devnet: //Alice does not hold the rights there, so auto-authorize must stay off");
  });

  test("contracts are mapped from the descriptor's dotns keys to DOTNS_* keys", () => {
    for (const id of BUILT_IN_STACK_IDS) {
      const stack = readShippedStack(id);
      for (const [name, key] of Object.entries(DOTNS_CONTRACT_KEYS)) {
        assert.equal(stack.contracts[name], stack.descriptor.dotns?.[key],
          `>> FAIL: contracts ${id}: ${name} must be the descriptor's dotns.${key}`);
      }
      for (const [name, address] of Object.entries(stack.contracts)) {
        assert.ok(isValidContractAddress(address), `>> FAIL: contracts ${id}: ${name}=${address} is not a valid 0x address`);
      }
    }
  });

  // deploy() reports these two values as fullDomain and browserUrl; another gateway resolves the
  // name on the wrong network (issue #142), and a guessed one opens nothing.
  test("a deploy reports the label under the stack's tld, opened on the stack's own web-gateway", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bd-web-link-"));
    for (const id of BUILT_IN_STACK_IDS) {
      const stack = await loadStack({ stack: writeLocalStack(dir, { id }) }, QUIET);
      const gateway = stack.descriptor.services.find((service) => service.kind === "web-gateway")?.urls[0];
      const { fullDomain, browserUrl } = domainUrlsFor(stack, "myapp");
      assert.equal(fullDomain, `myapp.${stack.descriptor.tld}`, `>> FAIL: web link ${id}: the full domain must be the label under the descriptor's tld`);
      if (!gateway) {
        assert.equal(browserUrl, undefined, `>> FAIL: web link ${id}: a stack without a web-gateway must not get a guessed link`);
        continue;
      }
      const url = new URL(browserUrl);
      assert.equal(url.hostname, `myapp.${new URL(gateway).hostname}`, `>> FAIL: web link ${id}: myapp must open on the stack's gateway ${gateway}, got ${browserUrl}`);
      assert.equal(url.search, new URL(gateway).search, `>> FAIL: web link ${id}: the link must carry the gateway's query, or the SPA opens the wrong network`);
    }
    const services = readShippedStack("preview").descriptor.services.filter((service) => service.kind !== "web-gateway");
    const bareFile = path.join(dir, "no-web-gateway.json");
    fs.writeFileSync(bareFile, JSON.stringify({ ...readShippedStack("preview").descriptor, services }));
    assert.equal(domainUrlsFor(await loadStack({ stack: bareFile }, QUIET), "myapp").browserUrl, undefined,
      ">> FAIL: web link: a stack without a web-gateway must not get a guessed link");
  });

  test("popSelfServe is set for the E2E stacks only, with the policy's sudo labels", () => {
    for (const id of BUILT_IN_STACK_IDS) {
      const stack = readShippedStack(id);
      const expected = POLICY.stacks[id].popSelfServe;
      if (!expected) {
        assert.equal(stack.popSelfServe, null, `>> FAIL: popSelfServe ${id}: a stack without the policy entry must not offer self-serve guidance`);
        continue;
      }
      assert.equal(stack.popSelfServe?.sudoEnvLabel, expected.sudoEnvLabel, `>> FAIL: popSelfServe ${id}: the sudo env label must come from the policy`);
    }
  });

  test("storage deposits resolve to bigints only when the policy declares them", () => {
    for (const id of BUILT_IN_STACK_IDS) {
      const stack = readShippedStack(id);
      const { registerStorageDeposit, recordStorageDeposit } = POLICY.stacks[id];
      assert.equal(stack.registerStorageDeposit, registerStorageDeposit === undefined ? undefined : BigInt(registerStorageDeposit),
        `>> FAIL: deposits ${id}: registerStorageDeposit must mirror the policy, undefined when unset so the default applies`);
      assert.equal(stack.recordStorageDeposit, recordStorageDeposit === undefined ? undefined : BigInt(recordStorageDeposit),
        `>> FAIL: deposits ${id}: recordStorageDeposit must mirror the policy, undefined when unset so the default applies`);
    }
    const { descriptor } = readShippedStack("paseo-next-v2");
    const stack = buildStack(descriptor, { id: "x", builtIn: false, source: "file", policy: { aliases: [], description: "", recordStorageDeposit: 12_000_000_000 } });
    assert.equal(stack.recordStorageDeposit, 12_000_000_000n, ">> FAIL: deposits: a declared recordStorageDeposit must resolve to a bigint");
    assert.equal(stack.autoAccountMapping, false, ">> FAIL: autoAccountMapping: a policy without it must resolve to false");
  });

  // A built-in stack's policy can turn auto-authorization on, but the chains decide the network.
  test("a built-in stack on Polkadot chains is mainnet and loses auto-authorization", () => {
    const { descriptor } = readShippedStack("polkadot");
    const stack = buildStack(descriptor, { id: "polkadot", builtIn: true, source: "shipped", policy: { aliases: [], description: "", bulletinAutoAuthorize: true } });
    assert.equal(stack.network, "mainnet", ">> FAIL: mainnet auto-authorize: a stack on Polkadot's chains must be mainnet whatever its policy sets");
    assert.equal(stack.bulletinAutoAuthorize, false, ">> FAIL: mainnet auto-authorize: a mainnet stack must not authorize Bulletin storage even when its policy allows it");
  });
});

describe("environment ids and aliases", () => {
  test("aliases resolve to their built-in stack, case-insensitively", () => {
    const cases = { previewnet: "preview", ppn: "preview", PPN: "preview", "PCF-devnet": "pcf-devnet", "pcf-DEVNET": "pcf-devnet", "paseo-next-v2": "paseo-next-v2", " polkadot ": "polkadot" };
    for (const [value, id] of Object.entries(cases)) {
      assert.equal(findBuiltInStackId(value), id, `>> FAIL: alias: '${value}' must resolve to ${id}`);
      assert.equal(readShippedStack(value).id, id, `>> FAIL: alias: readShippedStack('${value}') must load ${id}`);
    }
    assert.equal(findBuiltInStackId("paseo-next"), undefined, ">> FAIL: alias: the dropped paseo-next must not resolve to anything");
  });

  test("loadStack resolves an alias before fetching", async () => {
    const { stack } = await loadWithWarnings({ env: "ppn" }, { fetch: unreachable });
    assert.equal(stack.id, "preview", ">> FAIL: alias load: --env ppn must load the preview stack");
  });

  test("an unknown env fails with a suggestion when one is close", async () => {
    await assert.rejects(() => loadStack({ env: "paseo-nxt-v2" }, { fetch: unreachable }), (error) => {
      assert.ok(error instanceof NonRetryableError, ">> FAIL: unknown env: must be non-retryable, a retry picks the same env");
      assert.match(error.message, /Unknown environment 'paseo-nxt-v2'\. Valid: preview, paseo-next-v2, pcf-devnet, polkadot, or pass a stack with --stack\./,
        `>> FAIL: unknown env: must list the valid ids and mention --stack; got: ${error.message}`);
      assert.match(error.message, /Did you mean 'paseo-next-v2'\?/, `>> FAIL: unknown env: a near-miss must suggest the closest id; got: ${error.message}`);
      return true;
    });
  });

  test("an unknown env fails without a suggestion when nothing is close", () => {
    assert.throws(() => readShippedStack("completelyunrelated"), (error) => {
      assert.ok(error instanceof NonRetryableError, ">> FAIL: unknown env: must be non-retryable");
      assert.doesNotMatch(error.message, /Did you mean/, `>> FAIL: unknown env: a far-off value must not get a misleading suggestion; got: ${error.message}`);
      return true;
    });
  });

  // Names every object inherits must not read as a removed environment.
  test("an inherited property name is an unknown env, not a removed one", async () => {
    for (const value of ["constructor", "toString", "__proto__", "valueOf"]) {
      await assert.rejects(() => loadStack({ env: value }, { fetch: unreachable }),
        (error) => error instanceof NonRetryableError && error.message.startsWith(`Unknown environment '${value}'.`),
        `>> FAIL: unknown env ${value}: must give the unknown-environment error`);
    }
  });
});

describe("listStacks + formatStackTable (--list-environments)", () => {
  test("one row per built-in stack with its network and aliases", () => {
    const rows = listStacks();
    assert.deepEqual(rows.map((row) => row.id), [...BUILT_IN_STACK_IDS], ">> FAIL: list: every built-in stack must be listed, in policy order");
    for (const row of rows) {
      assert.equal(row.network, readShippedStack(row.id).network, `>> FAIL: list ${row.id}: network must be the stack's`);
      assert.equal(row.aliases, POLICY.stacks[row.id].aliases.join(", "), `>> FAIL: list ${row.id}: aliases must be listed so users find previewnet and PCF-devnet`);
      assert.equal(row.name, readShippedStack(row.id).name, `>> FAIL: list ${row.id}: name must be the descriptor's`);
    }
  });

  test("the table has a header and a line per stack", () => {
    const lines = formatStackTable(listStacks()).split("\n");
    assert.match(lines[0], /^ID\s+Name\s+Network\s+Aliases\s+Description$/, ">> FAIL: table: header columns changed");
    for (const id of BUILT_IN_STACK_IDS) {
      assert.ok(lines.some((line) => line.startsWith(`${id} `)), `>> FAIL: table: no row for ${id}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Refresh of a built-in stack from its published descriptor
// ---------------------------------------------------------------------------

describe("built-in stack refresh", () => {
  test("updated: a newer published copy is used", async () => {
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V1.document), fetch: serving(V2.document) });
    assert.equal(stack.source, "published", ">> FAIL: refresh updated: a verified newer descriptor must be used, marked published");
    assert.equal(stack.descriptor.sequence, V2.descriptor.sequence, ">> FAIL: refresh updated: the stack must carry the published sequence");
    assert.equal(stack.name, "Paseo Next v2 updated", ">> FAIL: refresh updated: values must come from the published copy");
    assert.equal(stack.bulletinAuthorizer, POLICY.stacks["paseo-next-v2"].bulletinAuthorizer, ">> FAIL: refresh updated: the built-in policy must still apply");
    assert.deepEqual(warnings, [], ">> FAIL: refresh updated: a clean refresh must not warn");
  });

  test("unchanged: the published copy equal to the shipped one is used", async () => {
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V1.document), fetch: serving(V1.document) });
    assert.equal(stack.source, "published", ">> FAIL: refresh unchanged: an unchanged descriptor still counts as published");
    assert.equal(stack.descriptor.sequence, V1.descriptor.sequence, ">> FAIL: refresh unchanged: sequence must not move");
    assert.deepEqual(warnings, [], ">> FAIL: refresh unchanged: must not warn");
  });

  test("unreachable: the shipped copy is used with a warning", async () => {
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V1.document), fetch: unreachable });
    assert.equal(stack.source, "shipped", ">> FAIL: refresh unreachable: a network failure must fall back to the shipped copy, not fail the deploy");
    assert.equal(warnings.length, 1, ">> FAIL: refresh unreachable: exactly one warning expected");
    assert.match(warnings[0], /could not fetch the published descriptor of stack paseo-next-v2 from https:\/\/stack\.example\.test\/.*using the copy of stack paseo-next-v2 shipped with polkadot-app-deploy/,
      `>> FAIL: refresh unreachable: the warning must name the URL and the fallback; got: ${warnings[0]}`);
  });

  test("rollback: a lower published sequence is ignored with a warning", async () => {
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V2.document), fetch: serving(V1.document) });
    assert.equal(stack.source, "shipped", ">> FAIL: refresh rollback: an older descriptor must not replace the shipped copy");
    assert.equal(stack.descriptor.sequence, V2.descriptor.sequence, ">> FAIL: refresh rollback: the shipped sequence must stay");
    assert.match(warnings.join("\n"), /has a sequence below the shipped copy's/, `>> FAIL: refresh rollback: must warn about the rollback; got: ${warnings}`);
  });

  test("refused: a published copy with a bad signature is ignored with a warning", async () => {
    const forged = await signed({ ...MODEL, name: "forged" }, "2026-11-02T00:00:00Z", generateSecret());
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V1.document), fetch: serving(forged.document) });
    assert.equal(stack.source, "shipped", ">> FAIL: refresh refused: a descriptor not signed by the stack's key must never be used");
    assert.notEqual(stack.name, "forged", ">> FAIL: refresh refused: forged values leaked into the stack");
    assert.match(warnings.join("\n"), /breaks the rule bad-signature/, `>> FAIL: refresh refused: must warn naming the broken rule; got: ${warnings}`);
  });

  test("conflict: a published copy with the shipped sequence and other content is ignored with a warning", async () => {
    const conflicting = await signed({ ...MODEL, name: "conflicting" }, "2026-11-01T00:00:00Z");
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V1.document), fetch: serving(conflicting.document) });
    assert.equal(stack.source, "shipped", ">> FAIL: refresh conflict: a copy that conflicts with the shipped one must not replace it");
    assert.equal(stack.name, V1.descriptor.name, ">> FAIL: refresh conflict: values must come from the shipped copy");
    assert.match(warnings.join("\n"), /has the shipped copy's sequence \d+ with other content/, `>> FAIL: refresh conflict: must warn about the conflict; got: ${warnings}`);
  });

  test("a published copy lacking a required field is ignored with a warning", async () => {
    const incomplete = await signed(withoutDotns(MODEL, "popRules"), "2026-11-02T00:00:00Z");
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V1.document), fetch: serving(incomplete.document) });
    assert.equal(stack.source, "shipped", ">> FAIL: refresh missing field: an unusable published copy must fall back to the shipped copy");
    assert.ok(stack.contracts.POP_RULES, ">> FAIL: refresh missing field: POP_RULES must come from the shipped copy");
    assert.match(warnings.join("\n"), /is unusable: stack paseo-next-v2 lacks dotns\.popRules/, `>> FAIL: refresh missing field: must warn naming the missing field; got: ${warnings}`);
  });

  test("an expired stack fails", async () => {
    const expired = await signed({ ...MODEL, validUntil: Date.parse("2026-11-01T12:00:00Z") / 1000, expiresAt: Date.parse("2026-11-02T00:00:00Z") / 1000 }, "2026-11-01T00:00:00Z");
    await assert.rejects(
      () => loadStack({ env: "paseo-next-v2" }, { shipped: shippedAs(expired.document), fetch: unreachable, now: LOAD_TIME, warn: () => {} }),
      (error) => error instanceof NonRetryableError && /stack paseo-next-v2 expired at 2026-11-02T00:00:00\.000Z/.test(error.message),
      ">> FAIL: expired: a stack past its expiresAt is gone, and deploying to it must fail",
    );
  });

  test("a stale stack loads with a warning", async () => {
    const stale = await signed({ ...MODEL, validUntil: Date.parse("2026-11-02T00:00:00Z") / 1000 }, "2026-11-01T00:00:00Z");
    const { stack, warnings } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(stale.document), fetch: unreachable });
    assert.equal(stack.id, "paseo-next-v2", ">> FAIL: stale: a stale stack is still usable");
    assert.ok(warnings.some((warning) => /stack paseo-next-v2 is past its validUntil \(2026-11-02T00:00:00\.000Z\) and may be outdated/.test(warning)),
      `>> FAIL: stale: must warn that the stack is past its validUntil; got: ${warnings}`);
  });

  // The network follows the chains of the descriptor in use, so a fetched copy gets the same rule.
  test("a published copy naming a Polkadot chain makes the stack mainnet, without auto-authorization", async () => {
    const genesisHash = readShippedStack("polkadot").chains.AssetHub.genesisHash;
    const onPolkadot = await signed({ ...MODEL, chains: MODEL.chains.map((chain) => (chain.role === "AssetHub" ? { ...chain, genesisHash } : chain)) }, "2026-11-02T00:00:00Z");
    const { stack } = await loadWithWarnings({ env: "paseo-next-v2" }, { shipped: shippedAs(V1.document), fetch: serving(onPolkadot.document) });
    assert.equal(stack.source, "published", ">> FAIL: published mainnet setup: the fetched copy must be used");
    assert.equal(stack.network, "mainnet", ">> FAIL: published mainnet: a published descriptor on Polkadot's Asset Hub must make the stack mainnet");
    assert.equal(stack.bulletinAutoAuthorize, false, ">> FAIL: published mainnet: the testnet policy's auto-authorization must not apply on Polkadot chains");
  });
});

// ---------------------------------------------------------------------------
// --stack: links, URLs and files
// ---------------------------------------------------------------------------

describe("--stack sources", () => {
  test("a link is fetched and checked against its key", async () => {
    const link = encodeLink(POINTER);
    const stack = await loadStackSource(link, { fetch: serving(V1.document), shipped: {}, now: LOAD_TIME });
    assert.equal(stack.source, "link", ">> FAIL: --stack link: source must be link");
    assert.equal(stack.builtIn, false, ">> FAIL: --stack link: a key no built-in stack uses gives a custom stack");
    assert.equal(stack.location, link, ">> FAIL: --stack link: location must store the link so messages can repeat it");
    assert.equal(stackSelectionFlag(stack), `--stack ${link}`, ">> FAIL: --stack link: printed commands must select the same stack again");
  });

  test("a link whose key did not sign the document is refused", async () => {
    const wrongKey = encodeLink({ ...POINTER, key: publicKey(generateSecret()) });
    await assert.rejects(
      () => loadStackSource(wrongKey, { fetch: serving(V1.document), shipped: {}, now: LOAD_TIME }),
      (error) => error instanceof NonRetryableError && /is unusable: signature does not verify/.test(error.message),
      ">> FAIL: --stack wrong key: a descriptor not signed by the link's key must be refused",
    );
  });

  test("an unreachable link fails naming it", async () => {
    await assert.rejects(
      () => loadStackSource(encodeLink(POINTER), { fetch: unreachable, shipped: {}, now: LOAD_TIME }),
      (error) => error instanceof NonRetryableError && /failed to read stack .*is unreachable/.test(error.message),
      ">> FAIL: --stack unreachable: a custom stack has no shipped copy, so an unreachable link must fail",
    );
  });

  test("a URL serving an unsigned plain descriptor is accepted", async () => {
    const url = "https://custom.example.test/stack.json";
    const stack = await loadStackSource(url, { fetch: serving(encode(V1.descriptor)), shipped: {}, now: LOAD_TIME });
    assert.equal(stack.source, "url", ">> FAIL: --stack url: source must be url");
    assert.equal(stack.builtIn, false, ">> FAIL: --stack url: an unsigned descriptor gives a custom stack");
    assert.deepEqual(stack.chains.Bulletin.rpc, MODEL.chains.find((chain) => chain.role === "Bulletin").rpc, ">> FAIL: --stack url: chains must come from the served descriptor");
  });

  test("a file is read without a signature check", async () => {
    const file = writeTmp("stack.json", JSON.stringify(V1.descriptor));
    const stack = await loadStackSource(file, { shipped: {}, now: LOAD_TIME });
    assert.equal(stack.source, "file", ">> FAIL: --stack file: source must be file");
    assert.equal(stack.location, file, ">> FAIL: --stack file: location must be the path");
    assert.match(describeStackOrigin(stack), /passed with --stack as a file/, ">> FAIL: --stack file: messages must say the stack came from --stack");
  });

  test("a missing file fails naming it", async () => {
    await assert.rejects(
      () => loadStackSource("/nonexistent/stack.json", { shipped: {} }),
      (error) => error instanceof NonRetryableError && /failed to read stack '\/nonexistent\/stack\.json'/.test(error.message),
      ">> FAIL: --stack missing file: must fail naming the path",
    );
  });

  test("an expired descriptor passed with --stack fails", async () => {
    const file = writeTmp("expired.json", JSON.stringify({ ...V1.descriptor, expiresAt: Date.parse("2026-11-02T00:00:00Z") / 1000 }));
    await assert.rejects(
      () => loadStackSource(file, { shipped: {}, now: LOAD_TIME }),
      /expired at 2026-11-02T00:00:00\.000Z/,
      ">> FAIL: --stack expired: a stack past its expiresAt must fail however it was passed",
    );
  });

  test("a document signed with a built-in stack's key loads as that built-in, with its policy", async () => {
    const url = "https://mirror.example.test/stack.json";
    const stack = await loadStackSource(url, { fetch: serving(V2.document), shipped: shippedAs(V1.document), now: LOAD_TIME });
    assert.equal(stack.id, "paseo-next-v2", ">> FAIL: --stack built-in key: a document signed by a built-in stack's key is that stack");
    assert.equal(stack.builtIn, true, ">> FAIL: --stack built-in key: must count as built-in");
    assert.equal(stack.source, "url", ">> FAIL: --stack built-in key: source must still say how it was passed");
    assert.equal(stack.bulletinAuthorizer, POLICY.stacks["paseo-next-v2"].bulletinAuthorizer, ">> FAIL: --stack built-in key: the built-in's policy must apply");
    assert.equal(stack.e2eEligible, true, ">> FAIL: --stack built-in key: the built-in's policy must apply");

    const viaLink = await loadStackSource(encodeLink(POINTER), { fetch: serving(V2.document), shipped: shippedAs(V1.document), now: LOAD_TIME });
    assert.equal(viaLink.id, "paseo-next-v2", ">> FAIL: --stack built-in link: a link with a built-in's key must load that built-in");
  });

  test("a rollback of a built-in stack passed with --stack is refused", async () => {
    await assert.rejects(
      () => loadStackSource("https://mirror.example.test/stack.json", { fetch: serving(V1.document), shipped: shippedAs(V2.document), now: LOAD_TIME }),
      (error) => error instanceof NonRetryableError && /is unusable: the descriptor has a sequence below the shipped copy's \d+/.test(error.message),
      ">> FAIL: --stack rollback: an older signed copy of a built-in stack must not be usable to roll it back",
    );
  });

  // Same sequence with other content means two operators' copies disagree; neither may silently win.
  test("a copy of a built-in stack with the shipped sequence and other content is refused", async () => {
    const conflicting = await signed({ ...MODEL, name: "conflicting" }, "2026-11-01T00:00:00Z");
    assert.equal(conflicting.descriptor.sequence, V1.descriptor.sequence, ">> FAIL: --stack conflict setup: the fixture must reuse the shipped sequence");
    await assert.rejects(
      () => loadStackSource("https://mirror.example.test/stack.json", { fetch: serving(conflicting.document), shipped: shippedAs(V1.document), now: LOAD_TIME }),
      (error) => error instanceof NonRetryableError && /is unusable: the descriptor has the shipped copy's sequence \d+ with other content/.test(error.message),
      ">> FAIL: --stack conflict: a signed copy that conflicts with the shipped copy must be refused",
    );
  });

  // A malformed value fails the same way on every retry, so it must exit non-retryable and name what was passed.
  test("a malformed link fails non-retryable, naming the value", async () => {
    for (const value of ["polkadotapp://stack?key=0xzz&url=https%3A%2F%2Fa.example%2Fs.json", "https://"]) {
      await assert.rejects(
        () => loadStackSource(value, { fetch: unreachable, shipped: {}, now: LOAD_TIME }),
        (error) => error instanceof NonRetryableError && error.message.startsWith(`failed to read stack '${value}'`),
        `>> FAIL: --stack malformed: '${value}' must fail with a NonRetryableError naming it`,
      );
    }
  });
});

describe("custom stack policy and id", () => {
  test("a custom stack is a testnet with Bulletin auto-authorization and no authorizer", async () => {
    const file = writeTmp("custom.json", JSON.stringify(V1.descriptor));
    const stack = await loadStackSource(file, { shipped: {}, now: LOAD_TIME });
    assert.equal(stack.network, "testnet", ">> FAIL: custom policy: a stack none of whose chains is a Polkadot or Kusama chain is a testnet");
    assert.equal(stack.bulletinAutoAuthorize, true, ">> FAIL: custom policy: a custom testnet authorizes Bulletin storage itself");
    assert.equal(stack.bulletinAuthorizer, undefined, ">> FAIL: custom policy: no authorizer is declared, so //Alice is used at the point of use");
    assert.equal(stack.e2eEligible, false, ">> FAIL: custom policy: a custom stack is never E2E-eligible");
    assert.equal(stack.autoAccountMapping, true, ">> FAIL: custom policy: a custom stack maps accounts on first use, or a fresh signer's first Revive call fails");
  });

  test("a stack on Polkadot's relay is mainnet, including a fork that retains Polkadot's genesis", async () => {
    const polkadot = readShippedStack("polkadot").descriptor;
    const fork = { ...polkadot, id: "my-polkadot-fork", name: "My Polkadot fork", sequence: 1 };
    const stack = await loadStackSource(writeTmp("fork.json", JSON.stringify(fork)), { shipped: {}, now: LOAD_TIME });
    assert.equal(stack.builtIn, false, ">> FAIL: custom mainnet: an unsigned fork is not the polkadot built-in");
    assert.equal(stack.network, "mainnet", ">> FAIL: custom mainnet: a relay with Polkadot's genesis is mainnet whatever the stack calls itself");
    assert.equal(stack.bulletinAutoAuthorize, false, ">> FAIL: custom mainnet: a mainnet stack must not authorize Bulletin storage itself");
  });

  // Each listed chain decides the network alone, whichever role carries it: the relay is never
  // connected, so a wrong relay hash alone must not open the testnet paths (//Alice
  // authorization, dev-phrase top-ups) on a Polkadot or Kusama Asset Hub, People or Bulletin.
  test("each Polkadot or Kusama genesis hash alone makes a stack mainnet, on any of its chains", () => {
    const polkadot = Object.values(readShippedStack("polkadot").chains).map((chain) => chain.genesisHash);
    const kusama = [KUSAMA_RELAY_GENESIS, KUSAMA_ASSET_HUB_GENESIS, KUSAMA_PEOPLE_GENESIS];
    assert.deepEqual(Object.keys(MAINNET_GENESIS).sort(), [...polkadot, ...kusama].sort(),
      ">> FAIL: mainnet genesis: the table must list exactly the shipped Polkadot chains and Kusama's relay, Asset Hub and People");
    for (const [genesisHash, chainName] of Object.entries(MAINNET_GENESIS)) {
      for (const role of ["Relay", "AssetHub", "People", "Bulletin"]) {
        const descriptor = { ...V1.descriptor, chains: V1.descriptor.chains.map((chain) => (chain.role === role ? { ...chain, genesisHash } : chain)) };
        const stack = buildStack(descriptor, { id: "x", builtIn: false, source: "file", location: "./x.json", policy: customStackPolicy(descriptor) });
        assert.equal(stack.network, "mainnet", `>> FAIL: mainnet genesis: the ${chainName} as the ${role} chain must make the stack mainnet`);
        assert.equal(stack.bulletinAutoAuthorize, false, `>> FAIL: mainnet genesis: the ${chainName} as the ${role} chain must turn Bulletin auto-authorization off`);
        assert.equal(stack.autoAccountMapping, true, ">> FAIL: mainnet genesis: a custom mainnet stack maps accounts on first use too");
      }
    }
  });

  test("a custom id never equals a built-in id or alias", async () => {
    for (const descriptorId of [...BUILT_IN_STACK_IDS, "previewnet", "PPN", "PCF-devnet"]) {
      const stack = await loadStackSource(writeTmp("x.json", JSON.stringify({ ...V1.descriptor, id: descriptorId })), { shipped: {}, now: LOAD_TIME });
      assert.match(stack.id, /^[a-z0-9-]+-[0-9a-f]{8}$/, `>> FAIL: custom id: '${stack.id}' must be the sanitized descriptor id plus 8 hex`);
      assert.equal(findBuiltInStackId(stack.id), undefined,
        `>> FAIL: custom id: a custom stack with descriptor id '${descriptorId}' got id '${stack.id}', which selects a built-in stack`);
    }
  });

  // The id keys DotNS commitment records and the per-name lock, so the same stack must retain it
  // across republishes and whether it is passed as a file or a URL.
  test("an unsigned stack retains its id across republishes and across file and URL", async () => {
    const options = { fetch: serving(encode(V1.descriptor)), shipped: {}, now: LOAD_TIME };
    const viaUrl = await loadStackSource("https://one.example.test/stack.json", options);
    const viaOtherUrl = await loadStackSource("https://two.example.test/stack.json", options);
    const viaFile = await loadStackSource(writeTmp("a.json", JSON.stringify(V1.descriptor)), { shipped: {}, now: LOAD_TIME });
    const republished = await loadStackSource(writeTmp("b.json", JSON.stringify({ ...V2.descriptor, name: "other" })), { shipped: {}, now: LOAD_TIME });
    assert.equal(viaOtherUrl.id, viaUrl.id, ">> FAIL: custom id: the same stack at another URL must retain its id");
    assert.equal(viaFile.id, viaUrl.id, ">> FAIL: custom id: the same stack as a file must have the id it has as a URL");
    assert.equal(republished.id, viaUrl.id, ">> FAIL: custom id: a republished descriptor of the same stack must retain its id, or an interrupted register misses its resume record");
  });

  test("two stacks with the same descriptor id on different chains get different ids", async () => {
    const onOtherBulletin = { ...V1.descriptor, chains: V1.descriptor.chains.map((chain) => (chain.role === "Bulletin" ? { ...chain, genesisHash: "0x" + "ab".repeat(32) } : chain)) };
    const first = await loadStackSource(writeTmp("a.json", JSON.stringify(V1.descriptor)), { shipped: {}, now: LOAD_TIME });
    const second = await loadStackSource(writeTmp("b.json", JSON.stringify(onOtherBulletin)), { shipped: {}, now: LOAD_TIME });
    assert.notEqual(first.id, second.id, ">> FAIL: custom id: stacks on different chains must not share run state or telemetry ids");
  });

  test("a signed stack's id comes from its key, whatever URL serves it", async () => {
    const other = encodeLink({ ...POINTER, url: "https://mirror.example.test/stack.json" });
    const first = await loadStackSource(encodeLink(POINTER), { fetch: serving(V1.document), shipped: {}, now: LOAD_TIME });
    const second = await loadStackSource(other, { fetch: serving(V2.document), shipped: {}, now: LOAD_TIME });
    assert.equal(first.id, second.id, ">> FAIL: custom id: a keyed stack is identified by its key");
  });
});

// ---------------------------------------------------------------------------
// Selection: --env vs --stack
// ---------------------------------------------------------------------------

describe("stack selection", () => {
  test("loadStack rejects --stack with --env", async () => {
    await assert.rejects(
      () => loadStack({ env: "preview", stack: "./y.json" }),
      (error) => error instanceof NonRetryableError && /--stack and --env both select the network; pass one of them/.test(error.message),
      ">> FAIL: selection: --stack with --env must fail instead of silently picking one",
    );
  });

  test("resolveStackSelection: a flag wins over an env var, and conflicting pairs fail", () => {
    assert.deepEqual(resolveStackSelection({ flagEnv: "preview", envVarStack: "./y.json" }), { env: "preview" }, ">> FAIL: selection: --env must win over PAD_STACK");
    assert.deepEqual(resolveStackSelection({ flagStack: "./y.json", envVarEnv: "preview" }), { stack: "./y.json" }, ">> FAIL: selection: --stack must win over PAD_ENV");
    assert.deepEqual(resolveStackSelection({ envVarStack: " ./y.json " }), { stack: "./y.json" }, ">> FAIL: selection: PAD_STACK alone must select the stack");
    assert.deepEqual(resolveStackSelection({ flagEnv: "", envVarEnv: "" }), {}, ">> FAIL: selection: empty values must leave the default stack");
    assert.throws(() => resolveStackSelection({ flagEnv: "preview", flagStack: "./y.json" }), /--stack and --env both select the network/,
      ">> FAIL: selection: --stack with --env must fail");
    assert.throws(() => resolveStackSelection({ envVarEnv: "preview", envVarStack: "./y.json" }), /PAD_STACK and PAD_ENV both select the network/,
      ">> FAIL: selection: PAD_STACK with PAD_ENV must fail");
  });

  test("with no selection the default stack loads", async () => {
    const { stack } = await loadWithWarnings({}, { fetch: unreachable, now: new Date() });
    assert.equal(stack.id, DEFAULT_STACK_ID, ">> FAIL: selection: an empty selection must load DEFAULT_STACK_ID");
  });

  test("loadStack rejects a Stack object, which would skip every check loading makes", async () => {
    await assert.rejects(() => loadStack({ stack: readShippedStack("preview") }),
      (error) => error instanceof NonRetryableError && /stack must be a stack descriptor file, URL or link/.test(error.message),
      ">> FAIL: selection: a hand-built or earlier Stack object must be rejected; pass its link, URL, file or env instead");
  });

  // The CLI and the deploy it starts both load the selected stack; the descriptor is fetched once per run.
  test("a selection loads once per process, also through an alias, the default or stackSelectionOf", async () => {
    await withCountedFetch(async (counter) => {
      const first = await loadStack({ env: "pcf-devnet" }, QUIET);
      assert.equal(await loadStack({ env: "PCF-devnet" }, QUIET), first, ">> FAIL: cache: an alias must return the stack loaded for its id");
      assert.equal(await loadStack(stackSelectionOf(first), QUIET), first, ">> FAIL: cache: stackSelectionOf must select the same cached stack");
      assert.equal(counter.fetches, 1, ">> FAIL: cache: a selection loaded again must not fetch its descriptor again");
      const byDefault = await loadStack({}, QUIET);
      assert.equal(await loadStack({ env: DEFAULT_STACK_ID }, QUIET), byDefault, ">> FAIL: cache: the default selection and its id must share one load");
      assert.equal(counter.fetches, 2, ">> FAIL: cache: the default stack must be fetched once");
    });
  });

  test("test hooks bypass the cache", async () => {
    await withCountedFetch(async (counter) => {
      const cached = await loadStack({ env: "polkadot" }, QUIET);
      const hooked = await loadStack({ env: "polkadot" }, { ...QUIET, fetch: unreachable });
      assert.notEqual(hooked, cached, ">> FAIL: cache hooks: a load with an injected fetch must not return the cached stack");
      assert.equal(counter.fetches, 1, ">> FAIL: cache hooks: the hooked load must use its own fetch");
    });
  });

  test("a failed load is not cached", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bd-stack-")), "later.json");
    await assert.rejects(() => loadStack({ stack: file }), /failed to read stack/, ">> FAIL: cache failure: a missing file must fail");
    fs.writeFileSync(file, JSON.stringify({ ...V1.descriptor, validUntil: undefined, expiresAt: undefined }));
    const stack = await loadStack({ stack: file }, QUIET);
    assert.equal(stack.location, file, ">> FAIL: cache failure: a selection that failed once must load when retried");
  });

  // Tests and tools pass a shipped copy to select a built-in stack without the network.
  test("a shipped copy passed as a file loads as that built-in without fetching", async () => {
    await withCountedFetch(async (counter) => {
      for (const id of BUILT_IN_STACK_IDS) {
        const stack = await loadStack({ stack: `.trinity/${id}.json` }, QUIET);
        assert.equal(stack.id, id, `>> FAIL: shipped file ${id}: must load as the built-in stack`);
        assert.equal(stack.builtIn, true, `>> FAIL: shipped file ${id}: must count as built-in, with its policy`);
        assert.equal(await loadStack(stackSelectionOf(stack)), stack, `>> FAIL: shipped file ${id}: stackSelectionOf must select the same cached stack`);
      }
      assert.equal(counter.fetches, 0, ">> FAIL: shipped file: a file selection must not fetch");
    });
  });

  // The variable selected the network on main; ignoring it would deploy somewhere else silently.
  test("PAD_ENV_FILE fails every load, cached or not", async () => {
    const previous = process.env.PAD_ENV_FILE;
    process.env.PAD_ENV_FILE = "./envs.json";
    try {
      await withCountedFetch(async () => {
        for (const selection of [{}, { env: "preview" }, { stack: ".trinity/preview.json" }]) {
          await assert.rejects(() => loadStack(selection, QUIET),
            (error) => error instanceof NonRetryableError && error.message === RETIRED_SELECTION_ERRORS.environmentFile,
            `>> FAIL: PAD_ENV_FILE: loadStack(${JSON.stringify(selection)}) must fail with the removal message`);
        }
      });
    } finally {
      if (previous === undefined) delete process.env.PAD_ENV_FILE;
      else process.env.PAD_ENV_FILE = previous;
    }
  });
});

describe("CLI stack selection", () => {
  const runCli = (args, env = {}) => spawnSync(process.execPath, ["bin/polkadot-app-deploy", ...args], {
    encoding: "utf8", timeout: 30_000, env: createCliTestEnv(fs.mkdtempSync(path.join(os.tmpdir(), "bd-cli-home-")), env),
  });
  const errorLines = (stderr) => stderr.split("\n").filter((line) => /error/i.test(line)).join(" | ");

  test("--env with --stack exits non-zero with the message", () => {
    const result = runCli(["./x", "foo", "--env", "preview", "--stack", "./y.json"]);
    assert.notEqual(result.status, 0, ">> FAIL: CLI --env --stack: must exit non-zero");
    assert.match(result.stderr, /--stack and --env both select the network; pass one of them/, `>> FAIL: CLI --env --stack: stderr must say why; got: ${errorLines(result.stderr)}`);
  });

  test("PAD_STACK with PAD_ENV exits non-zero with the message", () => {
    const result = runCli(["./x", "foo"], { PAD_ENV: "preview", PAD_STACK: "./y.json" });
    assert.notEqual(result.status, 0, ">> FAIL: CLI env vars: must exit non-zero");
    assert.match(result.stderr, /PAD_STACK and PAD_ENV both select the network; set one of them/, `>> FAIL: CLI env vars: stderr must say why; got: ${errorLines(result.stderr)}`);
  });

  test("--list-environments prints the four built-in stacks", () => {
    const result = runCli(["--list-environments"]);
    assert.equal(result.status, 0, `>> FAIL: CLI --list-environments: must exit 0; got ${result.status}: ${errorLines(result.stderr)}`);
    const rows = result.stdout.split("\n").filter((line) => BUILT_IN_STACK_IDS.some((id) => line.startsWith(`${id} `)));
    assert.deepEqual(rows.map((line) => line.split(/\s+/)[0]), [...BUILT_IN_STACK_IDS], `>> FAIL: CLI --list-environments: must list exactly the built-in stacks; got: ${result.stdout}`);
  });
});

// ---------------------------------------------------------------------------
// Required fields and shipped copies
// ---------------------------------------------------------------------------

describe("required fields", () => {
  test("buildStack lists every missing chain, service and dotns key", () => {
    const descriptor = {
      ...V1.descriptor,
      chains: V1.descriptor.chains.filter((chain) => !["Bulletin", "Relay"].includes(chain.role)),
      services: V1.descriptor.services.filter((service) => service.kind !== "ipfs-gateway"),
      dotns: withoutDotns(V1.descriptor, "popRules", "controller").dotns,
    };
    assert.throws(
      () => buildStack(descriptor, { id: "x", builtIn: false, source: "file", policy: customStackPolicy(V1.descriptor) }),
      (error) => {
        assert.ok(error instanceof NonRetryableError, ">> FAIL: required fields: an incomplete stack must be non-retryable");
        for (const part of ["chain Bulletin", "chain Relay", "service ipfs-gateway", "dotns.controller", "dotns.popRules"]) {
          assert.ok(error.message.includes(part), `>> FAIL: required fields: the message must name ${part}; got: ${error.message}`);
        }
        return true;
      },
    );
  });

  test("a descriptor without a dotns map lacks every required contract", () => {
    const { dotns, ...descriptor } = V1.descriptor;
    assert.throws(
      () => buildStack(descriptor, { id: "x", builtIn: false, source: "file", policy: customStackPolicy(descriptor) }),
      /lacks dotns\.protocolRegistry, dotns\.registrar, dotns\.controller, dotns\.registry, dotns\.contentResolver, dotns\.popController, dotns\.popRules$/,
      ">> FAIL: required fields: a stack without DotNS must list every contract a deploy reads",
    );
  });
});

describe("assertShippedStacks (build check, independent of the date)", () => {
  const { model: PREVIEW_MODEL, generation: PREVIEW_GENERATION } = modelOf("preview");
  const signedPreview = (model, secret = SECRET) =>
    publish(model, { generation: PREVIEW_GENERATION, secret, now: new Date("2026-11-01T00:00:00Z") });
  const withPreview = (copy) => ({ ...realCopies, preview: copy });
  const expectProblem = (shipped, pattern, scenario, policyFile) =>
    assert.throws(() => assertShippedStacks(shipped, policyFile), (error) => {
      assert.match(error.message, /^unusable stack copies in \.trinity:/, `>> FAIL: ${scenario}: the build check must fail with the copy list`);
      assert.match(error.message, pattern, `>> FAIL: ${scenario}: the build check must name the bad copy and why; got: ${error.message}`);
      return true;
    });
  const policyWith = (id, change) => ({ ...POLICY, stacks: { ...POLICY.stacks, [id]: { ...POLICY.stacks[id], ...change } } });

  test("passes for the real shipped copies", () => {
    assert.doesNotThrow(() => assertShippedStacks(), ">> FAIL: shipped copies: a copy in .trinity/ is unusable, so the release would ship it");
  });

  test("fails for a copy that does not verify under its link's key", async () => {
    const foreign = await signedPreview(PREVIEW_MODEL, generateSecret());
    expectProblem(withPreview({ pointer: { ...realCopies.preview.pointer, key: publicKey(SECRET) }, document: text(foreign.document) }), /\n {2}preview: signature does not verify/, "shipped bad signature");
  });

  test("fails for a copy that lacks a required field", async () => {
    const incomplete = await signedPreview(withoutDotns(PREVIEW_MODEL, "popRules"));
    expectProblem(withPreview({ pointer: POINTER, document: text(incomplete.document) }), /preview: stack previewnet lacks dotns\.popRules/, "shipped missing field");
  });

  // A copy going stale must not break `npm ci` (which builds), including the job that refreshes it.
  test("passes for a copy past its validUntil and expiresAt", async () => {
    const expired = await signedPreview({ ...PREVIEW_MODEL, validUntil: Date.parse("2026-11-01T12:00:00Z") / 1000, expiresAt: Date.parse("2026-11-02T00:00:00Z") / 1000 });
    assert.doesNotThrow(() => assertShippedStacks(withPreview({ pointer: POINTER, document: text(expired.document) })),
      ">> FAIL: shipped dates: the build check must not depend on the date, or every install fails once a copy goes stale");
  });

  test("fails for a copy with no policy entry, and for a missing copy", () => {
    expectProblem({ ...realCopies, mystery: realCopies.preview }, /mystery: has no entry in assets\/stack-policy\.json/, "shipped without policy");
    const { "pcf-devnet": dropped, ...withoutDevnet } = realCopies;
    expectProblem(withoutDevnet, /pcf-devnet: no shipped copy of stack pcf-devnet/, "shipped copy missing");
  });

  // Without a default entry every run without --env or --stack fails with "Unknown environment".
  test("fails for a policy default without an entry", () => {
    expectProblem(realCopies, /default: paseo-next-v3 has no entry in assets\/stack-policy\.json/, "policy default", { ...POLICY, default: "paseo-next-v3" });
  });

  // BigInt(number) silently loses precision above 2^53, so the deposit floor would differ from the file.
  test("fails for a deposit that is not a safe integer", () => {
    expectProblem(realCopies, /preview: registerStorageDeposit 1e\+21 in assets\/stack-policy\.json is not a safe integer/, "policy deposit", policyWith("preview", { registerStorageDeposit: 1e21 }));
    expectProblem(realCopies, /preview: recordStorageDeposit 1\.5 in assets\/stack-policy\.json is not a safe integer/, "policy deposit fraction", policyWith("preview", { recordStorageDeposit: 1.5 }));
  });
});

describe("assertShippedStacksUnexpired (date check outside the build)", () => {
  const { model: PREVIEW_MODEL, generation: PREVIEW_GENERATION } = modelOf("preview");
  const signedPreview = (model) => publish(model, { generation: PREVIEW_GENERATION, secret: SECRET, now: new Date("2026-11-01T00:00:00Z") });
  const shippedPreview = async (model) => ({ preview: { pointer: POINTER, document: text((await signedPreview(model)).document) } });

  test("passes without warnings for copies within their validUntil", async () => {
    const copies = await shippedPreview({ ...PREVIEW_MODEL, validUntil: Date.parse("2026-12-01T00:00:00Z") / 1000 });
    assert.deepEqual(assertShippedStacksUnexpired(copies, LOAD_TIME), [], ">> FAIL: shipped current: a copy within its validUntil must pass without a warning");
  });

  // A stale copy still runs (with a warning), and only the publisher can renew it, so a release must not block on it.
  test("warns for a stale copy without failing", async () => {
    const copies = await shippedPreview({ ...PREVIEW_MODEL, validUntil: Date.parse("2026-11-02T00:00:00Z") / 1000 });
    const warnings = assertShippedStacksUnexpired({ ...realCopies, ...copies }, LOAD_TIME);
    assert.equal(warnings.length, 1, `>> FAIL: shipped stale: a stale copy must produce exactly one warning; got: ${warnings.join(" | ")}`);
    assert.match(warnings[0], /preview .*past its validUntil 2026-11-02T00:00:00\.000Z/, `>> FAIL: shipped stale: the warning must name the copy and the date; got: ${warnings[0]}`);
  });

  test("fails for an expired copy", async () => {
    const copies = await shippedPreview({ ...PREVIEW_MODEL, validUntil: Date.parse("2026-11-01T12:00:00Z") / 1000, expiresAt: Date.parse("2026-11-02T00:00:00Z") / 1000 });
    assert.throws(() => assertShippedStacksUnexpired({ ...realCopies, ...copies }, LOAD_TIME), (error) => {
      assert.match(error.message, /^expired stack copies in \.trinity \(run npx trinity-stack update\):/, ">> FAIL: shipped expired: the date check must fail with the copy list and the fix");
      assert.match(error.message, /preview: expired at 2026-11-02T00:00:00\.000Z/, `>> FAIL: shipped expired: the failure must name the copy and the date; got: ${error.message}`);
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Contract addresses and where they came from
// ---------------------------------------------------------------------------

describe("isValidContractAddress", () => {
  test("accepts checksummed, lowercase and uppercase EVM addresses", () => {
    for (const address of ["0x5Caef84563fc980178e28417414aa65bA32f6B4e", "0x5caef84563fc980178e28417414aa65ba32f6b4e", "0x5CAEF84563FC980178E28417414AA65BA32F6B4E"]) {
      assert.equal(isValidContractAddress(address), true, `>> FAIL: address valid: ${address} must be accepted`);
    }
  });

  test("rejects the zero address, wrong lengths, a missing 0x, non-hex and non-strings", () => {
    for (const address of ["0x" + "0".repeat(40), "0x5Caef84563fc980178e28417414aa65bA32f6B4", "0x5Caef84563fc980178e28417414aa65bA32f6B4e00",
      "5Caef84563fc980178e28417414aa65bA32f6B4e", "0xGGGef84563fc980178e28417414aa65bA32f6B4e", "", null, undefined, 12345]) {
      assert.equal(isValidContractAddress(address), false, `>> FAIL: address invalid: ${String(address)} must be rejected`);
    }
  });
});

describe("validateContractAddresses", () => {
  test("passes for an empty or sparse map of valid addresses", () => {
    assert.doesNotThrow(() => validateContractAddresses({}, "test-env"), ">> FAIL: validate: an empty map must pass");
    assert.doesNotThrow(() => validateContractAddresses({ DOTNS_REGISTRY: "0x8877344A885682523B4613779C95688ed7037BfD" }, "paseo-next-v2"),
      ">> FAIL: validate: a sparse map must pass");
  });

  test("fails naming the contract and environment for a malformed address", () => {
    assert.throws(() => validateContractAddresses({ DOTNS_REGISTRY: "0x" + "0".repeat(40) }, "paseo-next-v2"), /Invalid contract address for DOTNS_REGISTRY in environment paseo-next-v2/,
      ">> FAIL: validate: the zero address must fail naming the contract");
    assert.throws(() => validateContractAddresses({ POP_RULES: "0xdeadbeef" }, "preview"), /Invalid contract address for POP_RULES in environment preview/,
      ">> FAIL: validate: a short address must fail naming the contract");
  });

  test("includes the source when one is passed", () => {
    const custom = buildStack(V1.descriptor, { id: "gamingnet-0011aabb", builtIn: false, source: "file", policy: customStackPolicy(V1.descriptor) });
    assert.throws(() => validateContractAddresses({ POP_RULES: "0xdeadbeef" }, custom.id, { POP_RULES: describeStackOrigin(custom) }),
      /This address came from the descriptor of stack gamingnet-0011aabb \(passed with --stack as a file\)/,
      ">> FAIL: validate: the message must say where the address came from");
  });
});

// A wrong address is the operator's only when it came from a custom stack they passed with --stack
// or from their own contracts option. One from a built-in stack is not theirs and must stay visible
// on the health dashboards. The classifier reads the exact origin wording, so this feeds it the
// real strings.
describe("contract address attribution", () => {
  const failure = (origin) => `No contract deployed at 0xabc (DOTNS_REGISTRAR) env=x. This address came from ${origin}.`;

  test("an address from a built-in stack is not classified as user error, shipped or published", () => {
    const shipped = readShippedStack("paseo-next-v2");
    for (const stack of [shipped, { ...shipped, source: "published" }, { ...shipped, source: "link" }]) {
      assert.equal(classifyDeployError(failure(describeStackOrigin(stack))), "unknown",
        `>> FAIL: attribution built-in (${stack.source}): a bad address in a built-in stack classified as user error, which hides a fleet-wide failure`);
    }
  });

  test("an address from a custom --stack stack or the contracts option is the user's", () => {
    const custom = buildStack(V1.descriptor, { id: "mine-0011aabb", builtIn: false, source: "url", policy: customStackPolicy(V1.descriptor) });
    assert.equal(classifyDeployError(failure(describeStackOrigin(custom))), "user",
      ">> FAIL: attribution custom: an address from the operator's own --stack descriptor is theirs to fix");
    assert.equal(classifyDeployError(failure("the contracts option of DotNS.connect()")), "user",
      ">> FAIL: attribution contracts option: an address the caller passed is theirs to fix");
  });
});
