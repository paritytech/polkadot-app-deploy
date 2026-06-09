// test/login.test.js — unit tests for src/commands/login.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";

// Top-level import — consistent with auth-config.test.js pattern.
const { bulletinAuthSummary, formatAllocationSummary, withTimeout } = await import("../dist/commands/login.js");

describe("bulletinAuthSummary", () => {
    test("authorized → success message with block number, isWarning=false", () => {
        const r = bulletinAuthSummary(true, 12345);
        assert.equal(r.isWarning, false, ">> FAIL: login/bulletinAuthSummary: authorized=true must have isWarning=false");
        assert.ok(
            r.message.includes("12345"),
            ">> FAIL: login/bulletinAuthSummary: authorized=true must include expiration block in message",
        );
    });

    test("timeout (authorized=false) → soft-warning message, isWarning=true, no exit-1", () => {
        // This is the key regression: before the fix, timeout → process.exit(1).
        // The pure helper must signal isWarning=true (caller uses console.log, not exit).
        const r = bulletinAuthSummary(false);
        assert.equal(
            r.isWarning,
            true,
            ">> FAIL: login/bulletinAuthSummary: on-chain timeout must be isWarning=true (soft-warning, not exit-1) — session is valid, deploy re-probes",
        );
        assert.ok(
            r.message.includes("180s"),
            ">> FAIL: login/bulletinAuthSummary: timeout message must mention the 180s bound (default timeoutSeconds=180)",
        );
        assert.ok(
            /pool/i.test(r.message),
            ">> FAIL: login/bulletinAuthSummary: timeout message must mention pool fallback",
        );
    });
});

describe("summarizeLogin", async () => {
    const { summarizeLogin } = await import("../dist/commands/login.js");

    test("shows product address and slot address on success", () => {
        const out = summarizeLogin("5ProdXXX", "5SlotYYY");
        assert.ok(out.includes("5ProdXXX"), ">> FAIL: login: summarizeLogin should include product address");
        assert.ok(out.includes("5SlotYYY"), ">> FAIL: login: summarizeLogin should include slot address");
        assert.ok(out.includes("✓"), ">> FAIL: login: summarizeLogin should confirm slot with checkmark");
    });

    test("shows fallback message when slot address is null", () => {
        const out = summarizeLogin("5Addr", null);
        assert.ok(out.includes("5Addr"), ">> FAIL: login: summarizeLogin with null slot should include address");
        assert.ok(
            out.toLowerCase().includes("pool") || out.toLowerCase().includes("not allocated"),
            ">> FAIL: login: summarizeLogin with null slot should warn about pool fallback",
        );
    });
});

describe("formatAllocationSummary", () => {
    const granted = [{ tag: "BulletInAllowance", value: undefined }];
    const rejected = [{ tag: "StatementStoreAllowance", value: undefined }];
    const unavailable = [{ tag: "SmartContractAllowance", value: 0 }];

    test("all granted → lines with ✓ prefix", () => {
        const out = formatAllocationSummary({ granted, rejected: [], unavailable: [] });
        assert.ok(
            out.includes("✓") && out.includes("BulletInAllowance"),
            ">> FAIL: login/formatAllocationSummary: granted resource must appear with ✓",
        );
        assert.ok(
            !out.includes("✗") && !out.includes("~"),
            ">> FAIL: login/formatAllocationSummary: no rejected/unavailable markers for all-granted",
        );
    });

    test("rejected resource → line with ✗ prefix and fallback note", () => {
        const out = formatAllocationSummary({ granted: [], rejected, unavailable: [] });
        assert.ok(
            out.includes("✗") && out.includes("StatementStoreAllowance"),
            ">> FAIL: login/formatAllocationSummary: rejected resource must appear with ✗",
        );
        assert.ok(
            /fall back/i.test(out),
            ">> FAIL: login/formatAllocationSummary: rejected line must mention fallback",
        );
    });

    test("unavailable resource → line with ~ prefix and re-pair note", () => {
        const out = formatAllocationSummary({ granted: [], rejected: [], unavailable });
        assert.ok(
            out.includes("~") && out.includes("SmartContractAllowance"),
            ">> FAIL: login/formatAllocationSummary: unavailable resource must appear with ~",
        );
        assert.ok(
            /re-pair/i.test(out),
            ">> FAIL: login/formatAllocationSummary: unavailable line must mention re-pair",
        );
    });

    test("all empty → empty string (no output when nothing to report)", () => {
        const out = formatAllocationSummary({ granted: [], rejected: [], unavailable: [] });
        assert.strictEqual(
            out,
            "",
            ">> FAIL: login/formatAllocationSummary: empty summary must return empty string",
        );
    });

    test("mixed outcomes → all three sections present", () => {
        const out = formatAllocationSummary({ granted, rejected, unavailable });
        assert.ok(
            out.includes("✓") && out.includes("✗") && out.includes("~"),
            ">> FAIL: login/formatAllocationSummary: mixed summary must contain all three markers",
        );
    });
});

describe("withTimeout", () => {
    test("resolves with the promise value when the promise wins", async () => {
        const v = await withTimeout(Promise.resolve("ok"), 10_000, "should not fire");
        assert.strictEqual(v, "ok", ">> FAIL: login/withTimeout: must resolve with the inner promise's value");
    });

    test("rejects with the message when the timeout wins", async () => {
        await assert.rejects(
            () => withTimeout(new Promise(() => {}), 10, "timed out msg"),
            /timed out msg/,
            ">> FAIL: login/withTimeout: must reject with the timeout message when the promise is slower",
        );
    });

    test("clears the timer on resolve — no late unhandledRejection after the promise wins", async () => {
        // The bug this guards: a bare Promise.race leaves the loser timer armed,
        // which rejects an un-awaited promise after the winner settled → in login
        // that surfaces as an unhandledRejection → fatal exit(1) after success.
        const seen = [];
        const onRej = (e) => seen.push(e);
        process.on("unhandledRejection", onRej);
        try {
            const v = await withTimeout(Promise.resolve("done"), 10, "should be cleared");
            assert.strictEqual(v, "done");
            // Wait well past the 10ms timeout: if the timer were not cleared it would
            // fire here and reject an orphan promise.
            await new Promise((r) => setTimeout(r, 40));
            assert.strictEqual(
                seen.length, 0,
                ">> FAIL: login/withTimeout: timer not cleared — a late rejection fired after the promise resolved",
            );
        } finally {
            process.removeListener("unhandledRejection", onRej);
        }
    });
});

describe("createSlotAccountSigner + BULLETIN_RESOURCE exports", async () => {
    const { createSlotAccountSigner, BULLETIN_RESOURCE } = await import("../dist/auth/index.js");

    test("createSlotAccountSigner is exported as a function", () => {
        assert.strictEqual(
            typeof createSlotAccountSigner,
            "function",
            ">> FAIL: auth/createSlotAccountSigner: must be exported as a function from dist/auth/index.js",
        );
    });

    test("BULLETIN_RESOURCE is { tag: 'BulletInAllowance', value: undefined }", () => {
        assert.deepStrictEqual(
            BULLETIN_RESOURCE,
            { tag: "BulletInAllowance", value: undefined },
            ">> FAIL: auth/BULLETIN_RESOURCE: must equal { tag: 'BulletInAllowance', value: undefined } — SSO codec spelling must be preserved",
        );
    });
});

describe("allocationErrorMessage", async () => {
    const { allocationErrorMessage } = await import("../dist/commands/login.js");

    test("NoSession maps to re-login guidance", () => {
        const msg = allocationErrorMessage("NoSession");
        assert.ok(
            msg.toLowerCase().includes("session") || msg.toLowerCase().includes("log"),
            ">> FAIL: login: allocationErrorMessage NoSession should mention session or login",
        );
    });

    test("Rejected maps to phone-declined message", () => {
        const msg = allocationErrorMessage("Rejected");
        assert.ok(
            msg.toLowerCase().includes("declin") || msg.toLowerCase().includes("approv") || msg.toLowerCase().includes("phone"),
            ">> FAIL: login: allocationErrorMessage Rejected should mention declined/approve/phone",
        );
    });

    test("NotAvailable maps to re-pair guidance", () => {
        const msg = allocationErrorMessage("NotAvailable");
        assert.ok(
            msg.toLowerCase().includes("logout") || msg.toLowerCase().includes("pair") || msg.toLowerCase().includes("product"),
            ">> FAIL: login: allocationErrorMessage NotAvailable should mention logout/pair/product",
        );
    });

    test("UnexpectedResponse maps to try-again message", () => {
        const msg = allocationErrorMessage("UnexpectedResponse");
        assert.ok(
            msg.toLowerCase().includes("unexpected") || msg.toLowerCase().includes("try again"),
            ">> FAIL: login: allocationErrorMessage UnexpectedResponse should mention unexpected or try again",
        );
    });

    test("unknown reason falls back gracefully", () => {
        const msg = allocationErrorMessage("SomeFutureReason");
        assert.ok(
            msg.includes("SomeFutureReason"),
            ">> FAIL: login: allocationErrorMessage unknown reason should include the reason string",
        );
    });
});

describe("allocationFailedMessage", async () => {
    const { allocationFailedMessage } = await import("../dist/commands/login.js");

    test("includes the reason string", () => {
        const msg = allocationFailedMessage("some timeout reason");
        assert.ok(
            msg.includes("some timeout reason"),
            ">> FAIL: login/allocationFailedMessage: must include the passed reason string",
        );
    });

    test("mentions pool fallback and retry via login", () => {
        const msg = allocationFailedMessage("any reason");
        assert.ok(
            /pool/i.test(msg),
            ">> FAIL: login/allocationFailedMessage: must mention pool fallback",
        );
        assert.ok(
            /login/i.test(msg),
            ">> FAIL: login/allocationFailedMessage: must mention bulletin-deploy login (retry)",
        );
    });

    test("does NOT contain phone-blaming phrases", () => {
        const msg = allocationFailedMessage("any reason");
        assert.ok(
            !/unlocked/i.test(msg),
            ">> FAIL: login/allocationFailedMessage: must NOT mention 'unlocked' (no phone-blaming)",
        );
        assert.ok(
            !/app is open/i.test(msg),
            ">> FAIL: login/allocationFailedMessage: must NOT mention 'app is open' (no phone-blaming)",
        );
    });

    test("mentions personhood or alias as likely cause", () => {
        const msg = allocationFailedMessage("any reason");
        assert.ok(
            /personhood|alias/i.test(msg),
            ">> FAIL: login/allocationFailedMessage: must mention personhood or alias as likely cause hint",
        );
    });
});
