import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDepositWei, bufferedWeiToNative, ProofOfPersonhoodStatus } from "../dist/dotns.js";

const STARTING_PRICE = 10n * 10n ** 18n; // 10 ether-units, the live paseo-next-v2 value

test("registerDepositWei: NoStatus signer pays the live startingPrice", () => {
  assert.equal(registerDepositWei(ProofOfPersonhoodStatus.NoStatus, STARTING_PRICE), STARTING_PRICE);
});

test("registerDepositWei: verified signers (Lite/Full) pay zero", () => {
  assert.equal(registerDepositWei(ProofOfPersonhoodStatus.ProofOfPersonhoodLite, STARTING_PRICE), 0n);
  assert.equal(registerDepositWei(ProofOfPersonhoodStatus.ProofOfPersonhoodFull, STARTING_PRICE), 0n);
});

test("registerDepositWei: tracks a non-default (owner-updated) startingPrice", () => {
  const updated = 42n * 10n ** 18n;
  assert.equal(registerDepositWei(ProofOfPersonhoodStatus.NoStatus, updated), updated);
});

test("bufferedWeiToNative: applies the 110% buffer then converts (round up on remainder)", () => {
  const ratio = 100000000n; // 1e8
  // 10e18 wei * 1.1 = 11e18 → /1e8 = 11e10 native, exact
  assert.equal(bufferedWeiToNative(10n * 10n ** 18n, ratio), 11n * 10n ** 10n);
  assert.equal(bufferedWeiToNative(0n, ratio), 0n);
});
