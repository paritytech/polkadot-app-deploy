import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { computeStorageDepositLimit } from "../dist/dotns.js";

const dotnsSrc = fs.readFileSync(new URL("../src/dotns.ts", import.meta.url), "utf-8");

const DEFAULT_MINIMUM = 2_000_000_000_000n; // REVIVE_CALL_MINIMUM_STORAGE_DEPOSIT

test("computeStorageDepositLimit: zero estimate returns the minimum", () => {
  assert.equal(computeStorageDepositLimit(0n), DEFAULT_MINIMUM,
    ">> FAIL: computeStorageDepositLimit zero estimate: expected the minimum floor, dry-runs with no storage effect must still get a workable limit");
});

test("computeStorageDepositLimit: a buffered estimate below the minimum is clamped up to the minimum", () => {
  // 1_000_000_000_000n * 1.2 = 1_200_000_000_000n, still below the 2e12 floor.
  assert.equal(computeStorageDepositLimit(1_000_000_000_000n), DEFAULT_MINIMUM,
    ">> FAIL: computeStorageDepositLimit clamp: a thin estimate's 20%-buffered value must not undercut the minimum floor");
});

test("computeStorageDepositLimit: a buffered estimate above the minimum passes through buffered, not clamped", () => {
  // 10_000_000_000_000n * 120 / 100 = 12_000_000_000_000n, above the 2e12 floor.
  assert.equal(computeStorageDepositLimit(10_000_000_000_000n), 12_000_000_000_000n,
    ">> FAIL: computeStorageDepositLimit above-floor case: expected the 20%-buffered estimate, not the floor");
});

test("computeStorageDepositLimit: boundary — buffered value exactly equal to the minimum", () => {
  // Choose an estimate whose 120/100 buffer lands exactly on 2_000_000_000_000n:
  // estimate * 120 / 100 = 2_000_000_000_000n => estimate = 1_666_666_666_667n (nearest bigint-exact case picked below).
  const estimate = 1_666_666_666_667n; // *120/100 = 2_000_000_000_000.4 -> floors to 2_000_000_000_000n exactly
  const buffered = (estimate * 120n) / 100n;
  assert.equal(buffered, DEFAULT_MINIMUM, "test setup sanity: buffered must land exactly on the minimum for this boundary case");
  assert.equal(computeStorageDepositLimit(estimate), DEFAULT_MINIMUM,
    ">> FAIL: computeStorageDepositLimit boundary: a buffered value exactly at the minimum must return the minimum (not clamp-related off-by-one)");
});

test("computeStorageDepositLimit: a custom minimum overrides the default floor", () => {
  assert.equal(computeStorageDepositLimit(0n, 5_000_000_000n), 5_000_000_000n,
    ">> FAIL: computeStorageDepositLimit custom minimum: zero estimate must return the caller-supplied minimum, not the hardcoded default");
  assert.equal(computeStorageDepositLimit(1n, 5_000_000_000n), 5_000_000_000n,
    ">> FAIL: computeStorageDepositLimit custom minimum clamp: a negligible estimate must clamp to the caller-supplied minimum");
});

// Drift guard: the bug this fixes was the SAME 20%-buffer-floored-at-minimum
// formula recomputed inline at a second call site (DotNS.submitBatchedContractCalls)
// instead of going through ReviveClientWrapper.dryRunReviveCall's helper. A
// return-value test on computeStorageDepositLimit alone can't catch a future
// call site reintroducing its own inline copy — source-scan for the telltale
// "* 120n) / 100n" buffer expression and require it appear exactly once (inside
// computeStorageDepositLimit's own definition).
test("dotns.ts: the storage-deposit-limit 20% buffer formula appears in exactly one place (computeStorageDepositLimit)", () => {
  const matches = dotnsSrc.match(/\*\s*120n\)\s*\/\s*100n/g) || [];
  assert.equal(matches.length, 1,
    `>> FAIL: storage_deposit_limit buffer drift-guard: found the "* 120n) / 100n" formula ${matches.length} time(s) in dotns.ts, ` +
    `expected exactly 1 (inside computeStorageDepositLimit) — a second inline copy means the two call sites can drift again`);
});

test("dotns.ts: both dryRunReviveCall and submitBatchedContractCalls call computeStorageDepositLimit", () => {
  const callSites = (dotnsSrc.match(/computeStorageDepositLimit\(/g) || []).length;
  // 1 definition (`function computeStorageDepositLimit(`) + 2 call sites = 3 occurrences of the identifier
  // followed by "(" — the definition itself matches this regex too, so require >= 3.
  assert.ok(callSites >= 3,
    `>> FAIL: storage_deposit_limit helper routing: expected computeStorageDepositLimit referenced at least 3 times ` +
    `(1 definition + dryRunReviveCall + submitBatchedContractCalls), found ${callSites}`);
});
