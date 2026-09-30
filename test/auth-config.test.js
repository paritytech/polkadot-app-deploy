// test/auth-config.test.js — unit tests for src/auth-config.ts
// node:test (not vitest) — consistent with the rest of bulletin-deploy's test suite.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Top-level import — module load before any describe/test bodies run.
const { hasPersistedSession, DOT_DAPP_ID } = await import("../dist/auth-config.js");

// ── hasPersistedSession — regression lock for the 0.8.6 V2 filename rename ──

describe("hasPersistedSession", () => {
    // os.homedir() honours $HOME on POSIX (macOS/Linux), so pointing $HOME at a
    // temp dir redirects the probe without touching the real ~/.polkadot-apps.
    const origHome = process.env.HOME;
    let appsDir = "";

    beforeEach(async () => {
        const fakeHome = await mkdtemp(join(tmpdir(), "bd-auth-cfg-"));
        appsDir = join(fakeHome, ".polkadot-apps");
        await mkdir(appsDir, { recursive: true });
        process.env.HOME = fakeHome;
    });

    afterEach(() => {
        process.env.HOME = origHome;
    });

    test("false when ~/.polkadot-apps is empty", () => {
        assert.equal(
            hasPersistedSession(),
            false,
            ">> FAIL: hasPersistedSession must detect the 0.8.6 _SsoSessionsV2 filename, not just the old _SsoSessions (regression: deploy saw 'no session' → Alice fallback)",
        );
    });

    test("false when only unrelated files exist", async () => {
        await writeFile(join(appsDir, "unrelated.json"), "{}");
        await writeFile(join(appsDir, "dot-cli_OtherFile.json"), "{}");
        assert.equal(
            hasPersistedSession(),
            false,
            ">> FAIL: hasPersistedSession must detect the 0.8.6 _SsoSessionsV2 filename, not just the old _SsoSessions (regression: deploy saw 'no session' → Alice fallback)",
        );
    });

    test("true for V1 filename (<appId>_SsoSessions.json — 0.8.5 and earlier)", async () => {
        await writeFile(join(appsDir, `${DOT_DAPP_ID}_SsoSessions.json`), "{}");
        assert.equal(
            hasPersistedSession(),
            true,
            ">> FAIL: hasPersistedSession must detect the 0.8.6 _SsoSessionsV2 filename, not just the old _SsoSessions (regression: deploy saw 'no session' → Alice fallback)",
        );
    });

    test("true for V2 filename (<appId>_SsoSessionsV2.json — 0.8.6+)", async () => {
        await writeFile(join(appsDir, `${DOT_DAPP_ID}_SsoSessionsV2.json`), "{}");
        assert.equal(
            hasPersistedSession(),
            true,
            ">> FAIL: hasPersistedSession must detect the 0.8.6 _SsoSessionsV2 filename, not just the old _SsoSessions (regression: deploy saw 'no session' → Alice fallback)",
        );
    });

    test("true when both V1 and V2 files coexist", async () => {
        await writeFile(join(appsDir, `${DOT_DAPP_ID}_SsoSessions.json`), "{}");
        await writeFile(join(appsDir, `${DOT_DAPP_ID}_SsoSessionsV2.json`), "{}");
        assert.equal(
            hasPersistedSession(),
            true,
            ">> FAIL: hasPersistedSession must detect the 0.8.6 _SsoSessionsV2 filename, not just the old _SsoSessions (regression: deploy saw 'no session' → Alice fallback)",
        );
    });
});

// ── Inline fixture doc (avoids loading environments.json from disk) ──────────
const FIXTURE_DOC = {
    environments: [{ id: "paseo-next-v2", tld: "paseo" }],
    chains: [
        {
            id: "people",
            name: "People",
            endpoints: {
                "paseo-next-v2": {
                    wss: "wss://paseo-people-next-system-rpc.polkadot.io",
                    parachainId: 1502,
                },
                "multi-env": {
                    wss: [
                        "wss://rpc1.example.com",
                        "wss://rpc2.example.com",
                    ],
                    parachainId: 9999,
                },
            },
        },
    ],
};

describe("buildAuthConfig", async () => {
    const { buildAuthConfig } = await import("../dist/auth-config.js");

    test("paseo-next-v2 → expected const fields + people endpoint", () => {
        const config = buildAuthConfig(FIXTURE_DOC, "paseo-next-v2");
        assert.equal(config.dappId, "polkadot-app-deploy", ">> FAIL: auth-config: dappId mismatch");
        assert.equal(config.productId, "polkadot-app-deploy.paseo", ">> FAIL: auth-config: productId must carry the env's TLD (RFC-0022)");
        assert.equal(config.derivationIndex, 0, ">> FAIL: auth-config: derivationIndex mismatch");
        assert.equal(config.hostName, "polkadot-app-deploy", ">> FAIL: buildAuthConfig: hostName must be the wallet-facing app name (unified identity)");
        assert.ok(!("metadataUrl" in config), ">> FAIL: buildAuthConfig: metadataUrl must be gone — v0.8 removed the wallet-fetched metadata document");
        assert.ok(typeof config.hostVersion === "string" && config.hostVersion.length > 0, ">> FAIL: buildAuthConfig: hostVersion must be a non-empty string");
        assert.deepEqual(
            config.peopleEndpoints,
            ["wss://paseo-people-next-system-rpc.polkadot.io"],
            ">> FAIL: auth-config: paseo-next-v2 people endpoint mismatch",
        );
    });

    test("env without a tld → productId uses the default .dot TLD", () => {
        const config = buildAuthConfig(FIXTURE_DOC, "multi-env");
        assert.equal(config.productId, "polkadot-app-deploy.dot",
            ">> FAIL: auth-config: an env with no tld must fall back to .dot, like DotNS names");
    });

    test("env without a tld → productId uses the People chain's suffix when given", () => {
        assert.equal(buildAuthConfig(FIXTURE_DOC, "multi-env", "testnet").productId, "polkadot-app-deploy.testnet",
            ">> FAIL: auth-config: the chain's NetworkSuffix must fill in for a missing tld");
        assert.equal(buildAuthConfig(FIXTURE_DOC, "paseo-next-v2", "testnet").productId, "polkadot-app-deploy.paseo",
            ">> FAIL: auth-config: an env's own tld must win over the chain suffix");
    });

    test("bundled environments give the TLD each phone network reports", async () => {
        // The phone reads NetworkSuffix.NetworkSuffix from its People chain ("paseo" on
        // paseo-next-v2, "dot" on devnet's People chain) and Android drops
        // ProductSubtreeRequest when the product id's TLD differs.
        const { readFile } = await import("node:fs/promises");
        const doc = JSON.parse(await readFile(new URL("../assets/environments.json", import.meta.url), "utf8"));
        assert.equal(buildAuthConfig(doc, "paseo-next-v2").productId, "polkadot-app-deploy.paseo",
            ">> FAIL: auth-config: paseo-next-v2 product id must end in .paseo");
        assert.equal(buildAuthConfig(doc, "devnet").productId, "polkadot-app-deploy.dot",
            ">> FAIL: auth-config: devnet has no tld, so its fallback must match its chain's .dot");
    });

    test("string[] wss → peopleEndpoints is array", () => {
        const config = buildAuthConfig(FIXTURE_DOC, "multi-env");
        assert.deepEqual(
            config.peopleEndpoints,
            ["wss://rpc1.example.com", "wss://rpc2.example.com"],
            ">> FAIL: auth-config: multi-wss endpoint array mismatch",
        );
    });

    test("throws when people chain missing from doc", () => {
        const emptyDoc = { environments: [], chains: [] };
        assert.throws(
            () => buildAuthConfig(emptyDoc, "paseo-next-v2"),
            /people/i,
            ">> FAIL: auth-config: should throw when no people chain",
        );
    });

    test("throws when env has no people endpoint", () => {
        const noEndpointDoc = {
            environments: [],
            chains: [
                {
                    id: "people",
                    name: "People",
                    endpoints: {},
                },
            ],
        };
        assert.throws(
            () => buildAuthConfig(noEndpointDoc, "paseo-next-v2"),
            /people/i,
            ">> FAIL: auth-config: should throw when env has no people endpoint",
        );
    });
});

describe("readNetworkSuffix", async () => {
    const { readNetworkSuffix } = await import("../dist/auth-config.js");
    const { WebSocketServer } = await import("ws");

    async function withStorageServer(result, fn) {
        const server = new WebSocketServer({ port: 0 });
        await new Promise((r) => server.once("listening", r));
        server.on("connection", (ws) => ws.on("message", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))));
        try {
            return await fn(`ws://127.0.0.1:${server.address().port}`);
        } finally {
            await new Promise((r) => server.close(r));
        }
    }

    test("decodes the SCALE string the People chain stores", async () => {
        // "testnet" as stored on previewnet: compact length 7 (0x1c) + bytes.
        const suffix = await withStorageServer("0x1c746573746e6574", (url) => readNetworkSuffix([url]));
        assert.equal(suffix, "testnet", ">> FAIL: readNetworkSuffix must decode the stored suffix");
    });

    test("null when the chain has no suffix", async () => {
        const suffix = await withStorageServer(null, (url) => readNetworkSuffix([url]));
        assert.equal(suffix, null, ">> FAIL: readNetworkSuffix must return null when NetworkSuffix is unset");
    });
});

describe("resolveBulletinEndpoints", async () => {
    const { resolveBulletinEndpoints } = await import("../dist/auth-config.js");
    const doc = {
        environments: [],
        chains: [
            {
                id: "bulletin",
                name: "Bulletin",
                endpoints: {
                    "paseo-next-v2": { wss: "wss://paseo-bulletin-next-rpc.polkadot.io" },
                    "paseo-next": { wss: "wss://paseo-bulletin-rpc.polkadot.io" },
                    "multi-env": { wss: ["wss://b1.example.com", "wss://b2.example.com"] },
                },
            },
        ],
    };

    test("resolves the SELECTED env's bulletin endpoint (the bug: must not default to paseo-next)", () => {
        assert.deepEqual(
            resolveBulletinEndpoints(doc, "paseo-next-v2"),
            ["wss://paseo-bulletin-next-rpc.polkadot.io"],
            ">> FAIL: auth-config/resolveBulletinEndpoints: paseo-next-v2 must resolve to paseo-bulletin-next-rpc, not the paseo-next default",
        );
    });

    test("normalizes string[] wss to array", () => {
        assert.deepEqual(
            resolveBulletinEndpoints(doc, "multi-env"),
            ["wss://b1.example.com", "wss://b2.example.com"],
            ">> FAIL: auth-config/resolveBulletinEndpoints: multi-wss must pass through as array",
        );
    });

    test("returns null for an unknown env (caller falls back to default)", () => {
        assert.equal(
            resolveBulletinEndpoints(doc, "nope"),
            null,
            ">> FAIL: auth-config/resolveBulletinEndpoints: unknown env must return null",
        );
    });

    test("returns null when no bulletin chain in doc", () => {
        assert.equal(
            resolveBulletinEndpoints({ environments: [], chains: [] }, "paseo-next-v2"),
            null,
            ">> FAIL: auth-config/resolveBulletinEndpoints: missing bulletin chain must return null",
        );
    });
});
