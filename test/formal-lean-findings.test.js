// Tests of the confirmed findings of the upstream Lean models (the formal/ tree lives in
// bulletin-deploy only and is not mirrored here). F-L1, F-T1 and F-T2 are fixed (#1647,
// #1648, #1649), so each asserts the FIXED behaviour. Nothing here loads formal/: every
// test drives the real dist/ and tools/ code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDomainLabel, buildLabelAlternatives, classifyRegistrability } from "../dist/dotns.js";
import { classifyForRetry } from "../tools/release-retry-wrapper.mjs";
import { classifyDeployStderr } from "./helpers/e2e-failure.js";
import { classifyErrorKind } from "../dist/telemetry.js";

const show = (s) => JSON.stringify(s);
function isValid(label) {
  try { validateDomainLabel(label); return true; } catch { return false; }
}

// F-L1 (#1647). buildLabelAlternatives used to return [] for a valid label whenever the
// 9-char cut of its base ended in a digit ("release-2-1": fallback "release-200" has 3
// trailing digits, Reserved). Now every valid label gets at least one alternative and
// every alternative is itself valid and registrable on the profile it was built for.
// Proofs.lean FL1_fixed_* prove the same for all labels.
const PROFILES = ["poprules-startingPrice", "v0.5.8-rc1", "v0.6.0"];
function assertAlternativesSound(label, profile) {
  const alts = buildLabelAlternatives(label, profile);
  assert.ok(alts.length > 0, `>> FAIL: formal-lean F-L1: buildLabelAlternatives(${show(label)}, ${profile}) returned no alternative for a valid label`);
  for (const a of alts) {
    assert.equal(isValid(a.label), true, `>> FAIL: formal-lean F-L1: alternative ${show(a.label)} for ${show(label)} fails validateDomainLabel`);
    assert.equal(classifyRegistrability(a.label, profile).registrable, true, `>> FAIL: formal-lean F-L1: alternative ${show(a.label)} for ${show(label)} is not registrable on ${profile}`);
    assert.notEqual(a.status, 3, `>> FAIL: formal-lean F-L1: alternative ${show(a.label)} for ${show(label)} is Reserved`);
  }
  return alts;
}

test("formal-lean F-L1: a valid label whose base cut ends in a digit still gets alternatives", () => {
  for (const label of ["aaaaaaaa1-1", "release-2-1"]) {
    assert.equal(isValid(label), true);
    const alts = assertAlternativesSound(label, "poprules-startingPrice");
    // the fallback strips the digit/hyphen tail of the 9-char cut, then pads with x
    if (label === "release-2-1") assert.ok(alts.some((a) => a.label === "releasexx00"), `>> FAIL: formal-lean F-L1: expected the releasexx00 fallback, got ${show(alts.map((a) => a.label))}`);
  }
});

test("formal-lean F-L1: every valid label over {a,1,-} up to length 7 gets sound alternatives on every profile", () => {
  const alphabet = ["a", "1", "-"];
  let level = [""];
  let checked = 0;
  for (let len = 1; len <= 7; len++) {
    level = level.flatMap((p) => alphabet.map((c) => p + c));
    for (const label of level) {
      if (!isValid(label)) continue;
      for (const profile of PROFILES) { assertAlternativesSound(label, profile); checked++; }
    }
  }
  assert.ok(checked > 1000, `>> FAIL: formal-lean F-L1: only ${checked} cases enumerated`);
});

// F-T1 (#1648). The needle used to read "Account mapping did not take effect", which is
// not a substring of the only producer, src/dotns.ts "Account auto-mapping did not take
// effect on-chain ...", so the race was neither retried nor classified. Both tables now
// carry the producer's wording. The guard that no needle can go dead this way again is
// "every needle has a producer" in test/test-release-retry-wrapper.js.
test("formal-lean F-T1: the account auto-mapping producer is retried and classified in all three tables", () => {
  const producer = "Account auto-mapping did not take effect on-chain for 5Df. The signer needs enough testnet PAS";
  assert.equal(classifyForRetry(producer, 1), 75, ">> FAIL: formal-lean F-T1: the wrapper does not retry the mapping race");
  assert.equal(classifyDeployStderr(producer).class, "account_mapping_race", ">> FAIL: formal-lean F-T1: e2e-failure does not recognise the mapping race");
  assert.equal(classifyErrorKind(producer), "account.mapping_pending");
});

// F-T2 (#1649). The wrapper used to scan the WHOLE output, so a recovered "Connection
// lost ..., reconnecting" line (src/deploy.ts, printed for reconnects that RECOVER) made
// any later deterministic failure exit 75. It now decides on the final failure only.
test("formal-lean F-T2: a recovered reconnect does not make a deterministic failure retry-eligible", () => {
  const log = "\n   Connection lost (heartbeat timeout), reconnecting...\n";
  const msg = "Post-deploy verification failed for app.dot: on-chain contenthash is 0x00";
  assert.equal(classifyErrorKind(msg), "verify.contenthash_mismatch");
  assert.equal(classifyForRetry(msg, 1), 1);
  assert.equal(classifyForRetry(log + msg, 1), 1, ">> FAIL: formal-lean F-T2: a recovered reconnect line still makes a deterministic failure retry-eligible");
});
