import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { pollUntilBulletinAuthorized, isBulletinAuthActive } = await import("../dist/storage-signer.js");

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
