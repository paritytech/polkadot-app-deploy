import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readPreviousContenthashSafe } from "../dist/deploy.js";

const deploySrc = fs.readFileSync(new URL("../src/deploy.ts", import.meta.url), "utf-8");

// Regression guard for the latent double-TLD-suffix bug: deploy.ts's subdomain
// branch used to call readPreviousContenthashSafe(preflight, parsed.fullName),
// but ParsedDomainName.fullName already carries the TLD (`${label}.${tld}`),
// and DotNS.getContenthash() appends `.${this._tld}` itself — so the callee
// derived namehash("sub.parent.paseo.paseo"), a node that never exists.
// It was caught by readPreviousContenthashSafe's own try/catch (non-fatal:
// silently defeats the incremental-deploy optimisation), but it is the exact
// bug class that, elsewhere in this codebase (computeDomainTokenId's history),
// caused an 11 PAS mint to succeed and then the follow-up ownerOf lookup to
// revert with ERC721NonexistentToken because it queried a differently-derived
// node. The fix must be: exactly one TLD derivation, inside getContenthash,
// never at the call site.
//
// A return-value assertion cannot catch this: readPreviousContenthashSafe
// swallows every error and a stub that ignores its input would return the
// same happy CID whether the caller double-suffixes or not. So this stub
// records the raw argument getContenthash actually received and asserts
// on THAT.

function makeRecordingDotns(hexToReturn = "0x") {
  const received = [];
  const dotns = {
    async getContenthash(bareLabel) {
      received.push(bareLabel);
      return hexToReturn;
    },
  };
  return { dotns, received };
}

test("readPreviousContenthashSafe: passes the bare label through unchanged, no TLD appended by the caller", async () => {
  const { dotns, received } = makeRecordingDotns();
  await readPreviousContenthashSafe(dotns, "mysub.myparent");
  assert.equal(received.length, 1,
    ">> FAIL: readPreviousContenthashSafe argument recording: expected exactly one getContenthash call");
  assert.equal(received[0], "mysub.myparent",
    `>> FAIL: readPreviousContenthashSafe TLD handling: getContenthash received "${received[0]}", ` +
    `expected the untouched bare label "mysub.myparent" — the function must not add or expect a TLD suffix itself`);
});

test("readPreviousContenthashSafe: a caller-supplied TLD-suffixed name is never re-suffixed inside the function", async () => {
  // This does not defend against a caller passing the wrong (suffixed) value —
  // that is exactly the historical bug, now fixed at the deploy.ts call site
  // (parsed.label, not parsed.fullName). This test only pins that
  // readPreviousContenthashSafe itself is a transparent passthrough to
  // getContenthash and performs no TLD manipulation of its own, so the single
  // point of derivation stays inside DotNS.getContenthash.
  const { dotns, received } = makeRecordingDotns();
  await readPreviousContenthashSafe(dotns, "sub.parent.paseo");
  assert.equal(received[0], "sub.parent.paseo",
    `>> FAIL: readPreviousContenthashSafe passthrough: got "${received[0]}", expected the exact input echoed back unmodified`);
});

test("readPreviousContenthashSafe: returns null and swallows getContenthash errors (non-fatal by design)", async () => {
  const dotns = { async getContenthash() { throw new Error("simulated RPC failure"); } };
  const result = await readPreviousContenthashSafe(dotns, "somelabel.parent");
  assert.equal(result, null,
    ">> FAIL: readPreviousContenthashSafe error handling: expected null on a thrown getContenthash error, incremental-deploy optimisation must degrade silently");
});

test("readPreviousContenthashSafe: returns null for the first-deploy \"0x\" sentinel", async () => {
  const { dotns } = makeRecordingDotns("0x");
  const result = await readPreviousContenthashSafe(dotns, "freshlabel");
  assert.equal(result, null,
    ">> FAIL: readPreviousContenthashSafe first-deploy handling: expected null for the \"0x\" no-contenthash-yet sentinel");
});

// The unit tests above only pin readPreviousContenthashSafe's own contract
// (transparent passthrough, no TLD manipulation). They cannot catch a
// regression at the CALL SITE — e.g. deploy.ts's subdomain branch reverting
// to pass `parsed.fullName` (which already carries the TLD) instead of
// `parsed.label` (bare). Source-scan directly for that, the same pattern
// used by the "telemetry coverage source scans" describe block in test.js.
test("deploy.ts: subdomain branch reads previous contenthash with the bare label, not the TLD-suffixed fullName", () => {
  const callIdx = deploySrc.indexOf("previousContenthashCid = await readPreviousContenthashSafe(preflight, parsed.label);");
  assert.ok(callIdx !== -1,
    ">> FAIL: deploy.ts subdomain contenthash read: expected readPreviousContenthashSafe(preflight, parsed.label) call not found — " +
    "did the subdomain branch regress to passing parsed.fullName (already TLD-suffixed), reintroducing the double-TLD-suffix bug " +
    "(namehash(\"sub.parent.paseo.paseo\"))?");
  // Belt-and-braces: make sure the buggy call shape (parsed.fullName as the
  // second arg to this specific function) is nowhere in the file.
  const buggyCallIdx = deploySrc.indexOf("readPreviousContenthashSafe(preflight, parsed.fullName)");
  assert.equal(buggyCallIdx, -1,
    ">> FAIL: deploy.ts subdomain contenthash read: found readPreviousContenthashSafe(preflight, parsed.fullName) — " +
    "parsed.fullName already carries the TLD and getContenthash() appends it again, reading a node that doesn't exist");
});
