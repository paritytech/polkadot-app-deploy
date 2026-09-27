import test from "node:test";
import assert from "node:assert/strict";
import { classifyProtocolVersion, classifyDeclaredProtocolVersion, HIGHEST_VERIFIED_DOTNS_RELEASE, getAdapter, DOTNS_ABI_PROFILES } from "../dist/dotns-protocol.js";

test("classifyProtocolVersion: pricingVersion present => v0.5.8-rc1", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: false }).profile,
    "v0.5.8-rc1",
  );
});

test("classifyProtocolVersion: startingPrice present => poprules-startingPrice", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: false, startingPriceOk: true }).profile,
    "poprules-startingPrice",
  );
});

test("classifyProtocolVersion: no contract code is NOT a profile verdict", () => {
  const r = classifyProtocolVersion({ hasCode: false, pricingVersionOk: false, startingPriceOk: false });
  assert.equal(r.profile, null);
  assert.match(r.reason, /no contract (code|deployed)/i);
  // The config pointer belongs to the caller, which knows where the address came
  // from. Naming a file here produced two contradictory instructions in one
  // message for an environment that file never contained.
  assert.doesNotMatch(r.reason, /Check environments\.json/, "a pure classifier must not name a config file it cannot know is relevant");
});

test("classifyProtocolVersion: hasCode===false wins even if a probe happens to answer", () => {
  // hasCode===false is a definitive config verdict — checked before the
  // probes, so it can never be overridden by a probe answering (which
  // shouldn't happen for a genuinely code-less address, but the check order
  // must not depend on that).
  const r = classifyProtocolVersion({ hasCode: false, pricingVersionOk: true, startingPriceOk: false });
  assert.equal(r.profile, null);
  assert.match(r.reason, /no contract (code|deployed)/i);
});

test("classifyProtocolVersion: code present but neither probe answers => unknown, names both probes", () => {
  const r = classifyProtocolVersion({ hasCode: true, pricingVersionOk: false, startingPriceOk: false });
  assert.equal(r.profile, null);
  assert.match(r.reason, /pricingVersion/);
  assert.match(r.reason, /startingPrice/);
  assert.doesNotMatch(r.reason, /could not be verified/i, "hasCode:true must NOT carry the unverified-code-presence note");
});

test("classifyProtocolVersion: both probes answering prefers v0.5.8-rc1", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: true }).profile,
    "v0.5.8-rc1",
  );
});

// ---------------------------------------------------------------------------
// v0.6.0 discriminator: pricingVersion() answers on BOTH v0.5.8-rc1 and
// v0.6.0 (they are signature-identical on every PopRules function), so it
// alone cannot tell them apart — isPopIssuedOk (DotnsPopController.isPopIssued,
// new in v0.6.0) is what decides.
// ---------------------------------------------------------------------------

test("classifyProtocolVersion: pricingVersion + isPopIssued BOTH answer => v0.6.0", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: false, isPopIssuedOk: true }).profile,
    "v0.6.0",
  );
});

test("classifyProtocolVersion: pricingVersion answers, isPopIssued definitively reverts (false) => v0.5.8-rc1", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: false, isPopIssuedOk: false }).profile,
    "v0.5.8-rc1",
  );
});

test("classifyProtocolVersion: pricingVersion answers, isPopIssued probe not attempted (null, e.g. DOTNS_POP_CONTROLLER unconfigured) => falls back to v0.5.8-rc1, not an error", () => {
  // Safe because v0.5.8-rc1 and v0.6.0 share an IDENTICAL registration/ABI
  // adapter (see DotnsProtocolProbe.isPopIssuedOk's own doc comment) — this
  // fallback can only ever misclassify classifyLabelStatus's local advisory
  // semantics, never the on-chain transaction shape.
  const r = classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: false, isPopIssuedOk: null });
  assert.equal(r.profile, "v0.5.8-rc1");
});

test("classifyProtocolVersion: pricingVersion answers, isPopIssuedOk omitted entirely (undefined) => same fallback as null (every pre-v0.6.0 test/caller keeps compiling and keeps its exact old verdict)", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: false }).profile,
    "v0.5.8-rc1",
  );
});

test("classifyProtocolVersion: isPopIssuedOk is IGNORED unless pricingVersion answers (no point probing a second contract on the oldest generation)", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: false, startingPriceOk: true, isPopIssuedOk: true }).profile,
    "poprules-startingPrice",
  );
});

test("v0.6.0 buildRegistration appends maxPrice then pricingVersion, IDENTICAL to v0.5.8-rc1 (encoding unchanged)", () => {
  const r = getAdapter("v0.6.0").buildRegistration(
    { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
    { priceWei: 100n, pricingVersion: 7n },
  );
  assert.deepEqual(Object.keys(r), ["label", "owner", "secret", "reserved", "maxPrice", "pricingVersion"]);
  assert.equal(r.maxPrice, 110n);
  assert.equal(r.pricingVersion, 7n);
});

test("v0.6.0 buildRegistration refuses to build without a pricing version", () => {
  assert.throws(
    () => getAdapter("v0.6.0").buildRegistration(
      { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
      { priceWei: 100n },
    ),
    /pricingVersion/,
  );
});

test("v0.6.0 deposit call is IDENTICAL to v0.5.8-rc1's (price(label), not startingPrice)", () => {
  assert.equal(getAdapter("v0.6.0").depositCall("alpha").functionName, "price");
  assert.deepEqual(getAdapter("v0.6.0").depositCall("alpha").args, ["alpha"]);
});

test("v0.6.0 adapter's controllerAbi/popRulesAbi are the SAME array objects as v0.5.8-rc1's (not merely equal — reused, not copied, so they can't drift apart)", () => {
  assert.equal(getAdapter("v0.6.0").controllerAbi, getAdapter("v0.5.8-rc1").controllerAbi);
  assert.equal(getAdapter("v0.6.0").popRulesAbi, getAdapter("v0.5.8-rc1").popRulesAbi);
  assert.equal(getAdapter("v0.6.0").needsPricingBeforeCommit, true);
});

test("DOTNS_ABI_PROFILES: v0.6.0 carries its introducing tag and zip, and isPopIssued as its discriminator", () => {
  const info = DOTNS_ABI_PROFILES["v0.6.0"];
  assert.equal(info.introducedAt, "v0.6.0");
  assert.equal(info.abiPackage, "dotns-abis-v0.6.0.zip");
  assert.equal(info.discriminator, "isPopIssued");
});

// ---------------------------------------------------------------------------
// hasCode: null (code presence unverified — see DotnsProtocolProbe.hasCode's
// doc comment: null must never be read as "no code").
// ---------------------------------------------------------------------------

test("classifyProtocolVersion: hasCode null, pricingVersion answers => v0.5.8-rc1 (a probe answering is itself proof of the contract)", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: null, pricingVersionOk: true, startingPriceOk: false }).profile,
    "v0.5.8-rc1",
  );
});

test("classifyProtocolVersion: hasCode null, startingPrice answers => poprules-startingPrice", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: null, pricingVersionOk: false, startingPriceOk: true }).profile,
    "poprules-startingPrice",
  );
});

test("classifyProtocolVersion: hasCode null, neither probe answers => unknown, names both probes AND notes code presence was unverified", () => {
  const r = classifyProtocolVersion({ hasCode: null, pricingVersionOk: false, startingPriceOk: false });
  assert.equal(r.profile, null);
  assert.match(r.reason, /pricingVersion/);
  assert.match(r.reason, /startingPrice/);
  assert.match(r.reason, /could not be verified/i, "hasCode:null must carry the unverified-code-presence note — a wrong/undeployed address is also possible, not just a genuinely unrecognised generation");
});

test("poprules-startingPrice buildRegistration keeps the 4-field tuple", () => {
  const r = getAdapter("poprules-startingPrice").buildRegistration(
    { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
    { priceWei: 5n },
  );
  assert.deepEqual(Object.keys(r), ["label", "owner", "secret", "reserved"]);
});

test("v0.5.8-rc1 buildRegistration appends maxPrice then pricingVersion, in that order", () => {
  const r = getAdapter("v0.5.8-rc1").buildRegistration(
    { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
    { priceWei: 100n, pricingVersion: 7n },
  );
  assert.deepEqual(Object.keys(r), ["label", "owner", "secret", "reserved", "maxPrice", "pricingVersion"]);
  assert.equal(r.maxPrice, 110n); // +10% buffer, matching finalizeRegistration
  assert.equal(r.pricingVersion, 7n);
});

test("v0.5.8-rc1 buildRegistration refuses to build without a pricing version", () => {
  assert.throws(
    () => getAdapter("v0.5.8-rc1").buildRegistration(
      { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
      { priceWei: 100n },
    ),
    /pricingVersion/,
  );
});

test("deposit call differs per profile", () => {
  assert.equal(getAdapter("poprules-startingPrice").depositCall("alpha").functionName, "startingPrice");
  assert.deepEqual(getAdapter("poprules-startingPrice").depositCall("alpha").args, []);
  assert.equal(getAdapter("v0.5.8-rc1").depositCall("alpha").functionName, "price");
  assert.deepEqual(getAdapter("v0.5.8-rc1").depositCall("alpha").args, ["alpha"]);
});

// ---------------------------------------------------------------------------
// DOTNS_ABI_PROFILES — the provenance table. Pins the property that
// motivated this whole rename: the old profile's tag floor is genuinely
// unverified and must never be silently filled in with a guess.
// ---------------------------------------------------------------------------

test("DOTNS_ABI_PROFILES: poprules-startingPrice has NO introducedAt tag — the floor is unverified, not just unnamed", () => {
  assert.equal(DOTNS_ABI_PROFILES["poprules-startingPrice"].introducedAt, null);
  assert.equal(DOTNS_ABI_PROFILES["poprules-startingPrice"].abiPackage, null);
  assert.equal(DOTNS_ABI_PROFILES["poprules-startingPrice"].discriminator, "startingPrice");
});

test("DOTNS_ABI_PROFILES: v0.5.8-rc1 carries the introducing upstream tag verbatim, matching its abiPackage zip", () => {
  const info = DOTNS_ABI_PROFILES["v0.5.8-rc1"];
  assert.equal(info.introducedAt, "v0.5.8-rc1");
  assert.equal(info.abiPackage, "dotns-abis-v0.5.8-rc1.zip");
  assert.equal(info.discriminator, "pricingVersion");
});

// classifyDeclaredProtocolVersion. setProtocolVersion only requires a leading
// digit and [a-zA-Z0-9.-], so every malformed case below is reachable.

test("classifyDeclaredProtocolVersion: a declared release is the v0.6.0 profile, with the raw string kept", () => {
  const d = classifyDeclaredProtocolVersion("0.8.0");
  assert.equal(d.profile, "v0.6.0");
  assert.equal(d.raw, "0.8.0", ">> FAIL: the exact string the chain returned must survive for the log line");
});

test("classifyDeclaredProtocolVersion: the ceiling is the boundary, and it is strictly-greater", () => {
  const [major, minor, patch] = HIGHEST_VERIFIED_DOTNS_RELEASE.split(".").map(Number);
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor}.${patch}`).aboveVerifiedCeiling, false, ">> FAIL: the ceiling itself is verified, warning on it would train everyone to ignore the warning");
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor}.${patch + 1}`).aboveVerifiedCeiling, true, ">> FAIL: a generation nobody has diffed must be flagged, that warning is the point of reading the version at all");
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor + 1}.0`).aboveVerifiedCeiling, true);
  assert.equal(classifyDeclaredProtocolVersion(`${major + 1}.0.0`).aboveVerifiedCeiling, true);
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor + 2}.0`).aboveVerifiedCeiling, true, ">> FAIL: a two-digit minor must not sort below a one-digit one");
  assert.equal(classifyDeclaredProtocolVersion("0.10.0").aboveVerifiedCeiling, true, ">> FAIL: 0.10.0 is newer than 0.8.0 — plain string compare puts it below");
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor}.${patch + 1}`).profile, "v0.6.0", ">> FAIL: still classify — the probes would reach the same answer, so refusing one buys nothing");
});

test("classifyDeclaredProtocolVersion: a pre-release is the same release as its final tag", () => {
  // Both spellings are live states of one release: a deploy declares the rc
  // tag, the owner re-declares the final one.
  const [major, minor, patch] = HIGHEST_VERIFIED_DOTNS_RELEASE.split(".").map(Number);
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor}.${patch}-rc.1`).aboveVerifiedCeiling, false);
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor}.${patch + 1}-rc.1`).aboveVerifiedCeiling, true, ">> FAIL: an rc of an undiffed release is still undiffed");
  assert.equal(classifyDeclaredProtocolVersion("0.8.0-rc.1").raw, "0.8.0-rc.1");
});

test("classifyDeclaredProtocolVersion: empty means never declared, not a version", () => {
  assert.equal(classifyDeclaredProtocolVersion(""), null);
});

test("classifyDeclaredProtocolVersion: absent means the chain has no such function", () => {
  assert.equal(classifyDeclaredProtocolVersion(null), null);
  assert.equal(classifyDeclaredProtocolVersion(undefined), null);
});

test("classifyDeclaredProtocolVersion: junk the chain accepts does not parse into a release", () => {
  assert.equal(classifyDeclaredProtocolVersion("9abc"), null, ">> FAIL: a leading digit is all the contract requires, so this reaches us");
  assert.equal(classifyDeclaredProtocolVersion("1"), null, ">> FAIL: a bare major names no release to compare against");
  assert.equal(classifyDeclaredProtocolVersion("0.x.0"), null);
  assert.equal(classifyDeclaredProtocolVersion("0..0"), null);
});

test("classifyDeclaredProtocolVersion: a missing patch defaults to 0, extra components are ignored", () => {
  const [major, minor, patch] = HIGHEST_VERIFIED_DOTNS_RELEASE.split(".").map(Number);
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor}.${patch}.1`).aboveVerifiedCeiling, false, ">> FAIL: a fourth component must not read as a newer release");
  assert.equal(classifyDeclaredProtocolVersion(`${major}.${minor + 1}`).aboveVerifiedCeiling, true, ">> FAIL: two components is a release, with the patch defaulting to 0");
});
