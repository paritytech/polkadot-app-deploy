// test/sss-allowance-cache.test.js — unit tests for src/sss-allowance-cache.ts
// node:test (not vitest) — consistent with bulletin-deploy's test suite.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECONDS_PER_DAY = 86_400;

describe("sssPeriodEndSec", async () => {
    const { sssPeriodEndSec } = await import("../dist/sss-allowance-cache.js");

    test("returns the next UTC-midnight boundary (period end) in seconds", () => {
        // 2026-06-06T10:00:00Z → next midnight is 2026-06-07T00:00:00Z.
        const now = Math.floor(Date.UTC(2026, 5, 6, 10, 0, 0) / 1000);
        const expected = Math.floor(Date.UTC(2026, 5, 7, 0, 0, 0) / 1000);
        assert.equal(sssPeriodEndSec(now), expected,
            ">> FAIL: sssPeriodEndSec: must return next UTC midnight");
    });

    test("is aligned to a multiple of SECONDS_PER_DAY", () => {
        const now = Math.floor(Date.UTC(2026, 0, 1, 13, 37, 0) / 1000);
        assert.equal(sssPeriodEndSec(now) % SECONDS_PER_DAY, 0,
            ">> FAIL: sssPeriodEndSec: boundary must be day-aligned");
    });

    test("is strictly in the future for any time before the boundary", () => {
        const now = Math.floor(Date.UTC(2026, 5, 6, 23, 59, 59) / 1000);
        assert.ok(sssPeriodEndSec(now) > now,
            ">> FAIL: sssPeriodEndSec: boundary must be after now (strict lower bound)");
    });
});

describe("SSS allowance cache roundtrip", async () => {
    const { isSssAllowanceCacheValid, writeSssAllowanceCache, clearSssAllowanceCache } =
        await import("../dist/sss-allowance-cache.js");

    let dir; // serves as the fake home; the module appends ".polkadot-apps".
    const account = new Uint8Array(32).fill(0x11);
    const otherAccount = new Uint8Array(32).fill(0x22);
    const now = Math.floor(Date.UTC(2026, 5, 6, 10, 0, 0) / 1000);

    before(() => {
        dir = mkdtempSync(join(tmpdir(), "sss-cache-"));
        mkdirSync(join(dir, ".polkadot-apps"), { recursive: true });
    });
    after(() => { rmSync(dir, { recursive: true, force: true }); });

    test("a missing cache is not valid", async () => {
        assert.equal(await isSssAllowanceCacheValid(account, now, dir), false,
            ">> FAIL: cache: absent file must read as invalid");
    });

    test("a fresh write is valid within the same period", async () => {
        await writeSssAllowanceCache(account, now, dir);
        assert.equal(await isSssAllowanceCacheValid(account, now, dir), true,
            ">> FAIL: cache: same-period read must be valid");
    });

    test("a write does NOT validate a different account", async () => {
        await writeSssAllowanceCache(account, now, dir);
        assert.equal(await isSssAllowanceCacheValid(otherAccount, now, dir), false,
            ">> FAIL: cache: a different account must not get a hit (per-account keyed)");
    });

    test("expires once the period rolls over (next midnight)", async () => {
        await writeSssAllowanceCache(account, now, dir);
        const afterMidnight = Math.floor(Date.UTC(2026, 5, 7, 0, 0, 1) / 1000);
        assert.equal(await isSssAllowanceCacheValid(account, afterMidnight, dir), false,
            ">> FAIL: cache: must expire after the period boundary");
    });

    test("clear drops the entry", async () => {
        await writeSssAllowanceCache(account, now, dir);
        await clearSssAllowanceCache(dir);
        assert.equal(await isSssAllowanceCacheValid(account, now, dir), false,
            ">> FAIL: cache: clear must invalidate");
    });
});
