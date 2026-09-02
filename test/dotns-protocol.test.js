import test from "node:test";
import assert from "node:assert/strict";
import { classifyProtocolVersion, getAdapter } from "../dist/dotns-protocol.js";

test("classifyProtocolVersion: pricingVersion present => v2", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: false }).version,
    "v2",
  );
});

test("classifyProtocolVersion: startingPrice present => v1", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: false, startingPriceOk: true }).version,
    "v1",
  );
});

test("classifyProtocolVersion: no contract code is NOT a version verdict", () => {
  const r = classifyProtocolVersion({ hasCode: false, pricingVersionOk: false, startingPriceOk: false });
  assert.equal(r.version, null);
  assert.match(r.reason, /no contract (code|deployed)/i);
  assert.match(r.reason, /Check environments\.json \/ --contract config for this network/, "config-error guidance must survive the move from the call site");
});

test("classifyProtocolVersion: hasCode===false wins even if a probe happens to answer", () => {
  // hasCode===false is a definitive config verdict — checked before the
  // probes, so it can never be overridden by a probe answering (which
  // shouldn't happen for a genuinely code-less address, but the check order
  // must not depend on that).
  const r = classifyProtocolVersion({ hasCode: false, pricingVersionOk: true, startingPriceOk: false });
  assert.equal(r.version, null);
  assert.match(r.reason, /no contract (code|deployed)/i);
});

test("classifyProtocolVersion: code present but neither probe answers => unknown, names both probes", () => {
  const r = classifyProtocolVersion({ hasCode: true, pricingVersionOk: false, startingPriceOk: false });
  assert.equal(r.version, null);
  assert.match(r.reason, /pricingVersion/);
  assert.match(r.reason, /startingPrice/);
  assert.doesNotMatch(r.reason, /could not be verified/i, "hasCode:true must NOT carry the unverified-code-presence note");
});

test("classifyProtocolVersion: both probes answering prefers v2", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: true }).version,
    "v2",
  );
});

// ---------------------------------------------------------------------------
// hasCode: null (code presence unverified — see DotnsProtocolProbe.hasCode's
// doc comment: null must never be read as "no code"). Moved here from
// test/test.js's heavier stub-based detectProtocolVersion tests now that the
// null-handling lives in this pure classifier rather than at the dotns.ts
// call site (paritytech/bulletin-deploy#1349's fix, relocated per design
// decision: the call site should just pass hasCodeResult through).
// ---------------------------------------------------------------------------

test("classifyProtocolVersion: hasCode null, pricingVersion answers => v2 (a probe answering is itself proof of the contract)", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: null, pricingVersionOk: true, startingPriceOk: false }).version,
    "v2",
  );
});

test("classifyProtocolVersion: hasCode null, startingPrice answers => v1", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: null, pricingVersionOk: false, startingPriceOk: true }).version,
    "v1",
  );
});

test("classifyProtocolVersion: hasCode null, neither probe answers => unknown, names both probes AND notes code presence was unverified", () => {
  const r = classifyProtocolVersion({ hasCode: null, pricingVersionOk: false, startingPriceOk: false });
  assert.equal(r.version, null);
  assert.match(r.reason, /pricingVersion/);
  assert.match(r.reason, /startingPrice/);
  assert.match(r.reason, /could not be verified/i, "hasCode:null must carry the unverified-code-presence note — a wrong/undeployed address is also possible, not just a genuinely unrecognised generation");
});

test("v1 buildRegistration keeps the 4-field tuple", () => {
  const r = getAdapter("v1").buildRegistration(
    { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
    { priceWei: 5n },
  );
  assert.deepEqual(Object.keys(r), ["label", "owner", "secret", "reserved"]);
});

test("v2 buildRegistration appends maxPrice then pricingVersion, in that order", () => {
  const r = getAdapter("v2").buildRegistration(
    { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
    { priceWei: 100n, pricingVersion: 7n },
  );
  assert.deepEqual(Object.keys(r), ["label", "owner", "secret", "reserved", "maxPrice", "pricingVersion"]);
  assert.equal(r.maxPrice, 110n); // +10% buffer, matching finalizeRegistration
  assert.equal(r.pricingVersion, 7n);
});

test("v2 buildRegistration refuses to build without a pricing version", () => {
  assert.throws(
    () => getAdapter("v2").buildRegistration(
      { label: "alpha", owner: "0x01", secret: "0x02", reserved: false },
      { priceWei: 100n },
    ),
    /pricingVersion/,
  );
});

test("deposit call differs per version", () => {
  assert.equal(getAdapter("v1").depositCall("alpha").functionName, "startingPrice");
  assert.deepEqual(getAdapter("v1").depositCall("alpha").args, []);
  assert.equal(getAdapter("v2").depositCall("alpha").functionName, "price");
  assert.deepEqual(getAdapter("v2").depositCall("alpha").args, ["alpha"]);
});
