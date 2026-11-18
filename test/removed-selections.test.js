// Environment ids, --environment-file, PAD_ENV_FILE, --contract and the deploy()
// options bulletinEndpoints / assetHubEndpoints, which the move to stack descriptors removed,
// fail with a message naming what to use instead, from the CLI and from the library.
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadStack, readShippedStack, RETIRED_SELECTION_ERRORS } from "../dist/stacks.js";
import { deploy, NonRetryableError } from "../dist/deploy.js";
import { publishManifest } from "../dist/manifest/publish.js";
import { createCliTestEnv, setupIsolatedHome, writeLocalStack } from "./helpers/isolated-home.js";

const bin = path.resolve(import.meta.dirname, "../bin/polkadot-app-deploy");

// Each test here checks a guard that stops a run; if the guard regresses, the run continues, so
// the library calls and the spawned CLI use a stack on an unreachable local port, a temp home and
// (for the CLI) a preload that blocks every non-local connection.
const isolation = setupIsolatedHome();
after(() => isolation.restore());
const LOCAL_STACK = writeLocalStack(isolation.tmp);

const REMOVED_ENVS = {
  "paseo-next": "environment 'paseo-next' was retired (its Bulletin chain no longer runs); use --env paseo-next-v2",
  "paseo-review": "environment 'paseo-review' was retired (its Bulletin chain no longer runs); use --env paseo-next-v2",
  kusama: "environment 'kusama' has no Bulletin chain; use --env polkadot or pass a stack with --stack",
  "polkadot-test": "environment 'polkadot-test' has no published stack descriptor yet; pass it with --stack <descriptor file or link>",
  custom: "environment 'custom' was removed; pass a stack descriptor via --stack <descriptor file>",
};
const ENVIRONMENT_FILE_MESSAGE = "--environment-file was removed; pass the network with --stack <descriptor file>";
const CONTRACT_MESSAGE = "--contract was removed; pass a stack descriptor with your contract addresses via --stack <descriptor file>";

const offlineFetch = async () => { throw new TypeError("offline"); };

function runBin(args, extraEnv = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "bd-removed-selection-home-"));
  const site = mkdtempSync(path.join(tmpdir(), "bd-removed-selection-"));
  writeFileSync(path.join(site, "index.html"), "<html></html>");
  return spawnSync(process.execPath, [bin, site, "removedname00", ...args], { encoding: "utf8", timeout: 30000, env: createCliTestEnv(home, extraEnv) });
}

describe("removed environment ids", () => {
  for (const [id, message] of Object.entries(REMOVED_ENVS)) {
    test(`loadStack({ env: "${id}" }) reports the replacement`, async () => {
      await assert.rejects(() => loadStack({ env: id }, { fetch: offlineFetch }), (error) => error.message === message,
        `>> FAIL: removed env ${id}: a library caller must get the replacement, not the generic unknown-environment error`);
      assert.throws(() => readShippedStack(id.toUpperCase()), (error) => error.message === message,
        `>> FAIL: removed env ${id}: the lookup must be case-insensitive like the built-in ids`);
    });

    test(`--env ${id} exits 78 with the replacement`, () => {
      const result = runBin(["--env", id]);
      assert.equal(result.status, 78, `>> FAIL: removed env ${id}: the CLI must exit 78 (not retryable); got ${result.status}`);
      assert.ok(result.stderr.includes(message), `>> FAIL: removed env ${id}: stderr must carry the replacement; got ${result.stderr.trim().split("\n").pop()}`);
    });
  }

  test("an id that was never built in still gets the unknown-environment error", async () => {
    await assert.rejects(() => loadStack({ env: "nonexistent-net" }, { fetch: offlineFetch }), /Unknown environment 'nonexistent-net'/,
      ">> FAIL: removed envs: the table must only catch the removed ids");
  });
});

describe("removed --environment-file", () => {
  test("--environment-file exits 78 naming --stack", () => {
    const result = runBin(["--environment-file", "./envs.json"]);
    assert.equal(result.status, 78, `>> FAIL: --environment-file: the CLI must exit 78 (not retryable); got ${result.status}`);
    assert.ok(result.stderr.includes(ENVIRONMENT_FILE_MESSAGE),
      `>> FAIL: --environment-file: stderr must say it was removed and name --stack; got ${result.stderr.trim().split("\n").pop()}`);
  });

  test("PAD_ENV_FILE exits 78 naming --stack", () => {
    const result = runBin([], { PAD_ENV_FILE: "./envs.json" });
    assert.equal(result.status, 78, `>> FAIL: PAD_ENV_FILE: the CLI must exit 78 (not retryable); got ${result.status}`);
    assert.ok(result.stderr.includes(ENVIRONMENT_FILE_MESSAGE),
      `>> FAIL: PAD_ENV_FILE: stderr must say --environment-file was removed and name --stack; got ${result.stderr.trim().split("\n").pop()}`);
  });

  test("polkadot-app-bootstrap with PAD_ENV_FILE exits 78 naming --stack", () => {
    const home = mkdtempSync(path.join(tmpdir(), "bd-removed-selection-home-"));
    const env = createCliTestEnv(home, { PAD_ENV_FILE: "./envs.json" });
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, "../bin/polkadot-app-bootstrap"), "--stack", env.PAD_STACK], { encoding: "utf8", timeout: 30000, env });
    assert.equal(result.status, 78, `>> FAIL: polkadot-app-bootstrap: a NonRetryableError must exit 78 so callers do not retry it; got ${result.status}`);
    assert.ok(result.stderr.includes(ENVIRONMENT_FILE_MESSAGE),
      `>> FAIL: polkadot-app-bootstrap: stderr must say --environment-file was removed; got ${result.stderr.trim().split("\n").pop()}`);
  });
});

describe("removed --contract", () => {
  test("--contract exits 78 naming --stack", () => {
    const result = runBin(["--contract", "DOTNS_REGISTRY=0x1111111111111111111111111111111111111111"]);
    assert.equal(result.status, 78, `>> FAIL: --contract: the CLI must exit 78 (not retryable); got ${result.status}`);
    assert.ok(result.stderr.includes(CONTRACT_MESSAGE),
      `>> FAIL: --contract: stderr must say it was removed and name --stack; got ${result.stderr.trim().split("\n").pop()}`);
  });
});

const MANIFEST_LOADED = {
  config: { domain: "removedname00.dot", displayName: "Removed", description: "Short description.", icon: { path: "./missing-icon.png", format: "png" }, executables: [] },
  sourcePath: path.join(tmpdir(), "polkadot-app-deploy.config.mjs"),
};

// A library caller written for the pre-stack API gets no type error in JavaScript; without the
// error the option would be dropped and the deploy would go to the stack's chains instead.
describe("removed deploy() / publishManifest() options", () => {
  const removedOptions = {
    contracts: { DOTNS_REGISTRY: "0x1111111111111111111111111111111111111111" },
    bulletinEndpoints: ["ws://127.0.0.1:1"],
    assetHubEndpoints: ["ws://127.0.0.1:1"],
  };
  const isRemoved = (message) => (error) => error instanceof NonRetryableError && error.message === message;
  test("each removed option has a library message with the option and the stack option, not a CLI flag", () => {
    assert.deepEqual(Object.keys(RETIRED_SELECTION_ERRORS.options).sort(), Object.keys(removedOptions).sort(),
      ">> FAIL: retired options: RETIRED_SELECTION_ERRORS.options must list exactly the removed deploy() options");
    for (const [option, message] of Object.entries(RETIRED_SELECTION_ERRORS.options)) {
      assert.ok(message.startsWith(`${option} was removed`) && message.includes('stack: "') && !message.includes("--"),
        `>> FAIL: ${option}: a library caller must see the option they passed and the stack option, not a CLI flag; got: ${message}`);
    }
  });
  for (const [option, value] of Object.entries(removedOptions)) {
    const message = RETIRED_SELECTION_ERRORS.options[option];
    test(`deploy({ ${option} }) rejects with the stack option`, async () => {
      await assert.rejects(() => deploy(new Uint8Array([1]), null, { [option]: value, stack: LOCAL_STACK }), isRemoved(message),
        `>> FAIL: deploy(): ${option} must fail with RETIRED_SELECTION_ERRORS.options.${option}, not be ignored`);
    });
    test(`publishManifest({ ${option} }) rejects with the stack option`, async () => {
      await assert.rejects(() => publishManifest({ [option]: value, stack: LOCAL_STACK, loaded: MANIFEST_LOADED }), isRemoved(message),
        `>> FAIL: publishManifest(): ${option} must fail with RETIRED_SELECTION_ERRORS.options.${option}, not be ignored`);
    });
  }

  test("deploy() and publishManifest() reject PAD_ENV_FILE", async () => {
    const saved = process.env.PAD_ENV_FILE;
    process.env.PAD_ENV_FILE = "./envs.json";
    try {
      await assert.rejects(() => deploy(new Uint8Array([1]), null, { stack: LOCAL_STACK }), isRemoved(ENVIRONMENT_FILE_MESSAGE),
        ">> FAIL: deploy(): PAD_ENV_FILE must fail as removed, not silently deploy to the selected stack");
      await assert.rejects(() => publishManifest({ stack: LOCAL_STACK, loaded: MANIFEST_LOADED }),
        isRemoved(ENVIRONMENT_FILE_MESSAGE),
        ">> FAIL: publishManifest(): PAD_ENV_FILE must fail as removed, not silently publish to the selected stack");
    } finally {
      if (saved === undefined) delete process.env.PAD_ENV_FILE;
      else process.env.PAD_ENV_FILE = saved;
    }
  });
});
