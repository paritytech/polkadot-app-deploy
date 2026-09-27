import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSubnodeIds, DEFAULT_TLD } from "../dist/dotns.js";
import { namehash } from "viem";

// bulletin-deploy #1304 (chokepoint refactor) follow-up: transferSubname,
// registerSubdomain, and checkSubdomainOwnership in src/dotns.ts each
// hand-derived namehash(`${sublabel}.${parentLabel}.${tld}`) and
// namehash(`${parentLabel}.${tld}`) independently — three copies of the same
// on-chain identifier derivation. All three used `this._tld` correctly, so
// there was no live bug in this twin, but this is exactly the shape that
// caused the ssoqedtuwf fund-loss pinned in dotns-token-id.test.js (a
// hardcoded TLD diverging from the per-env `this._tld` after a mint had
// already succeeded). computeSubnodeIds collapses the three copies into one;
// these tests pin it against an INDEPENDENTLY computed namehash() under a
// NON-default TLD ("paseo", not DEFAULT_TLD "dot") so a regression that
// quietly falls back to the default TLD would be caught.
const SUBLABEL = "app";
const PARENT_LABEL = "example";
const NON_DEFAULT_TLD = "paseo";

test("computeSubnodeIds: parentNode agrees with an independently computed namehash(parentLabel.tld)", () => {
  const { parentNode } = computeSubnodeIds(SUBLABEL, PARENT_LABEL, NON_DEFAULT_TLD);
  const expected = namehash(`${PARENT_LABEL}.${NON_DEFAULT_TLD}`);
  assert.equal(
    parentNode,
    expected,
    `>> FAIL: computeSubnodeIds parentNode: expected namehash("${PARENT_LABEL}.${NON_DEFAULT_TLD}") = ${expected}, got ${parentNode} — the parent-node derivation has diverged from namehash()`,
  );
});

test("computeSubnodeIds: subnode agrees with an independently computed namehash(sublabel.parentLabel.tld)", () => {
  const { subnode } = computeSubnodeIds(SUBLABEL, PARENT_LABEL, NON_DEFAULT_TLD);
  const expected = namehash(`${SUBLABEL}.${PARENT_LABEL}.${NON_DEFAULT_TLD}`);
  assert.equal(
    subnode,
    expected,
    `>> FAIL: computeSubnodeIds subnode: expected namehash("${SUBLABEL}.${PARENT_LABEL}.${NON_DEFAULT_TLD}") = ${expected}, got ${subnode} — the subnode derivation has diverged from namehash()`,
  );
});

test("computeSubnodeIds: parentNode and subnode differ for the same inputs", () => {
  const { parentNode, subnode } = computeSubnodeIds(SUBLABEL, PARENT_LABEL, NON_DEFAULT_TLD);
  assert.notEqual(
    parentNode,
    subnode,
    `>> FAIL: computeSubnodeIds collision: parentNode and subnode must not be equal — got ${parentNode} for both`,
  );
});

test("computeSubnodeIds: defaults to DEFAULT_TLD when no tld is passed", () => {
  const withDefault = computeSubnodeIds(SUBLABEL, PARENT_LABEL);
  const withExplicit = computeSubnodeIds(SUBLABEL, PARENT_LABEL, DEFAULT_TLD);
  assert.deepEqual(
    withDefault,
    withExplicit,
    `>> FAIL: computeSubnodeIds default arg: no-tld call must match an explicit DEFAULT_TLD ("${DEFAULT_TLD}") call`,
  );
});

test("computeSubnodeIds: a different TLD for the same labels produces different node ids", () => {
  const dotIds = computeSubnodeIds(SUBLABEL, PARENT_LABEL, "dot");
  const paseoIds = computeSubnodeIds(SUBLABEL, PARENT_LABEL, NON_DEFAULT_TLD);
  assert.notEqual(
    dotIds.parentNode,
    paseoIds.parentNode,
    `>> FAIL: computeSubnodeIds cross-tld parentNode: dot and paseo parentNode collided for the same labels — TLD is not actually affecting the derivation`,
  );
  assert.notEqual(
    dotIds.subnode,
    paseoIds.subnode,
    `>> FAIL: computeSubnodeIds cross-tld subnode: dot and paseo subnode collided for the same labels — TLD is not actually affecting the derivation`,
  );
});
