// test/auth-config.test.js — unit tests for src/auth-config.ts
// node:test (not vitest) — consistent with the rest of bulletin-deploy's test suite.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startFakeChain, withChainEndpoint } from "./helpers/fake-chain.js";
import { Storage, str } from "@polkadot-api/substrate-bindings";

// Top-level import — module load before any describe/test bodies run.
const { hasPersistedSession, DOT_DAPP_ID, buildAuthConfig, getAuthClient, assertPeopleMatchesStack } = await import("../dist/auth-config.js");
const { readShippedStack, buildStack, customStackPolicy, BUILT_IN_STACK_IDS } = await import("../dist/stacks.js");

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

describe("buildAuthConfig", () => {
    test("paseo-next-v2 → expected const fields + the stack's People endpoints", () => {
        const stack = readShippedStack("paseo-next-v2");
        const config = buildAuthConfig(stack);
        assert.equal(config.dappId, "polkadot-app-deploy", ">> FAIL: auth-config: dappId mismatch");
        assert.equal(config.productId, `polkadot-app-deploy.${stack.tld}`, ">> FAIL: auth-config: productId must carry the stack's TLD (RFC-0022)");
        assert.equal(config.derivationIndex, 0, ">> FAIL: auth-config: derivationIndex mismatch");
        assert.equal(config.hostName, "polkadot-app-deploy", ">> FAIL: buildAuthConfig: hostName must be the wallet-facing app name (unified identity)");
        assert.ok(!("metadataUrl" in config), ">> FAIL: buildAuthConfig: metadataUrl must be gone — v0.8 removed the wallet-fetched metadata document");
        assert.ok(typeof config.hostVersion === "string" && config.hostVersion.length > 0, ">> FAIL: buildAuthConfig: hostVersion must be a non-empty string");
        assert.deepEqual(config.peopleEndpoints, stack.chains.People.rpc,
            ">> FAIL: auth-config: paseo-next-v2 people endpoints must be the descriptor's People rpc list");
    });

    // The phone reads NetworkSuffix.NetworkSuffix from its People chain and Android drops
    // ProductSubtreeRequest when the product id's TLD differs. Each built-in descriptor's tld
    // equals its People chain's NetworkSuffix, so the product id ends in that tld.
    test("every built-in stack gives the product id its descriptor's tld", () => {
        for (const id of BUILT_IN_STACK_IDS) {
            const stack = readShippedStack(id);
            assert.equal(buildAuthConfig(stack).productId, `polkadot-app-deploy.${stack.descriptor.tld}`,
                `>> FAIL: auth-config: ${id} product id must end in its descriptor tld .${stack.descriptor.tld}`);
        }
    });

    test("a multi-endpoint People chain passes every endpoint through", () => {
        const stack = readShippedStack("pcf-devnet");
        assert.ok(stack.chains.People.rpc.length > 1, ">> FAIL: auth-config: fixture assumption broken, pcf-devnet lists one People endpoint");
        assert.deepEqual(buildAuthConfig(stack).peopleEndpoints, stack.chains.People.rpc,
            ">> FAIL: auth-config: every People endpoint must be passed to the auth client for failover");
    });

    // A stack gets to buildAuthConfig only after buildStack accepted it, so a missing People
    // chain fails there, naming the chain.
    test("a descriptor without a People chain is rejected before any auth config is built", () => {
        const { descriptor } = readShippedStack("paseo-next-v2");
        const withoutPeople = { ...descriptor, chains: descriptor.chains.filter((chain) => chain.role !== "People") };
        assert.throws(
            () => buildStack(withoutPeople, { id: "x", builtIn: false, source: "file", policy: customStackPolicy(withoutPeople) }),
            /lacks chain People/,
            ">> FAIL: auth-config: a stack without a People chain must fail naming the chain",
        );
    });
});

describe("getAuthClient", () => {
    // logout, whoami and transfer build their client through getAuthClient; reading People there
    // would make local logout cleanup depend on a reachable chain.
    test("does not read the People chain", async () => {
        const shipped = readShippedStack("paseo-next-v2");
        const people = await startFakeChain("0x" + "ab".repeat(32));
        try {
            await getAuthClient(withChainEndpoint(shipped, "People", people.url));
            assert.equal(people.genesisReads, 0, ">> FAIL: getAuthClient: building the client must not read the People chain");
        } finally {
            await people.close();
        }
    });
});

describe("assertPeopleMatchesStack", () => {
    const suffixKey = Storage("NetworkSuffix")("NetworkSuffix").enc();
    const encodeSuffix = (suffix) => "0x" + Buffer.from(str.enc(suffix)).toString("hex");

    test("fails before pairing when the People endpoint reports another chain's genesis", async () => {
        const shipped = readShippedStack("paseo-next-v2");
        const people = await startFakeChain("0x" + "ab".repeat(32));
        try {
            await assert.rejects(
                () => assertPeopleMatchesStack(withChainEndpoint(shipped, "People", people.url)),
                (error) => error.name === "GenesisMismatchError" && /People at .* has genesis hash 0xabab/.test(error.message),
                ">> FAIL: assertPeopleMatchesStack: a People endpoint on another chain must fail with GenesisMismatchError, not pair against it",
            );
        } finally {
            await people.close();
        }
    });

    // Android drops a ProductSubtreeRequest whose product id suffix differs from the People
    // chain's NetworkSuffix, so a mismatch fails before pairing instead of hanging there.
    test("fails naming both values when the People chain's NetworkSuffix differs from the tld", async () => {
        const shipped = readShippedStack("paseo-next-v2");
        const people = await startFakeChain(shipped.chains.People.genesisHash, {
            storage: { [suffixKey]: encodeSuffix("othernet") },
        });
        try {
            await assert.rejects(
                () => assertPeopleMatchesStack(withChainEndpoint(shipped, "People", people.url)),
                (error) => error.name === "NonRetryableError"
                    && error.message.includes(`'${shipped.tld}'`) && error.message.includes("'othernet'"),
                ">> FAIL: assertPeopleMatchesStack: a NetworkSuffix other than the stack tld must fail naming both values",
            );
        } finally {
            await people.close();
        }
    });

    test("passes when the People chain's NetworkSuffix equals the tld", async () => {
        const shipped = readShippedStack("paseo-next-v2");
        const people = await startFakeChain(shipped.chains.People.genesisHash, {
            storage: { [suffixKey]: encodeSuffix(shipped.tld) },
        });
        try {
            await assertPeopleMatchesStack(withChainEndpoint(shipped, "People", people.url));
            assert.equal(people.genesisReads, 1, ">> FAIL: assertPeopleMatchesStack: the genesis hash must be checked once");
        } finally {
            await people.close();
        }
    });
});

describe("runLogout", () => {
    const origHome = process.env.HOME;
    afterEach(() => {
        process.env.HOME = origHome;
    });

    // A user must be able to sign out locally while the People chain is down.
    test("clears local session storage when People is unreachable", { timeout: 30_000 }, async () => {
        const fakeHome = await mkdtemp(join(tmpdir(), "bd-logout-"));
        const appsDir = join(fakeHome, ".polkadot-apps");
        await mkdir(appsDir, { recursive: true });
        const allowanceFile = `${DOT_DAPP_ID}.paseo_AllowanceKeys.json`;
        await writeFile(join(appsDir, allowanceFile), "{}");
        process.env.HOME = fakeHome;
        const { runLogout } = await import("../dist/commands/logout.js");
        const shipped = readShippedStack("paseo-next-v2");
        await runLogout(withChainEndpoint(shipped, "People", "ws://127.0.0.1:1")).catch(() => {});
        assert.ok(!(await readdir(appsDir)).includes(allowanceFile),
            ">> FAIL: runLogout: local session files must be cleared even when People is unreachable");
    });
});
