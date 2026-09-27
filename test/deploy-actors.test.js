import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeployActors, MainnetDefaultWorkerError } from "../dist/deploy-actors.js";
import { SignerNotAvailableError } from "../dist/auth/index.js";

// Fake authClient: getSessionSigner returns a handle with addresses + destroy.
// Includes `signer` + `userSession` so the session branch of resolveSigner
// surfaces them (the deploy SSS preflight keys off worker.userSession).
function fakeAuthClient({ session }) {
  return {
    getSessionSigner: async () => session
      ? {
          address: "5Session",
          addresses: { rootAddress: "5Root", productAddress: "5Prod", productH160: "0xPROD" },
          signer: { mockSigner: true },
          userSession: { mockUserSession: true },
          destroy() {},
        }
      : null,
    // resolveSigner uses getSessionSigner for the session branch; for --suri it
    // takes the dev path and never calls this.
  };
}

test("signed in + transfer on + no suri (testnet): worker=Alice, recipient=session", async () => {
  const r = await resolveDeployActors(fakeAuthClient({ session: true }), { suri: undefined, transferEnabled: true, isTestnet: true, sessionPresent: true });
  assert.equal(r.worker.source, "dev");
  assert.equal(r.recipientH160, "0xPROD");
});

test("signed in + transfer on + suri X (testnet): worker=X, recipient=session", async () => {
  const r = await resolveDeployActors(fakeAuthClient({ session: true }), { suri: "//Bob", transferEnabled: true, isTestnet: true, sessionPresent: true });
  assert.equal(r.worker.source, "dev");
  assert.equal(r.recipientH160, "0xPROD");
});

test("signed in + transfer on + no suri + NON-testnet: throws MainnetDefaultWorkerError", async () => {
  await assert.rejects(
    () => resolveDeployActors(fakeAuthClient({ session: true }), { suri: undefined, transferEnabled: true, isTestnet: false, sessionPresent: true }),
    MainnetDefaultWorkerError,
  );
});

test("transfer off: no recipient, and the session signer + userSession survive (SSS preflight depends on it)", async () => {
  const r = await resolveDeployActors(fakeAuthClient({ session: true }), { suri: undefined, transferEnabled: false, isTestnet: true, sessionPresent: true });
  assert.equal(r.recipientH160, undefined, ">> FAIL: transfer-off: recipient must be unset so the deploy registers directly to the session signer");
  assert.equal(r.worker.source, "session", ">> FAIL: transfer-off: worker must be the mobile session signer, not a local dev key");
  assert.ok(r.worker.userSession, ">> FAIL: transfer-off: worker.userSession must be present or the SSS allowance preflight silently no-ops for real users");
});

// #234 SUPERSEDES #35 (Defect 2 Part 1)'s soft fallback: the on-disk probe says
// a session exists (sessionPresent=true) but getSessionSigner() can't load it
// (returns null). The old behaviour fell back to a non-transfer deploy where
// the worker (DEFAULT_MNEMONIC/Alice, absent --suri) signed and registered the
// name directly with no transfer target — if registration completed, the label
// ended up owned by a key anyone can use and was unrecoverable. Must now FAIL
// FAST (throw SignerNotAvailableError, which deploy.ts's catch converts into a
// NonRetryableError naming the logout/login or --mnemonic remedy) before any
// chain write, not fall back.
test("session present on disk but not loadable (#234, was #35): FAILS FAST, does NOT fall back", async () => {
  await assert.rejects(
    () => resolveDeployActors(
      fakeAuthClient({ session: false }),
      { suri: undefined, transferEnabled: true, isTestnet: true, sessionPresent: true },
    ),
    SignerNotAvailableError,
    ">> FAIL: #234: an unloadable session must fail fast (throw), not silently fall back to a no-transfer deploy on the default dev key",
  );
});

test("session not loadable + --suri provided (#234, was #35): FAILS FAST even with an explicit --suri worker", async () => {
  // --suri only pins WHO signs; it says nothing about who the label should end
  // up owned by. An unreadable session still means the intended recipient
  // (the signed-in user's H160) is unknown, so this must fail fast too —
  // --mnemonic (a full explicit signer, handled upstream by chooseSignerInput
  // before resolveDeployActors is ever called) is the one override that skips
  // this whole path; --suri is not.
  await assert.rejects(
    () => resolveDeployActors(
      fakeAuthClient({ session: false }),
      { suri: "//Bob", transferEnabled: true, isTestnet: true, sessionPresent: true },
    ),
    SignerNotAvailableError,
    ">> FAIL: #234: --suri must not bypass the fail-fast when the session is unreadable — the recipient is still unknown",
  );
});

test("session not loadable + NON-testnet + no suri (#35): still throws MainnetDefaultWorkerError (mainnet guard unchanged)", async () => {
  await assert.rejects(
    () => resolveDeployActors(
      fakeAuthClient({ session: false }),
      { suri: undefined, transferEnabled: true, isTestnet: false, sessionPresent: true },
    ),
    MainnetDefaultWorkerError,
    ">> FAIL: #35: mainnet + no --suri must still throw MainnetDefaultWorkerError, not fall back",
  );
});
