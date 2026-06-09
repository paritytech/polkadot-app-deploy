// test/whoami.test.js — unit tests for src/commands/whoami.ts (formatWhoami + runWhoami)
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const FIXTURE_SESSION = fileURLToPath(
    new URL("./fixtures/v07-session/dot-cli_SsoSessions.json", import.meta.url),
);

// Top-level imports (module scope — not inside describe/async describe)
const { formatWhoami, runWhoami } = await import("../dist/commands/whoami.js");
// Session files are namespaced by the dApp id; derive the fixture's on-disk name
// from it so this stays correct across identity renames (e.g. dot-cli → polkadot-app-deploy).
const { DOT_DAPP_ID } = await import("../dist/auth-config.js");

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
        const fakeHome = await mkdtemp(join(tmpdir(), "bd-whoami-stale-"));
        const appsDir = join(fakeHome, ".polkadot-apps");
        await mkdir(appsDir, { recursive: true });
        await copyFile(FIXTURE_SESSION, join(appsDir, `${DOT_DAPP_ID}_SsoSessions.json`));
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
        await runWhoami("paseo-next-v2");

        const combined = logOutput + errOutput;
        assert.match(
            combined,
            /Stored login session could not be read[\s\S]*logout[\s\S]*login/,
            ">> FAIL: stale v0.7 session: user must get re-pair instructions, not a silent miss or decode trace",
        );
    });
});
