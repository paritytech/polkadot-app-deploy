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

// @novasamatech/sdk-statement's createStatementSdk#getStatements declares `const unsubscribe`
// initialised from `api.subscribeStatement(...)`, and both the next/error callbacks close over
// `unsubscribe`. When the observable settles SYNCHRONOUSLY (a poll firing after the WS client was
// already destroyed — the exact shape hit on Ctrl+C/teardown during an active pairing poll), the
// callback runs before the `const` binding is initialised, throwing `ReferenceError: Cannot access
// 'unsubscribe' before initialization`. RxJS rethrows that as an uncaughtException.
// `patches/@novasamatech+sdk-statement+0.6.0.patch` is the primary fix (it also closes a
// subscription leak this guard cannot); this predicate is the fallback so an unpatched consumer
// (patch-package blocked by npm's install-script gating) doesn't crash outright.
test("isBenignTeardownError: sdk-statement 'unsubscribe' TDZ ReferenceError is benign", () => {
  const e = new ReferenceError("Cannot access 'unsubscribe' before initialization");
  assert.equal(isBenignTeardownError(e), true,
    ">> FAIL: benign teardown: the sdk-statement getStatements TDZ crash must be suppressed when the patch isn't applied");
  // Case-insensitive message match.
  const e2 = new ReferenceError("cannot access 'unsubscribe' before initialization");
  assert.equal(isBenignTeardownError(e2), true,
    ">> FAIL: benign teardown: the TDZ match must be case-insensitive");
});

test("isBenignTeardownError: a DIFFERENT ReferenceError is NOT benign (guards against over-broad swallowing)", () => {
  assert.equal(isBenignTeardownError(new ReferenceError("Cannot access 'foo' before initialization")), false,
    ">> FAIL: benign teardown: an unrelated TDZ ReferenceError on a different binding must NOT be suppressed");
  assert.equal(isBenignTeardownError(new ReferenceError("x is not defined")), false,
    ">> FAIL: benign teardown: an unrelated ReferenceError must NOT be suppressed — narrow match only");
});

// login.ts's own `teardownFilter` regex (papi's raw "Error: Not connected", thrown by
// adapter.destroy()'s synchronous RxJS finalizer on an already-closed WS) must keep working once
// login.ts delegates to this shared predicate instead of its own inline regex.
test("isBenignTeardownError: papi 'Not connected' is benign (login.ts teardown noise)", () => {
  assert.equal(isBenignTeardownError(new Error("Not connected")), true,
    ">> FAIL: benign teardown: papi's 'Not connected' teardown noise (login.ts's original regex target) must be suppressed");
});

// Login's original regex was case-insensitive (/client destroyed|destroyederror/i). Pin that here:
// delegating to this predicate must not shrink what login.ts used to swallow.
test("isBenignTeardownError: lowercase 'destroyederror' is benign (preserves login.ts's old coverage)", () => {
  assert.equal(isBenignTeardownError(new Error("destroyederror: socket gone")), true,
    ">> FAIL: benign teardown: lowercase 'destroyederror' must stay suppressed, else login.ts loses coverage on delegation");
  assert.equal(isBenignTeardownError(new Error("client destroyed")), true,
    ">> FAIL: benign teardown: lowercase 'client destroyed' must stay suppressed, else login.ts loses coverage on delegation");
});
