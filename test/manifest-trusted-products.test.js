import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  validateRootManifest,
  validateProductConfig,
} from "../dist/index.js";

const VALID_ROOT_MANIFEST = {
  $v: 1,
  displayName: "DemoApp",
  description: "Short description.",
  icon: { cid: "bafy123", format: "png" },
};

const VALID_CONFIG = {
  domain: "demoapp.dot",
  displayName: "DemoApp",
  description: "Short description.",
  icon: { path: "./icon.png", format: "png" },
  executables: [
    { kind: "app", path: "./dist/app", appVersion: [1, 0, 0] },
  ],
};

// Run the shared rule set against both validators — the RFC keeps these
// specific `trustedProducts` rules identical for the on-chain RootManifest
// and the author-facing ProductConfig: structural shape (object / array),
// an empty key, and a non-lowercase key. The TLD-suffixed-key and
// unknown-grant-value rules are NOT shared — see the asymmetry block below.
const CASES = [
  {
    label: "validateRootManifest",
    validate: (trustedProducts) =>
      validateRootManifest(
        trustedProducts === undefined
          ? VALID_ROOT_MANIFEST
          : { ...VALID_ROOT_MANIFEST, trustedProducts },
      ),
  },
  {
    label: "validateProductConfig",
    validate: (trustedProducts) =>
      validateProductConfig(
        trustedProducts === undefined
          ? VALID_CONFIG
          : { ...VALID_CONFIG, trustedProducts },
      ),
  },
];

for (const { label, validate } of CASES) {
  describe(`${label} — trustedProducts`, () => {
    test("accepts a valid single grant", () => {
      const result = validate({ dim2: ["context"] });
      assert.equal(
        result.ok,
        true,
        `>> FAIL: ${label} trustedProducts-valid-single-grant: expected ok; errors: ${result.ok ? "" : result.errors.join("; ")}`,
      );
    });

    test("accepts an empty object", () => {
      const result = validate({});
      assert.equal(
        result.ok,
        true,
        `>> FAIL: ${label} trustedProducts-empty-object: expected ok; errors: ${result.ok ? "" : result.errors.join("; ")}`,
      );
    });

    test("accepts the field being absent entirely", () => {
      const result = validate(undefined);
      assert.equal(
        result.ok,
        true,
        `>> FAIL: ${label} trustedProducts-absent: expected ok; errors: ${result.ok ? "" : result.errors.join("; ")}`,
      );
    });

    test("accepts all three known grant values", () => {
      const result = validate({ dim2: ["all", "storage", "context"] });
      assert.equal(
        result.ok,
        true,
        `>> FAIL: ${label} trustedProducts-all-known-grants: expected ok; errors: ${result.ok ? "" : result.errors.join("; ")}`,
      );
    });

    test("rejects an uppercase key", () => {
      const result = validate({ Dim2: ["context"] });
      assert.equal(
        result.ok,
        false,
        `>> FAIL: ${label} trustedProducts-uppercase-key: an uppercase key must fail validation on both the read and publish side`,
      );
      assert.ok(
        result.errors.some((e) => e.includes("Dim2")),
        `>> FAIL: ${label} trustedProducts-uppercase-key: error must name the offending key`,
      );
    });

    test("rejects a non-array value", () => {
      const result = validate({ dim2: "context" });
      assert.equal(
        result.ok,
        false,
        `>> FAIL: ${label} trustedProducts-non-array-value: a per-key value that isn't an array is a structural shape error and must fail on both sides`,
      );
    });

    test("rejects a non-object trustedProducts", () => {
      const result = validate(["dim2"]);
      assert.equal(
        result.ok,
        false,
        `>> FAIL: ${label} trustedProducts-non-object: trustedProducts must be an object on both sides`,
      );
    });

    test("rejects an empty key", () => {
      const result = validate({ "": ["context"] });
      assert.equal(
        result.ok,
        false,
        `>> FAIL: ${label} trustedProducts-empty-key: an empty key must fail validation on both the read and publish side`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Read/publish asymmetry (RFC 464, 492-494 vs 338).
//
// `validateRootManifest` models "would a Host accept this manifest" — the
// RFC lists a TLD-suffixed key and an unrecognised grant value as
// specifically NOT validation errors on that side (lines 492-494): the
// entry is inert, or the value is ignored, but the manifest still validates.
// `validateProductConfig` models the publish-time author check, where the
// RFC keeps both cases strict (line 338): publishers MUST NOT emit an
// unrecognised grant, and a suffixed key is an author mistake worth
// catching before anything is written on-chain.
//
// The two cases below were previously asserted as errors on BOTH sides via
// the shared CASES loop above — that encoded a contract RFC 464/492-494
// forbids on the read side. They're corrected here to assert the RFC
// behaviour instead: root manifest accepts both, product config still
// rejects both.
// ---------------------------------------------------------------------------
describe("trustedProducts read/publish asymmetry", () => {
  test("validateRootManifest accepts a TLD-suffixed key (inert per RFC 494)", () => {
    const result = validateRootManifest({
      ...VALID_ROOT_MANIFEST,
      trustedProducts: { "dim2.paseo": ["context"] },
    });
    assert.equal(
      result.ok,
      true,
      `>> FAIL: validateRootManifest trustedProducts-tld-suffixed-key-inert: RFC 494 says a TLD-suffixed key resolves to a name that does not exist and the entry is inert, not invalid — root manifest must still validate; errors: ${result.ok ? "" : result.errors.join("; ")}`,
    );
  });

  test("validateRootManifest accepts an unrecognised grant value alongside a recognised one", () => {
    const result = validateRootManifest({
      ...VALID_ROOT_MANIFEST,
      trustedProducts: { dim2: ["contxt", "storage"] },
    });
    assert.equal(
      result.ok,
      true,
      `>> FAIL: validateRootManifest trustedProducts-unknown-grant-ignored: RFC 492 says an unrecognised grant value is ignored and the recognised values in the same entry still apply — root manifest must still validate; errors: ${result.ok ? "" : result.errors.join("; ")}`,
    );
  });

  test("validateProductConfig still rejects a TLD-suffixed key, mentioning the suffix problem", () => {
    const result = validateProductConfig({
      ...VALID_CONFIG,
      trustedProducts: { "dim2.paseo": ["context"] },
    });
    assert.equal(
      result.ok,
      false,
      ">> FAIL: validateProductConfig trustedProducts-tld-suffixed-key-still-strict: RFC 338 keeps the publish side strict — a suffixed key is an author mistake and must still fail",
    );
    assert.ok(
      result.errors.some(
        (e) => e.includes("dim2.paseo") && e.toLowerCase().includes("tld"),
      ),
      `>> FAIL: validateProductConfig trustedProducts-tld-suffixed-key-still-strict: expected a TLD-suffix error; got: ${result.ok ? "" : result.errors.join("; ")}`,
    );
  });

  test("validateProductConfig still rejects an unknown grant value", () => {
    const result = validateProductConfig({
      ...VALID_CONFIG,
      trustedProducts: { dim2: ["contxt"] },
    });
    assert.equal(
      result.ok,
      false,
      ">> FAIL: validateProductConfig trustedProducts-unknown-grant-still-strict: RFC 338 keeps the publish side strict — publishers MUST NOT emit an unrecognised grant",
    );
    assert.ok(
      result.errors.some((e) => e.includes("contxt")),
      `>> FAIL: validateProductConfig trustedProducts-unknown-grant-still-strict: expected an error naming the bad value; got: ${result.ok ? "" : result.errors.join("; ")}`,
    );
  });
});
