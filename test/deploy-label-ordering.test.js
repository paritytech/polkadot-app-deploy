import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { deploy, isPhoneSignerActive, shouldHandoverName } from "../dist/deploy.js";
import { parseDomainName } from "../dist/dotns.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// Behavioral guard (#890): a syntactically invalid label must be rejected
// up-front — BEFORE the signer-resolution block prints the worker/storage plan.
// Before that fix, parseDomainName ran after that block, so a doomed deploy first
// printed a "Using <signer>" / "will transfer …" / "Storage signer:" line that
// could never matter.
//
// #1185 changed WHICH labels qualify, not the ordering property. This test used
// "ionut" (5-char base → Reserved) and asserted /Base name is 5 chars/. Post-#1185
// a Reserved label is deliberately NOT rejected pre-chain — whether it is
// deployable is an ownership question resolved in preflight, because a name
// registered via registerReserved bypasses PopRules on-chain and its owner must
// be able to deploy to it. Left unchanged, this test stopped being hermetic: the
// deploy sailed past validation, tried to reach wss://example.invalid, and burned
// ~91s before failing on an unrelated error. It tripled the CI Unit Tests job
// (7.9min → 25min+) — which is how it was caught.
//
// The ordering property is preserved by asserting it with a violation that IS
// still pre-chain: contract-level syntax (charset / length / edge hyphen).
test("deploy rejects a syntactically invalid label before printing any signer plan", async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(" ")); };
  try {
    await assert.rejects(
      // suri → forces the "resolve" signer path (the one that prints the plan).
      // bulletinEndpoints → bypasses the env loader, so the test is hermetic
      // (no network, no env file, no session load — the throw fires first).
      () => deploy(new Uint8Array([0]), "ab", { suri: "//Alice", bulletinEndpoints: ["wss://example.invalid"] }),
      /3-63 chars/,
      ">> FAIL: deploy label ordering: a too-short label should be rejected up-front, before any signer plan",
    );
  } finally {
    console.log = orig;
  }
  const leaked = logs.find(l => /Using .*signer|will transfer|Storage signer:/.test(l));
  assert.equal(
    leaked,
    undefined,
    `>> FAIL: deploy label ordering: signer-plan line printed before invalid-label validation: ${JSON.stringify(leaked)}`,
  );
});

// The other half of the #1185 contract, pinned here where the old assumption
// lived: a Reserved (<=5-char base) label must NOT be refused during parsing.
// Hermetic — parseDomainName is pure and makes no chain call.
test("a Reserved label is NOT rejected during parsing (#1185 — ownership decides, not syntax)", () => {
  const parsed = parseDomainName("ionut.dot");
  assert.equal(
    parsed.fullName,
    "ionut.dot",
    `>> FAIL: deploy label ordering: parseDomainName must pass a Reserved label through untouched so preflight can check ownership; got ${JSON.stringify(parsed.fullName)}`,
  );
});

// Output-hygiene guards: keep the trimmed deploy output trimmed. These catch an
// accidental re-introduction of the emojis / advisory that were removed.
test("deploy output keeps the 📱 and 🔺 emojis out", () => {
  const src = readFileSync(path.join(ROOT, "src/deploy.ts"), "utf8");
  assert.ok(!src.includes("📱"), ">> FAIL: deploy output: 📱 emoji re-introduced in src/deploy.ts");
  assert.ok(!src.includes("🔺"), ">> FAIL: deploy output: 🔺 emoji re-introduced in src/deploy.ts");
});

// The phone-signing banner + per-step reminder are gated on isPhoneSignerActive.
// Transfer mode uses a LOCAL worker signer (no phone), so the banner must be
// suppressed there — the bug the user reported. These three cases lock that in:
// deleting the `!options.transferTo` term would turn the first assertion red.
test("isPhoneSignerActive: transfer mode (signer + transferTo) → false", () => {
  assert.equal(
    isPhoneSignerActive({ signer: { mock: true }, signerAddress: "5Worker", transferTo: "0xbe74" }),
    false,
    ">> FAIL: phone banner: transfer-mode local worker should not trigger the phone banner",
  );
});

test("isPhoneSignerActive: signer set, no transferTo (session / injected QR) → true", () => {
  assert.equal(
    isPhoneSignerActive({ signer: { mock: true }, signerAddress: "5Session", transferTo: undefined }),
    true,
    ">> FAIL: phone banner: a phone-backed signer with no transfer must still show the banner",
  );
});

test("isPhoneSignerActive: no signer (pool / mnemonic) → false", () => {
  assert.equal(
    isPhoneSignerActive({ signer: undefined, signerAddress: undefined, transferTo: undefined }),
    false,
    ">> FAIL: phone banner: pool/mnemonic deploys have no phone-backed signer",
  );
});

// #928: Alice hands the name to the signed-in user ONLY when this run freshly
// registered it. Updating the content of a name that already exists must NOT
// transfer ownership — otherwise re-deploying any pre-existing name in transfer
// mode silently captured it for whatever session was on disk (which is how a
// local run captured the shared e2epoolns01.dot fixture for a dev's account).
test("shouldHandoverName: fresh registration + transferTo → true", () => {
  assert.equal(
    shouldHandoverName({ transferTo: "0x35cd", registeredFresh: true }),
    true,
    ">> FAIL: #928 handover: a freshly-registered name with a recipient must be handed over",
  );
});

test("shouldHandoverName: existing name (not freshly registered) + transferTo → false", () => {
  assert.equal(
    shouldHandoverName({ transferTo: "0x35cd", registeredFresh: false }),
    false,
    ">> FAIL: #928 handover: updating a pre-existing name must NOT transfer ownership (this is the fixture-capture bug)",
  );
});

test("shouldHandoverName: fresh registration but no transferTo → false", () => {
  assert.equal(
    shouldHandoverName({ transferTo: undefined, registeredFresh: true }),
    false,
    ">> FAIL: #928 handover: no recipient means no transfer",
  );
});

test("bin no longer prints the no-config legacy-contenthash advisory", () => {
  const bin = readFileSync(path.join(ROOT, "bin/polkadot-app-deploy"), "utf8");
  assert.ok(
    !bin.includes("published as legacy contenthash only"),
    ">> FAIL: deploy output: legacy-contenthash advisory re-introduced in bin/polkadot-app-deploy",
  );
});
