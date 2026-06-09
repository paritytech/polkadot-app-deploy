// test/sss-allowance.test.js — unit tests for src/sss-allowance.ts
// node:test (not vitest) — consistent with bulletin-deploy's test suite.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

describe("sssStorageKey", async () => {
    const { sssStorageKey } = await import("../dist/sss-allowance.js");

    test("produces a 0x-prefixed 108-character hex string for a 32-byte key", () => {
        const pubkey = new Uint8Array(32).fill(0xab);
        const key = sssStorageKey(pubkey);
        // prefix(21 bytes) + pubkey(32 bytes) = 53 bytes = 106 hex chars + "0x" = 108
        assert.equal(key.length, 108, ">> FAIL: sssStorageKey: expected 108-char hex string");
        assert.ok(key.startsWith("0x"), ">> FAIL: sssStorageKey: must start with 0x");
    });

    test("encodes the ASCII prefix :statement_allowance: correctly", () => {
        const pubkey = new Uint8Array(32).fill(0);
        const key = sssStorageKey(pubkey);
        // ":statement_allowance:" in hex
        const expectedPrefix = "0x" + Buffer.from(":statement_allowance:").toString("hex");
        assert.ok(
            key.startsWith(expectedPrefix),
            `>> FAIL: sssStorageKey: key should start with hex of ':statement_allowance:'; ` +
            `expected prefix=${expectedPrefix}, got=${key.slice(0, expectedPrefix.length)}`,
        );
    });

    test("appends the raw pubkey bytes without hashing", () => {
        // Use a pubkey where each byte equals its index for easy verification.
        const pubkey = new Uint8Array(32);
        for (let i = 0; i < 32; i++) pubkey[i] = i;
        const key = sssStorageKey(pubkey);
        const keyHex = key.slice(2); // strip 0x
        // Last 64 hex chars = last 32 bytes = pubkey
        const pubkeyHex = keyHex.slice(-64);
        const expectedPubkeyHex = Buffer.from(pubkey).toString("hex");
        assert.equal(
            pubkeyHex,
            expectedPubkeyHex,
            ">> FAIL: sssStorageKey: pubkey bytes appended without hashing",
        );
    });

    test("throws for a pubkey that is not 32 bytes", () => {
        assert.throws(
            () => sssStorageKey(new Uint8Array(31)),
            /32/,
            ">> FAIL: sssStorageKey: should throw for 31-byte key",
        );
        assert.throws(
            () => sssStorageKey(new Uint8Array(33)),
            /32/,
            ">> FAIL: sssStorageKey: should throw for 33-byte key",
        );
    });

    test("known-vector: all-zero pubkey produces expected full hex", () => {
        const pubkey = new Uint8Array(32).fill(0);
        const key = sssStorageKey(pubkey);
        const prefixHex = Buffer.from(":statement_allowance:").toString("hex");
        const pubkeyHex = "00".repeat(32);
        assert.equal(
            key,
            "0x" + prefixHex + pubkeyHex,
            ">> FAIL: sssStorageKey: all-zero pubkey full key mismatch",
        );
    });
});

describe("statementSigningAccount", async () => {
    const { statementSigningAccount } = await import("../dist/sss-allowance.js");

    // Regression guard for the rc.6 fix: the SSS allowance lives on the session's
    // LOCAL (statement-signing) account, not the product account. The product
    // account never writes to the statement store, so checking it is a false-
    // negative that blocked every valid session. This test pins the account choice.
    test("returns the local account, NOT the product account", () => {
        const localAccount = new Uint8Array(32).fill(0xaa);
        const productAccount = new Uint8Array(32).fill(0xbb);
        // Shape mirrors the runtime UserSession (StoredUserSession spread): it
        // carries localAccount.accountId. `signer.publicKey` is the product account.
        const userSession = {
            localAccount: { accountId: localAccount },
            signer: { publicKey: productAccount },
        };
        const picked = statementSigningAccount(userSession);
        assert.deepEqual(
            picked,
            localAccount,
            ">> FAIL: statementSigningAccount: must return localAccount.accountId (the statement signer)",
        );
        assert.notDeepEqual(
            picked,
            productAccount,
            ">> FAIL: statementSigningAccount: must NOT return the product account (always-null key → false negative)",
        );
    });

    test("returns null for a session missing a usable local account", () => {
        assert.equal(statementSigningAccount(undefined), null,
            ">> FAIL: statementSigningAccount: undefined session should yield null");
        assert.equal(statementSigningAccount({}), null,
            ">> FAIL: statementSigningAccount: missing localAccount should yield null");
        assert.equal(
            statementSigningAccount({ localAccount: { accountId: new Uint8Array(31) } }),
            null,
            ">> FAIL: statementSigningAccount: non-32-byte accountId should yield null",
        );
    });
});
