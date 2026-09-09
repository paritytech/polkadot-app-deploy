import test from "node:test";
import assert from "node:assert/strict";
import { classifyProtocolVersion, getAdapter, DOTNS_ABI_PROFILES } from "../dist/dotns-protocol.js";

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
  assert.match(r.reason, /Check environments\.json \/ --contract config for this network/, "config-error guidance must survive the move from the call site");
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
