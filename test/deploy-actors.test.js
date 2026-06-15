import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveDeployActors, MainnetDefaultWorkerError } from "../dist/deploy-actors.js";

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

// #35 Defect 2 Part 1 — split-brain: the on-disk probe says a session exists
// (sessionPresent=true) but getSessionSigner() can't load it (returns null).
// Must NOT hard-fail transfer mode; must fall back to a normal non-transfer deploy.
test("session present on disk but not loadable (#35): falls back to non-transfer, does NOT throw", async () => {
  const r = await resolveDeployActors(
    fakeAuthClient({ session: false }),
    { suri: undefined, transferEnabled: true, isTestnet: true, sessionPresent: true },
  );
  assert.equal(r.recipientH160, undefined,
    ">> FAIL: #35: an unloadable session must NOT engage transfer mode (recipient unset) — it must fall back to a non-transfer deploy, not hard-fail");
  assert.ok(r.worker,
    ">> FAIL: #35: must still resolve a worker so the fallback deploy can proceed");
});

test("session not loadable + --suri provided (#35): falls back to non-transfer with the suri worker", async () => {
  const r = await resolveDeployActors(
    fakeAuthClient({ session: false }),
    { suri: "//Bob", transferEnabled: true, isTestnet: true, sessionPresent: true },
  );
  assert.equal(r.recipientH160, undefined,
    ">> FAIL: #35: with --suri but an unloadable session, must deploy non-transfer (no recipient)");
  assert.ok(r.worker, ">> FAIL: #35: --suri worker must resolve for the fallback deploy");
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
