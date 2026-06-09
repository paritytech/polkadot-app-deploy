import { test } from "node:test";
import assert from "node:assert/strict";
import { isBenignTeardownError } from "../dist/deploy.js";

// The deploy-path crash handler (bin handleUnhandled) treats a non-benign
// unhandledRejection as a fatal crash → finalize(kind, 2) → exit 2 + marks the
// deploy killed. The SSO/papi session-adapter teardown rejects orphan promises
// with "DestroyedError: Client destroyed" AFTER a successful deploy (the owner-
// signs update path tears down a re-acquired session). isBenignTeardownError must
// classify that as benign so a SUCCESSFUL deploy doesn't exit 2 — while a real
// error must still fail.

test("isBenignTeardownError: DestroyedError (by name) is benign", () => {
  const e = new Error("Client destroyed");
  e.name = "DestroyedError";
  assert.equal(isBenignTeardownError(e), true,
    ">> FAIL: benign teardown: a DestroyedError must be suppressed, else a successful deploy exits 2");
});

test("isBenignTeardownError: 'Client destroyed' message is benign", () => {
  assert.equal(isBenignTeardownError(new Error("Client destroyed")), true,
    ">> FAIL: benign teardown: 'Client destroyed' teardown noise must be suppressed");
});

test("isBenignTeardownError: connection errors are benign", () => {
  assert.equal(isBenignTeardownError(new Error("WS halt: socket closed")), true,
    ">> FAIL: benign teardown: recoverable connection errors must be suppressed");
});

test("isBenignTeardownError: a genuine error is NOT benign (must still fail the deploy)", () => {
  assert.equal(isBenignTeardownError(new Error("Revive.TransferFailed")), false,
    ">> FAIL: benign teardown: a real on-chain error must NOT be suppressed");
  assert.equal(isBenignTeardownError(new Error("Invalid: Payment")), false,
    ">> FAIL: benign teardown: a real fee/payment error must NOT be suppressed");
  assert.equal(isBenignTeardownError("some string"), false,
    ">> FAIL: benign teardown: an arbitrary non-teardown value must NOT be suppressed");
});
