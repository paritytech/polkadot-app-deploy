import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { pollUntilBulletinAuthorized, isBulletinAuthActive, withTransientRetry, BulletinSlotAuthError } = await import("../dist/storage-signer.js");

describe("pollUntilBulletinAuthorized", () => {
  test("transient query errors are retried, not treated as unauthorized", async () => {
    let calls = 0;
    const queryFn = async () => {
      calls++;
      if (calls <= 2) throw new Error("WS read failed");
      return { auth: { expiration: 999_999 }, blockNumber: 100 };
    };
    const r = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 5000 });
    assert.equal(r.authorized, true, ">> FAIL: storage-signer/poll: two thrown reads then active must confirm, not time out");
    assert.equal(r.expiration, 999_999);
    assert.ok(calls >= 3, ">> FAIL: storage-signer/poll: expected at least 3 query attempts");
  });

  test("null auth (not-yet-landed) is retried until it becomes active", async () => {
    let calls = 0;
    const queryFn = async () => {
      calls++;
      if (calls <= 2) return { auth: null, blockNumber: 100 };
      return { auth: { expiration: 999_999 }, blockNumber: 100 };
    };
    const r = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 5000 });
    assert.equal(r.authorized, true, ">> FAIL: storage-signer/poll: null-then-active must confirm");
  });

  test("persistent query errors time out cleanly (no hang, no throw)", async () => {
    const queryFn = async () => { throw new Error("always down"); };
    const r = await pollUntilBulletinAuthorized(queryFn, { pollMs: 1, timeoutMs: 60 });
    assert.equal(r.authorized, false, ">> FAIL: storage-signer/poll: persistent errors must time out");
    assert.equal(r.reason, "timeout", ">> FAIL: storage-signer/poll: timeout reason expected");
  });
});

// #1058: getSlotSignerProvider must tolerate a single transient connect/query
// error (WS blip, RPC timeout) instead of permanently committing the whole
// deploy to the pool fallback. withTransientRetry is the extracted, unit-
// testable retry primitive it's built on.
describe("withTransientRetry (#1058)", () => {
  test("a transient error is retried, then a valid session succeeds", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      if (calls <= 2) throw new Error("WS read failed");
      return "slot-signer-active";
    };
    const r = await withTransientRetry(attempt, { retries: 2, delayMs: 1 });
    assert.equal(r, "slot-signer-active", ">> FAIL: storage-signer/retry: two transient errors then success must return the success value");
    assert.equal(calls, 3, ">> FAIL: storage-signer/retry: expected exactly 3 attempts (1 + 2 retries)");
  });

  test("a genuinely-unavailable slot (BulletinSlotAuthError) is NOT retried", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new BulletinSlotAuthError("missing", "5Grw...");
    };
    await assert.rejects(
      () => withTransientRetry(attempt, { retries: 2, delayMs: 1 }),
      BulletinSlotAuthError,
      ">> FAIL: storage-signer/retry: BulletinSlotAuthError must propagate, not be swallowed",
    );
    assert.equal(calls, 1, ">> FAIL: storage-signer/retry: a definitive auth failure must not be retried (wastes time, same on-chain fact)");
  });

  test("persistent transient errors exhaust retries and rethrow the last error", async () => {
    let calls = 0;
    const attempt = async () => {
      calls++;
      throw new Error(`down (attempt ${calls})`);
    };
    await assert.rejects(
      () => withTransientRetry(attempt, { retries: 2, delayMs: 1 }),
      /down \(attempt 3\)/,
      ">> FAIL: storage-signer/retry: must rethrow the LAST attempt's error after exhausting retries",
    );
    assert.equal(calls, 3, ">> FAIL: storage-signer/retry: expected exactly 3 attempts (1 + 2 retries) before giving up");
  });
});

describe("isBulletinAuthActive", () => {
  test("null → missing", () => {
    const r = isBulletinAuthActive(null, 100);
    assert.equal(r.active, false);
    assert.equal(r.reason, "missing", ">> FAIL: storage-signer/isActive: null must be missing");
  });
  test("expiration <= block → expired", () => {
    const r = isBulletinAuthActive({ expiration: 100 }, 100);
    assert.equal(r.active, false);
    assert.equal(r.reason, "expired", ">> FAIL: storage-signer/isActive: expiration<=block must be expired");
  });
  test("expiration > block → active", () => {
    const r = isBulletinAuthActive({ expiration: 200 }, 100);
    assert.equal(r.active, true, ">> FAIL: storage-signer/isActive: expiration>block must be active");
    assert.equal(r.expiration, 200);
  });
});
