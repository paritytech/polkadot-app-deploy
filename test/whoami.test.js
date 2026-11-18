// test/whoami.test.js — unit tests for src/commands/whoami.ts (formatWhoami + runWhoami)
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupStaleSessionHome } from "./helpers/stale-session-home.js";
import { startFakeChain, withChainEndpoint } from "./helpers/fake-chain.js";
import { createCliTestEnv } from "./helpers/isolated-home.js";

// Top-level imports (module scope — not inside describe/async describe)
const { formatWhoami, runWhoami } = await import("../dist/commands/whoami.js");
// Session files are namespaced by the dApp id; derive the fixture's on-disk name
// from it so this stays correct across identity renames (e.g. dot-cli → polkadot-app-deploy).
const { DOT_DAPP_ID } = await import("../dist/auth-config.js");
const { readShippedStack } = await import("../dist/stacks.js");

describe("formatWhoami", () => {
    test("null → not-logged-in message", () => {
        const out = formatWhoami(null);
        assert.match(out, /not logged in/i, ">> FAIL: whoami: null should say not logged in");
        assert.match(out, /login/i, ">> FAIL: whoami: null should mention login command");
    });

    test("addresses → shows product address", () => {
        const addresses = {
            rootAddress: "5RootXXX",
            productAddress: "5ProdXXX",
            productH160: "0xdeadbeef",
        };
        const out = formatWhoami(addresses);
        assert.ok(out.includes("5ProdXXX"), ">> FAIL: whoami: addresses should include product address");
        assert.ok(out.includes("5RootXXX"), ">> FAIL: whoami: addresses should include root address");
        assert.ok(out.includes("0xdeadbeef"), ">> FAIL: whoami: addresses should include H160 address");
    });
});

describe("runWhoami — stale v0.7 session detection", () => {
    // Drive runWhoami with a real stale blob at a fake HOME so:
    //   hasPersistedSession()=true (file exists) AND
    //   getSessionSigner()=null (V2 codec returns [] for the stale v0.7 blob).
    // waitForSessions times out in 3 s — acceptable for a real-path behaviour test.

    let errOutput = "";
    let logOutput = "";
    const origErr = console.error;
    const origLog = console.log;
    const origHome = process.env.HOME;

    beforeEach(async () => {
        // Set up a fake HOME containing the v0.7 session fixture.
        const fakeHome = await setupStaleSessionHome(DOT_DAPP_ID, "bd-whoami-stale-");
        process.env.HOME = fakeHome;

        errOutput = "";
        logOutput = "";
        console.error = (...args) => { errOutput += args.map(String).join(" ") + "\n"; };
        console.log = (...args) => { logOutput += args.map(String).join(" ") + "\n"; };
    });

    afterEach(() => {
        process.env.HOME = origHome;
        console.error = origErr;
        console.log = origLog;
    });

    test("stale v0.7 session blob → user gets re-pair instructions, not silent miss", async () => {
        // Drives the real adapter with a stale blob. waitForSessions
        // times out in 3 s because the V2 codec returns [] for the v0.7 blob;
        // runWhoami must then emit the re-pair message, not silently print "Not logged in".
        // The People chain is a local fake reporting the stack's genesis, so the check passes offline.
        const shipped = readShippedStack("paseo-next-v2");
        const people = await startFakeChain(shipped.chains.People.genesisHash);
        try {
            await runWhoami(async () => withChainEndpoint(shipped, "People", people.url));
        } finally {
            await people.close();
        }

        const combined = logOutput + errOutput;
        assert.match(
            combined,
            /Stored login session could not be read[\s\S]*logout[\s\S]*login/,
            ">> FAIL: stale v0.7 session: user must get re-pair instructions, not a silent miss or decode trace",
        );
    });
});

// "Not logged in" is the common answer and must stay instant and offline: no descriptor fetch,
// so an unreachable network or --stack URL does not delay or break it.
describe("runWhoami without a session", () => {
    test("does not load the stack or fetch anything", async () => {
        const home = mkdtempSync(join(tmpdir(), "bd-whoami-none-"));
        const saved = { home: process.env.HOME, fetch: globalThis.fetch, log: console.log };
        let fetches = 0;
        let loads = 0;
        let logOutput = "";
        process.env.HOME = home;
        globalThis.fetch = async () => { fetches += 1; throw new Error("unreachable"); };
        console.log = (...args) => { logOutput += args.map(String).join(" ") + "\n"; };
        try {
            await runWhoami(async () => { loads += 1; return readShippedStack("paseo-next-v2"); });
        } finally {
            process.env.HOME = saved.home;
            globalThis.fetch = saved.fetch;
            console.log = saved.log;
            rmSync(home, { recursive: true, force: true });
        }
        assert.equal(loads, 0, ">> FAIL: whoami without a session: must not load the stack");
        assert.equal(fetches, 0, ">> FAIL: whoami without a session: must not fetch anything");
        assert.match(logOutput, /Not logged in/, ">> FAIL: whoami without a session: must say not logged in");
    });

    test("CLI: an unreachable --stack URL still answers not logged in", () => {
        const home = mkdtempSync(join(tmpdir(), "bd-whoami-cli-"));
        try {
            const result = spawnSync(process.execPath, [new URL("../bin/polkadot-app-deploy", import.meta.url).pathname, "whoami", "--stack", "http://127.0.0.1:9/never.json"], {
                encoding: "utf8",
                env: createCliTestEnv(home),
                timeout: 60_000,
            });
            assert.equal(result.status, 0, `>> FAIL: whoami CLI without a session: must exit 0 without loading the stack; got ${result.status}: ${result.stderr}`);
            assert.match(result.stdout, /Not logged in/, ">> FAIL: whoami CLI without a session: must say not logged in");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });
});
