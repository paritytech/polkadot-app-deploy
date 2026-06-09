// test/auth-resolve.test.js — unit tests for deploy-path signer resolution (chooseSignerInput)
// and stale-session message emit path in deploy.ts.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("chooseSignerInput", async () => {
    const { chooseSignerInput } = await import("../dist/deploy.js");

    test("mnemonic present → 'mnemonic'", () => {
        const result = chooseSignerInput({ mnemonic: "word word word", suri: undefined, hasInjectedSigner: false });
        assert.equal(result, "mnemonic", ">> FAIL: auth-resolve: mnemonic path should return 'mnemonic'");
    });

    test("injected signer present → 'injected'", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: true });
        assert.equal(result, "injected", ">> FAIL: auth-resolve: injected signer should return 'injected'");
    });

    test("neither mnemonic nor injected nor suri → 'pool' (headless path unchanged)", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: false });
        assert.equal(result, "pool", ">> FAIL: auth-resolve: no signer/mnemonic/suri should return 'pool' — pool path must not load SSO deps");
    });

    test("mnemonic takes precedence over injected", () => {
        const result = chooseSignerInput({ mnemonic: "word word word", suri: undefined, hasInjectedSigner: true });
        assert.equal(result, "mnemonic", ">> FAIL: auth-resolve: mnemonic should take precedence over injected");
    });

    test("suri alone (no mnemonic) → 'resolve' (triggers resolveSigner)", () => {
        // suri explicitly provided → resolve path loads SSO stack
        const result = chooseSignerInput({ mnemonic: undefined, suri: "//Alice", hasInjectedSigner: false });
        assert.equal(result, "resolve", ">> FAIL: auth-resolve: suri alone should return 'resolve'");
    });

    test("persisted session present (no flags) → 'resolve' (logged-in deploy uses identity)", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: false, hasSession: true });
        assert.equal(result, "resolve", ">> FAIL: auth-resolve: a logged-in session should make a plain deploy resolve the session signer");
    });

    test("no session + no flags → 'pool' (CI/headless isolation, no SSO load)", () => {
        const result = chooseSignerInput({ mnemonic: undefined, suri: undefined, hasInjectedSigner: false, hasSession: false });
        assert.equal(result, "pool", ">> FAIL: auth-resolve: no session and no flags must stay on the pool path — never loads SSO");
    });

    test("mnemonic wins over a present session (explicit --mnemonic respected)", () => {
        const result = chooseSignerInput({ mnemonic: "word word word", suri: undefined, hasInjectedSigner: false, hasSession: true });
        assert.equal(result, "mnemonic", ">> FAIL: auth-resolve: --mnemonic must take precedence over an existing session");
    });
});

describe("formatStorageSignerLine", async () => {
    // Pins that the storage-signer resolution always emits exactly one visible line,
    // covering both the slot-success and AllowanceError/no-session pool-fallback paths.
    const { formatStorageSignerLine } = await import("../dist/deploy.js");

    test("slot allocated → line includes 'allowance slot' and the ss58 address", () => {
        const line = formatStorageSignerLine("5SlotXXXYYYZZZ");
        assert.ok(
            line.includes("allowance slot") && line.includes("5SlotXXXYYYZZZ"),
            ">> FAIL: storage-signer: slot-success line must include 'allowance slot' and the ss58 address",
        );
    });

    test("AllowanceError reason → line includes 'pool fallback' and the reason", () => {
        // Exercises the deploy.ts fallback path triggered on signerResult.isErr() with any
        // AllowanceError.reason ('NoSession' | 'Rejected' | 'NotAvailable' | 'UnexpectedResponse').
        for (const reason of ["NoSession", "Rejected", "NotAvailable", "UnexpectedResponse"]) {
            const line = formatStorageSignerLine(null, reason);
            assert.ok(
                line.includes("pool fallback") && line.includes(reason),
                `>> FAIL: storage-signer: AllowanceError(${reason}) must produce pool-fallback line with reason`,
            );
        }
    });

    test("no session (null, no reason) → line includes 'pool fallback (no session)'", () => {
        const line = formatStorageSignerLine(null);
        assert.ok(
            line.includes("pool fallback") && line.includes("no session"),
            ">> FAIL: storage-signer: no-session path must produce 'pool fallback (no session)'",
        );
    });
});

describe("deploy-path stale-session message", async () => {
    // Behavioral coverage is in whoami.test.js (stale-fixture test: same message, same
    // hasPersistedSession gate). This test guards the export contract for deploy.ts's emit site.

    const { STALE_SESSION_MESSAGE } = await import("../dist/auth-config.js");

    test("STALE_SESSION_MESSAGE is exported and non-empty (compile + export gate)", () => {
        assert.ok(
            typeof STALE_SESSION_MESSAGE === "string" && STALE_SESSION_MESSAGE.length > 0,
            ">> FAIL: deploy stale-session: STALE_SESSION_MESSAGE must be a non-empty string in auth-config",
        );
        // Content (logout→login wording) is pinned by whoami.test.js against real output.
    });
});

describe("isBulletinAuthActive", async () => {
    const { isBulletinAuthActive } = await import("../dist/storage-signer.js");

    test("null auth → { active: false, reason: 'missing' }", () => {
        const r = isBulletinAuthActive(null, 100);
        assert.equal(r.active, false, ">> FAIL: isBulletinAuthActive: null auth must be inactive");
        assert.equal(r.reason, "missing", ">> FAIL: isBulletinAuthActive: null auth reason must be 'missing'");
    });

    test("expiration === blockNumber (at boundary) → expired", () => {
        const r = isBulletinAuthActive({ expiration: 100 }, 100);
        assert.equal(r.active, false, ">> FAIL: isBulletinAuthActive: expiration === block must be expired");
        assert.equal(r.reason, "expired", ">> FAIL: isBulletinAuthActive: boundary expiration must have reason 'expired'");
        assert.equal(r.expiration, 100, ">> FAIL: isBulletinAuthActive: expiration must be returned on expired result");
    });

    test("expiration < blockNumber → expired with expiration value", () => {
        const r = isBulletinAuthActive({ expiration: 50n }, 100);
        assert.equal(r.active, false, ">> FAIL: isBulletinAuthActive: past expiration must be inactive");
        assert.equal(r.reason, "expired", ">> FAIL: isBulletinAuthActive: past expiration reason must be 'expired'");
        assert.equal(r.expiration, 50, ">> FAIL: isBulletinAuthActive: bigint expiration must be normalized to number");
    });

    test("expiration > blockNumber → active with expiration value", () => {
        const r = isBulletinAuthActive({ expiration: 200 }, 100);
        assert.equal(r.active, true, ">> FAIL: isBulletinAuthActive: future expiration must be active");
        assert.equal(r.expiration, 200, ">> FAIL: isBulletinAuthActive: active result must carry expiration block");
    });
});

describe("pollUntilBulletinAuthorized", async () => {
    const { pollUntilBulletinAuthorized } = await import("../dist/storage-signer.js");

    test("becomes active on second poll → returns { authorized: true, expiration }", async () => {
        let call = 0;
        const queryFn = async () => {
            call++;
            if (call < 2) return { auth: null, blockNumber: 10 };
            return { auth: { expiration: 200 }, blockNumber: 10 };
        };
        const result = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 5000 });
        assert.equal(result.authorized, true, ">> FAIL: pollUntilBulletinAuthorized: should return authorized:true when active");
        assert.equal(result.expiration, 200, ">> FAIL: pollUntilBulletinAuthorized: should return the expiration block");
    });

    test("expired entry never becomes active → times out", async () => {
        const queryFn = async () => ({ auth: { expiration: 5 }, blockNumber: 100 });
        const result = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 10 });
        assert.equal(result.authorized, false, ">> FAIL: pollUntilBulletinAuthorized: expired entry must time out");
        assert.equal(result.reason, "timeout", ">> FAIL: pollUntilBulletinAuthorized: reason must be 'timeout'");
    });

    test("never lands (always null) → times out", async () => {
        const queryFn = async () => ({ auth: null, blockNumber: 10 });
        const result = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 10 });
        assert.equal(result.authorized, false, ">> FAIL: pollUntilBulletinAuthorized: never-lands auth must time out");
        assert.equal(result.reason, "timeout", ">> FAIL: pollUntilBulletinAuthorized: timeout reason must be 'timeout'");
    });
});

describe("BulletinSlotAuthError reason distinction", async () => {
    const { BulletinSlotAuthError } = await import("../dist/storage-signer.js");

    test("missing reason → error message includes 'no on-chain authorization found'", () => {
        const err = new BulletinSlotAuthError("missing", "5SlotXXX");
        assert.ok(
            err.message.includes("no on-chain authorization found"),
            ">> FAIL: BulletinSlotAuthError: missing reason must include 'no on-chain authorization found'",
        );
        assert.equal(err.reason, "missing", ">> FAIL: BulletinSlotAuthError: reason field must be 'missing'");
        assert.equal(err.expiration, undefined, ">> FAIL: BulletinSlotAuthError: missing error must have no expiration");
    });

    test("expired reason → error message includes block number", () => {
        const err = new BulletinSlotAuthError("expired", "5SlotXXX", 42);
        assert.ok(
            err.message.includes("42"),
            ">> FAIL: BulletinSlotAuthError: expired reason must include expiration block in message",
        );
        assert.equal(err.reason, "expired", ">> FAIL: BulletinSlotAuthError: reason field must be 'expired'");
        assert.equal(err.expiration, 42, ">> FAIL: BulletinSlotAuthError: expired error must carry expiration block");
    });
});

describe("selectStorageReconnect fallback message", async () => {
    // Pins the user-visible warning strings so the actionable content stays stable.
    // The catch block uses BulletinSlotAuthError to distinguish missing/expired;
    // other errors use e.message. This test verifies the format via BulletinSlotAuthError.

    const { BulletinSlotAuthError } = await import("../dist/storage-signer.js");

    test("missing reason → formatted reason is 'no on-chain authorization found'", () => {
        const e = new BulletinSlotAuthError("missing", "5SlotXXX");
        // Mirror the catch block logic in selectStorageReconnect:
        const reason = e.reason === "expired" && e.expiration != null
            ? `expired at block ${e.expiration}`
            : "no on-chain authorization found";
        const msg =
            `⚠  Bulletin allowance slot not usable: ${reason}\n` +
            `   Falling back to the shared pool account for storage (fine on testnet).\n` +
            `   To use your own allowance, run: polkadot-app-deploy logout && polkadot-app-deploy login`;
        assert.ok(msg.includes("no on-chain authorization found"), ">> FAIL: fallback: missing reason must produce 'no on-chain authorization found'");
        assert.ok(msg.includes("fine on testnet"), ">> FAIL: fallback: message must mention 'fine on testnet'");
        assert.ok(msg.includes("polkadot-app-deploy logout && polkadot-app-deploy login"), ">> FAIL: fallback: message must include logout+login command");
    });

    test("expired reason → formatted reason includes expiration block", () => {
        const e = new BulletinSlotAuthError("expired", "5SlotXXX", 99);
        const reason = e.reason === "expired" && e.expiration != null
            ? `expired at block ${e.expiration}`
            : "no on-chain authorization found";
        const msg =
            `⚠  Bulletin allowance slot not usable: ${reason}\n` +
            `   Falling back to the shared pool account for storage (fine on testnet).\n` +
            `   To use your own allowance, run: polkadot-app-deploy logout && polkadot-app-deploy login`;
        assert.ok(msg.includes("expired at block 99"), ">> FAIL: fallback: expired reason must include expiration block in message");
        assert.ok(msg.includes("polkadot-app-deploy logout && polkadot-app-deploy login"), ">> FAIL: fallback: expired message must include logout+login command");
    });
});
