import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  loadEnvironments,
  deepMergeEnvironments,
  resolveEndpoints,
  listEnvironments,
  formatEnvironmentTable,
  defaultBundledPath,
  DEFAULT_ENV_ID,
  isValidContractAddress,
  validateContractAddresses,
} from "../dist/environments.js";
import * as publicApi from "../dist/index.js";
import { NonRetryableError } from "../dist/errors.js";

describe("default environment", () => {
  test("deploys default to paseo-next-v2", () => {
    assert.equal(DEFAULT_ENV_ID, "paseo-next-v2");
  });

  test("environment helpers are exported from the package root", () => {
    assert.equal(publicApi.loadEnvironments, loadEnvironments);
    assert.equal(publicApi.resolveEndpoints, resolveEndpoints);
    assert.equal(publicApi.DEFAULT_ENV_ID, DEFAULT_ENV_ID);
  });
});

const FIXTURE_DOC = {
  environments: [
    { id: "paseo-next", name: "Paseo Next", network: "testnet", description: "" },
    { id: "paseo-review", name: "Paseo Review", network: "testnet", description: "" },
    { id: "polkadot", name: "Polkadot", network: "mainnet", description: "" },
  ],
  chains: [
    {
      id: "bulletin",
      name: "Bulletin",
      endpoints: {
        "paseo-next": { wss: "wss://bulletin-paseo-next" },
        "paseo-review": { wss: ["wss://bulletin-paseo-review-a", "wss://bulletin-paseo-review-b"] },
      },
    },
    {
      id: "asset-hub",
      name: "Asset Hub",
      endpoints: {
        "paseo-next": { wss: ["wss://ah-paseo-next"], parachainId: 1000 },
        "paseo-review": { wss: ["wss://ah-paseo-review"], parachainId: 1000 },
        "polkadot": { wss: ["wss://ah-polkadot"], parachainId: 1000 },
      },
    },
  ],
};

async function tmpDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("loadEnvironments — uses bundled snapshot", () => {
  test("returns bundled doc when bundledPath resolves", async () => {
    const bundledDir = await tmpDir("env-bundled-asset-");
    const bundledPath = path.join(bundledDir, "environments.json");
    await fs.writeFile(bundledPath, JSON.stringify(FIXTURE_DOC));

    const result = await loadEnvironments({ bundledPath });

    assert.equal(result.source, "bundled");
    assert.equal(result.doc.environments.length, 3);
  });
});

describe("loadEnvironments — missing asset → embedded bundled snapshot", () => {
  test("returns the embedded catalog when the package asset is not readable", async () => {
    const dir = await tmpDir("env-embedded-");
    const result = await loadEnvironments({
      bundledPath: path.join(dir, "no-such.json"),
      warn: () => {},
    });

    assert.equal(result.source, "bundled");
    const resolved = resolveEndpoints(result.doc, DEFAULT_ENV_ID);
    assert.equal(resolved.bulletin[0], "wss://paseo-bulletin-next-rpc.polkadot.io");
    assert.equal(resolved.assetHub[0], "wss://paseo-asset-hub-next-rpc.polkadot.io");
    assert.equal(resolved.nativeToEthRatio, 100000000n);
    assert.equal(typeof resolved.contracts.DOTNS_REGISTRY, "string");
  });
});

describe("resolveEndpoints — happy path", () => {
  test("returns bulletin + assetHub for paseo-next", () => {
    const r = resolveEndpoints(FIXTURE_DOC, "paseo-next");
    assert.deepEqual(r.bulletin, ["wss://bulletin-paseo-next"]);
    assert.deepEqual(r.assetHub, ["wss://ah-paseo-next"]);
    assert.equal(r.network, "testnet");
    assert.equal(r.envName, "Paseo Next");
  });

  test("normalizes wss array form", () => {
    const r = resolveEndpoints(FIXTURE_DOC, "paseo-review");
    assert.equal(r.bulletin.length, 2);
    assert.equal(r.bulletin[0], "wss://bulletin-paseo-review-a");
  });
});

describe("resolveEndpoints — contracts", () => {
  test("passes contracts through when env has contracts set", () => {
    const doc = {
      ...FIXTURE_DOC,
      environments: [
        { id: "paseo-next", name: "Paseo Next", network: "testnet", description: "", contracts: { POP_RULES: "0xabc" } },
        { id: "paseo-review", name: "Paseo Review", network: "testnet", description: "" },
      ],
    };
    const r1 = resolveEndpoints(doc, "paseo-next");
    assert.deepEqual(r1.contracts, { POP_RULES: "0xabc" });

    const r2 = resolveEndpoints(doc, "paseo-review");
    assert.deepEqual(r2.contracts, {});
  });
});

describe("resolveEndpoints — autoAccountMapping", () => {
  test("returns autoAccountMapping: true when env has it set", () => {
    const doc = {
      ...FIXTURE_DOC,
      environments: [
        { id: "paseo-next", name: "Paseo Next", network: "testnet", description: "", autoAccountMapping: true },
        { id: "paseo-review", name: "Paseo Review", network: "testnet", description: "" },
      ],
    };
    const r1 = resolveEndpoints(doc, "paseo-next");
    assert.equal(r1.autoAccountMapping, true);

    const r2 = resolveEndpoints(doc, "paseo-review");
    assert.equal(r2.autoAccountMapping, false);
  });

  test("defaults autoAccountMapping to false when field absent", () => {
    const r = resolveEndpoints(FIXTURE_DOC, "paseo-next");
    assert.equal(r.autoAccountMapping, false);
  });
});

describe("resolveEndpoints — pricing overrides", () => {
  test("returns nativeToEthRatio when env sets it", () => {
    const doc = {
      ...FIXTURE_DOC,
      environments: [
        {
          id: "paseo-next",
          name: "Paseo Next",
          network: "testnet",
          description: "",
          nativeToEthRatio: 100000000,
        },
        { id: "paseo-review", name: "Paseo Review", network: "testnet", description: "" },
      ],
    };

    const r = resolveEndpoints(doc, "paseo-next");
    assert.equal(r.nativeToEthRatio, 100000000n);
  });

  test("defaults nativeToEthRatio to 1_000_000", () => {
    const r = resolveEndpoints(FIXTURE_DOC, "paseo-next");
    assert.equal(r.nativeToEthRatio, 1000000n);
  });
});

describe("resolveEndpoints — mainnet guard", () => {
  test("polkadot has no bulletin endpoint → throws NonRetryableError pointing at environments.json", () => {
    try {
      resolveEndpoints(FIXTURE_DOC, "polkadot");
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof NonRetryableError, `expected NonRetryableError, got ${e?.name}`);
      assert.match(e.message, /Bulletin chain not yet available/);
      assert.match(e.message, /environments\.json/);
    }
  });
});

describe("resolveEndpoints — unknown env", () => {
  test("throws with Levenshtein-1 suggestion", () => {
    try {
      resolveEndpoints(FIXTURE_DOC, "paeo-nxt");
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof NonRetryableError);
      assert.match(e.message, /paseo-next/);
      assert.match(e.message, /Did you mean/);
    }
  });

  test("throws without suggestion when nothing close enough", () => {
    try {
      resolveEndpoints(FIXTURE_DOC, "completelyunrelated");
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(e instanceof NonRetryableError);
      assert.doesNotMatch(e.message, /Did you mean/);
    }
  });
});

describe("listEnvironments + formatEnvironmentTable", () => {
  test("returns one row per environment with hasBulletin set", () => {
    const rows = listEnvironments(FIXTURE_DOC);
    assert.equal(rows.length, 3);
    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    assert.equal(byId["paseo-next"].hasBulletin, true);
    assert.equal(byId["paseo-review"].hasBulletin, true);
    assert.equal(byId["polkadot"].hasBulletin, false);
  });

  test("formatEnvironmentTable renders columns", () => {
    const rows = listEnvironments(FIXTURE_DOC);
    const out = formatEnvironmentTable(rows);
    assert.match(out, /\bID\b/);
    assert.match(out, /paseo-next/);
    assert.match(out, /yes/);
    assert.match(out, /no/);
  });
});

describe("bundled snapshot", () => {
  test("assets/environments.json parses and contains the default env bulletin endpoint", async () => {
    const bundled = JSON.parse(await fs.readFile(defaultBundledPath(), "utf8"));
    assert.ok(Array.isArray(bundled.environments));
    assert.ok(Array.isArray(bundled.chains));
    const env = bundled.environments.find(e => e.id === DEFAULT_ENV_ID);
    assert.ok(env, `bundled snapshot must include ${DEFAULT_ENV_ID}`);
    assert.equal(env.autoAccountMapping, true);
    assert.equal(env.nativeToEthRatio, 100000000);
    assert.equal(typeof env.contracts?.DOTNS_REGISTRY, "string");
    assert.equal(typeof env.contracts?.POP_RULES, "string");
    const bulletin = bundled.chains.find(c => c.id === "bulletin");
    assert.ok(bulletin, "bundled snapshot must include bulletin chain");
    const ep = bulletin.endpoints[DEFAULT_ENV_ID];
    assert.ok(ep, `bundled snapshot must include ${DEFAULT_ENV_ID} bulletin endpoint`);
    const wssArr = Array.isArray(ep.wss) ? ep.wss : [ep.wss];
    assert.ok(wssArr.length > 0 && wssArr[0].startsWith("wss://"));
  });

  test("devnet env carries a valid Publisher contract so --publish is not silently skipped (issue #130)", async () => {
    // The Browse Publisher IS deployed on the devnet Asset Hub, but the env
    // shipped without contracts.PUBLISHER, so the publish gate in deploy.ts
    // took the "not supported on this environment — will be skipped" branch
    // and apps could never be listed in Browse from a devnet deploy. Guard the
    // devnet-family env (id contains "devnet": "devnet" here / "PCF-devnet" in
    // the bulletin-deploy twin) so a future edit can't drop the address again.
    const bundled = JSON.parse(await fs.readFile(defaultBundledPath(), "utf8"));
    const devnet = bundled.environments.find(e => /devnet/i.test(e.id));
    assert.ok(devnet, ">> FAIL: devnet-publisher: bundled snapshot must include a devnet-family env");
    const publisher = devnet.contracts?.PUBLISHER;
    assert.ok(
      isValidContractAddress(publisher),
      `>> FAIL: devnet-publisher: env '${devnet.id}' must define a valid PUBLISHER contract (Browse Publisher is deployed on the devnet Asset Hub); got ${JSON.stringify(publisher)}. Without it, 'pad --publish --env ${devnet.id}' silently skips (issue #130).`,
    );
  });

  test("devnet env carries webGateway=dev-dot.li so the post-deploy link resolves the right network (issue #142)", async () => {
    // dot.li (the default gateway) resolves DotNS names against paseo-next-v2/mainnet.
    // devnet names are only resolvable via the dev-dot.li gateway. Without this field,
    // deploy.ts's browserUrlFor() falls back to the hardcoded dot.li host and the
    // "Check it out here" link loads (HTTP 200) but shows nothing for the just-deployed app.
    const bundled = JSON.parse(await fs.readFile(defaultBundledPath(), "utf8"));
    const devnet = bundled.environments.find(e => /devnet/i.test(e.id));
    assert.ok(devnet, ">> FAIL: devnet-web-gateway: bundled snapshot must include a devnet-family env");
    assert.equal(
      devnet.webGateway,
      "dev-dot.li",
      `>> FAIL: devnet-web-gateway: env '${devnet.id}' must set webGateway to "dev-dot.li"; got ${JSON.stringify(devnet.webGateway)}. Without it the post-deploy link uses the wrong gateway host and resolves the devnet name against the wrong network (issue #142).`,
    );
  });
});

describe("isValidContractAddress", () => {
  test("accepts a valid checksummed EVM address", () => {
    assert.equal(isValidContractAddress("0x5Caef84563fc980178e28417414aa65bA32f6B4e"), true);
  });

  test("accepts a valid lowercase EVM address", () => {
    assert.equal(isValidContractAddress("0x5caef84563fc980178e28417414aa65ba32f6b4e"), true);
  });

  test("accepts a valid uppercase EVM address", () => {
    assert.equal(isValidContractAddress("0x5CAEF84563FC980178E28417414AA65BA32F6B4E"), true);
  });

  test("rejects the all-zeros (zero) address", () => {
    assert.equal(isValidContractAddress("0x" + "0".repeat(40)), false);
  });

  test("rejects an address that is too short", () => {
    assert.equal(isValidContractAddress("0x5Caef84563fc980178e28417414aa65bA32f6B4"), false);
  });

  test("rejects an address that is too long", () => {
    assert.equal(isValidContractAddress("0x5Caef84563fc980178e28417414aa65bA32f6B4e00"), false);
  });

  test("rejects an address without 0x prefix", () => {
    assert.equal(isValidContractAddress("5Caef84563fc980178e28417414aa65bA32f6B4e"), false);
  });

  test("rejects an address with non-hex characters", () => {
    assert.equal(isValidContractAddress("0xGGGef84563fc980178e28417414aa65bA32f6B4e"), false);
  });

  test("rejects an empty string", () => {
    assert.equal(isValidContractAddress(""), false);
  });

  test("rejects a non-string value", () => {
    assert.equal(isValidContractAddress(null), false);
    assert.equal(isValidContractAddress(undefined), false);
    assert.equal(isValidContractAddress(12345), false);
  });
});

describe("validateContractAddresses", () => {
  test("does not throw for an empty contracts map", () => {
    assert.doesNotThrow(() => validateContractAddresses({}, "test-env"));
  });

  test("does not throw for a map with all valid addresses", () => {
    assert.doesNotThrow(() => validateContractAddresses({
      DOTNS_REGISTRY: "0x8877344A885682523B4613779C95688ed7037BfD",
      POP_RULES: "0x2002C1c15b88632Ad01c7770f6EbE1Ca05c8472E",
    }, "paseo-next-v2"));
  });

  test("throws for a zero address", () => {
    assert.throws(
      () => validateContractAddresses({ DOTNS_REGISTRY: "0x" + "0".repeat(40) }, "paseo-next-v2"),
      /Invalid contract address for DOTNS_REGISTRY in environment paseo-next-v2/,
    );
  });

  test("throws for a malformed address (wrong length)", () => {
    assert.throws(
      () => validateContractAddresses({ POP_RULES: "0xdeadbeef" }, "preview"),
      /Invalid contract address for POP_RULES in environment preview/,
    );
  });

  test("throws for a non-hex address", () => {
    assert.throws(
      () => validateContractAddresses({ STORE_FACTORY: "0xGGGef84563fc980178e28417414aa65bA32f6B4e" }, "my-env"),
      /Invalid contract address for STORE_FACTORY in environment my-env/,
    );
  });

  test("error message includes the dotns deployments URL", () => {
    try {
      validateContractAddresses({ BAD: "0xdeadbeef" }, "some-env");
      assert.fail("expected throw");
    } catch (e) {
      assert.match(e.message, /github\.com\/paritytech\/dotns#deployments/);
    }
  });

  test("missing key is tolerated — does not throw for a sparse map", () => {
    // Only DOTNS_REGISTRY is present; POP_RULES is absent. That's fine.
    assert.doesNotThrow(() => validateContractAddresses({
      DOTNS_REGISTRY: "0x8877344A885682523B4613779C95688ed7037BfD",
    }, "paseo-next-v2"));
  });
});

describe("e2eEligible flag", () => {
  const envDoc = JSON.parse(fsSync.readFileSync("assets/environments.json", "utf-8"));

  test("exactly paseo-next-v2 is e2eEligible", () => {
    const eligible = envDoc.environments
      .filter((e) => e.e2eEligible === true)
      .map((e) => e.id)
      .sort();
    assert.deepStrictEqual(eligible, ["paseo-next-v2"]);
  });

  // The protected property is "no env outside the two intended ones runs E2E".
  // An explicit `e2eEligible: false` (e.g. the community `devnet`, #900) satisfies
  // that just as absence does — the flag is opt-in, so anything other than `true`
  // means not-eligible.
  test("no other env is e2eEligible (explicit false is allowed, only true opts in)", () => {
    for (const env of envDoc.environments) {
      if (env.id === "preview" || env.id === "paseo-next-v2") continue;
      assert.notStrictEqual(
        env.e2eEligible,
        true,
        `>> FAIL: e2eEligible-${env.id}: ${env.id} must not be e2e-eligible (opt-in flag; only preview + paseo-next-v2). Got e2eEligible=${env.e2eEligible}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// devnet preset (#112) + summit removal
// ---------------------------------------------------------------------------

describe("devnet environment (Paseo system chains)", () => {
  test("devnet resolves end-to-end from the bundled catalog", async () => {
    const { doc } = await loadEnvironments({ warn: () => {} });
    const resolved = resolveEndpoints(doc, "devnet");

    assert.equal(resolved.network, "testnet", ">> FAIL: devnet-network: devnet must be a testnet");
    // Register-canonical endpoint first (papi failover order from the issue).
    assert.equal(
      resolved.bulletin[0],
      "wss://bulletin-paseo.tservices.es:8443",
      ">> FAIL: devnet-bulletin: register-canonical Bulletin endpoint must resolve first",
    );
    assert.equal(
      resolved.assetHub[0],
      "wss://asset-hub-paseo-rpc.n.dwellir.com",
      ">> FAIL: devnet-assethub: Asset Hub endpoint must resolve",
    );
    assert.equal(
      resolved.ipfs,
      "https://devnet-ipfs.api.polkadotcommunity.foundation",
      ">> FAIL: devnet-ipfs: community IPFS gateway must resolve",
    );
  });

  test("every devnet contract address is well-formed", () => {
    const envDoc = JSON.parse(fsSync.readFileSync("assets/environments.json", "utf-8"));
    const devnet = envDoc.environments.find((e) => e.id === "devnet");
    assert.ok(devnet, ">> FAIL: devnet-present: devnet environment must exist in the catalog");
    for (const [name, addr] of Object.entries(devnet.contracts)) {
      assert.ok(
        isValidContractAddress(addr),
        `>> FAIL: devnet-contract-${name}: ${name}=${addr} is not a valid 0x-address (typo in the pasted deployment?)`,
      );
    }
  });

  test("summit environment is fully removed (env + every chain endpoint)", () => {
    const envDoc = JSON.parse(fsSync.readFileSync("assets/environments.json", "utf-8"));
    assert.ok(
      !envDoc.environments.some((e) => e.id === "summit"),
      ">> FAIL: summit-env-gone: the retired summit environment must not appear in environments[]",
    );
    for (const chain of envDoc.chains) {
      assert.ok(
        !("summit" in chain.endpoints),
        `>> FAIL: summit-endpoint-gone: chain '${chain.id}' still carries a summit endpoint`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// deepMergeEnvironments
// ---------------------------------------------------------------------------

describe("deepMergeEnvironments — by-id merge semantics", () => {
  const BASE = {
    environments: [
      {
        id: "paseo-next",
        name: "Paseo Next",
        network: "testnet",
        contracts: { DOTNS_REGISTRY: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", POP_RULES: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
      },
      { id: "paseo-review", name: "Paseo Review", network: "testnet" },
    ],
    chains: [
      {
        id: "bulletin",
        name: "Bulletin",
        endpoints: {
          "paseo-next": { wss: "wss://old-bulletin-paseo-next" },
          "paseo-review": { wss: "wss://bulletin-paseo-review" },
        },
      },
      {
        id: "asset-hub",
        name: "Asset Hub",
        endpoints: {
          "paseo-next": { wss: "wss://ah-paseo-next" },
          "paseo-review": { wss: "wss://ah-paseo-review" },
        },
      },
    ],
  };

  test("user overrides one env's contract address; other fields fall through", () => {
    const userOverride = {
      environments: [
        {
          id: "paseo-next",
          contracts: { DOTNS_REGISTRY: "0x1111111111111111111111111111111111111111" },
        },
      ],
    };
    const merged = deepMergeEnvironments(BASE, userOverride);
    const env = merged.environments.find(e => e.id === "paseo-next");
    // Overridden field updated.
    assert.equal(env.contracts.DOTNS_REGISTRY, "0x1111111111111111111111111111111111111111");
    // Unspecified contract key falls through from base.
    assert.equal(env.contracts.POP_RULES, "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    // Non-contracts fields from base are untouched.
    assert.equal(env.name, "Paseo Next");
    assert.equal(env.network, "testnet");
    // Unrelated env is untouched.
    const review = merged.environments.find(e => e.id === "paseo-review");
    assert.equal(review.name, "Paseo Review");
  });

  test("user overrides a chain's wss endpoint", () => {
    const userOverride = {
      chains: [
        {
          id: "bulletin",
          name: "Bulletin",
          endpoints: { "paseo-next": { wss: "wss://new-bulletin-paseo-next" } },
        },
      ],
    };
    const merged = deepMergeEnvironments(BASE, userOverride);
    const bulletin = merged.chains.find(c => c.id === "bulletin");
    assert.equal(bulletin.endpoints["paseo-next"].wss, "wss://new-bulletin-paseo-next");
    // Other endpoint not overridden.
    assert.equal(bulletin.endpoints["paseo-review"].wss, "wss://bulletin-paseo-review");
    // Asset-hub chain untouched.
    const ah = merged.chains.find(c => c.id === "asset-hub");
    assert.equal(ah.endpoints["paseo-next"].wss, "wss://ah-paseo-next");
  });

  test("user appends a new environment not in base", () => {
    const userOverride = {
      environments: [
        { id: "local-dev", name: "Local Dev", network: "testnet" },
      ],
    };
    const merged = deepMergeEnvironments(BASE, userOverride);
    assert.equal(merged.environments.length, 3);
    assert.ok(merged.environments.find(e => e.id === "local-dev"), "local-dev must be appended");
    // Original envs preserved.
    assert.ok(merged.environments.find(e => e.id === "paseo-next"));
    assert.ok(merged.environments.find(e => e.id === "paseo-review"));
  });

  test("empty override leaves base unchanged", () => {
    const merged = deepMergeEnvironments(BASE, {});
    assert.equal(merged.environments.length, BASE.environments.length);
    assert.equal(merged.chains.length, BASE.chains.length);
    assert.equal(merged.environments[0].name, "Paseo Next");
  });

  test("source marking: loadEnvironments with userFilePath returns source='file'", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "env-file-src-"));
    const userFile = path.join(dir, "my-envs.json");
    await fs.writeFile(userFile, JSON.stringify({
      environments: [{ id: "paseo-next-v2", contracts: { DOTNS_REGISTRY: "0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" } }],
      chains: [],
    }));

    const warnings = [];
    const result = await loadEnvironments({
      userFilePath: userFile,
      warn: (msg) => warnings.push(msg),
    });

    assert.equal(result.source, "file", "source must be 'file' when user file is loaded");
    assert.ok(
      warnings.some(w => w.includes("user-supplied environment file") && w.includes("NOT validated against chain")),
      "must emit the override banner warning",
    );
  });

  test("loadEnvironments with userFilePath deep-merges: override one contract, bundled fallthrough", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "env-file-merge-"));
    const userFile = path.join(dir, "my-envs.json");
    // Only override DOTNS_REGISTRY for paseo-next-v2.
    await fs.writeFile(userFile, JSON.stringify({
      environments: [
        {
          id: "paseo-next-v2",
          contracts: { DOTNS_REGISTRY: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC" },
        },
      ],
      chains: [],
    }));

    const result = await loadEnvironments({ userFilePath: userFile, warn: () => {} });
    const resolved = resolveEndpoints(result.doc, "paseo-next-v2");
    // Overridden key updated.
    assert.equal(resolved.contracts.DOTNS_REGISTRY, "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    // Other contracts from bundled fall through (POP_RULES must exist from bundled).
    assert.equal(typeof resolved.contracts.POP_RULES, "string", "POP_RULES must fall through from bundled");
    // Endpoints from bundled are untouched.
    assert.ok(resolved.bulletin[0].startsWith("wss://"), "bulletin endpoint falls through from bundled");
  });

  test("loadEnvironments hard-errors when userFilePath points to missing file", async () => {
    await assert.rejects(
      () => loadEnvironments({ userFilePath: "/tmp/does-not-exist-702.json", warn: () => {} }),
      (err) => {
        assert.ok(err instanceof NonRetryableError, "must throw NonRetryableError");
        assert.match(err.message, /--environment-file.*cannot read/);
        return true;
      },
    );
  });

  test("loadEnvironments hard-errors when userFilePath contains invalid JSON", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "env-file-bad-"));
    const userFile = path.join(dir, "bad.json");
    await fs.writeFile(userFile, "not json {{{");

    await assert.rejects(
      () => loadEnvironments({ userFilePath: userFile, warn: () => {} }),
      (err) => {
        assert.ok(err instanceof NonRetryableError, "must throw NonRetryableError");
        assert.match(err.message, /not valid JSON/);
        return true;
      },
    );
  });

  test("non-fatal warning emitted for invalid contract address in user file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "env-file-invalid-addr-"));
    const userFile = path.join(dir, "my-envs.json");
    await fs.writeFile(userFile, JSON.stringify({
      environments: [
        {
          id: "paseo-next-v2",
          contracts: { DOTNS_REGISTRY: "0xdeadbeef" }, // malformed address
        },
      ],
      chains: [],
    }));

    const warnings = [];
    // Must NOT throw — validation is non-fatal.
    const result = await loadEnvironments({ userFilePath: userFile, warn: (msg) => warnings.push(msg) });
    assert.equal(result.source, "file");
    assert.ok(
      warnings.some(w => w.includes("Warning") && w.includes("Invalid contract address")),
      `expected a Warning about invalid contract address, got: ${JSON.stringify(warnings)}`,
    );
  });

  test("deepMergeEnvironments is exported from the package root", () => {
    assert.equal(publicApi.deepMergeEnvironments, deepMergeEnvironments);
  });
});
