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
  assert.match(r.reason, /no contract code/i);
});

test("classifyProtocolVersion: code present but neither probe answers => unknown, names both probes", () => {
  const r = classifyProtocolVersion({ hasCode: true, pricingVersionOk: false, startingPriceOk: false });
  assert.equal(r.version, null);
  assert.match(r.reason, /pricingVersion/);
  assert.match(r.reason, /startingPrice/);
});

test("classifyProtocolVersion: both probes answering prefers v2", () => {
  assert.equal(
    classifyProtocolVersion({ hasCode: true, pricingVersionOk: true, startingPriceOk: true }).version,
    "v2",
  );
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
