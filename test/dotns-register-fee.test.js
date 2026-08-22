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

// --- Registration payment: floor-division vs the tested round-up formula ---
//
// finalizeRegistration used to compute its actual on-chain payment as
//   bufferedPaymentWei = (priceWei * 110n) / 100n         (floor)
//   bufferedPaymentNative = bufferedPaymentWei / ratio      (floor, NO remainder round-up)
// while the pre-flight quote path (gateOnFeeBalance's rentPriceNative) used
// bufferedWeiToNative, which computes the identical bufferedPaymentWei but
// then rounds UP on any remainder (weiToNative). Both are "the same 110%
// buffer", but the final wei->native step disagreed.
//
// This function reproduces the OLD (pre-fix) floor-only formula so the test
// suite can keep proving, independent of the current source, that the two
// approaches are NOT equivalent — i.e. that routing finalizeRegistration
// through bufferedWeiToNative was a real behavior change, not a no-op.
function oldFloorOnlyPaymentNative(priceWei, ratio) {
  const bufferedPaymentWei = (priceWei * 110n) / 100n;
  return bufferedPaymentWei / ratio; // pure floor — the bug
}

test("registration payment: floor-division and bufferedWeiToNative CAN disagree by exactly 1 native unit", () => {
  // Paseo Asset Hub PAS uses 10 decimals (ONE_PAS = 10_000_000_000n in dotns.ts);
  // priceWei is denominated like an 18-decimal "ether" unit (formatEther), so a
  // realistic nativeToEthRatio is 10 ** (18 - 10) = 1e8.
  const ratio = 100_000_000n; // 1e8, the real 18-decimal-wei -> 10-decimal-PAS ratio
  // An oracle-set price with no reason to be a round multiple of the ratio.
  const priceWei = 333_333_333_333_333_333n;
  // bufferedPaymentWei = floor(333333333333333333 * 110 / 100) = 366666666666666666n
  // (366666666666666666 * 100 = 36666666666666666600; the true product
  // 36666666666666666630 has remainder 30, floored away).
  // 366666666666666666n / 1e8: floor = 3666666666n, remainder = 66666666n (nonzero).
  const floored = oldFloorOnlyPaymentNative(priceWei, ratio);
  const roundedUp = bufferedWeiToNative(priceWei, ratio);
  assert.equal(floored, 3_666_666_666n,
    ">> FAIL: registration payment disagreement proof: old floor-only formula arithmetic changed, re-derive the worked example");
  assert.equal(roundedUp, 3_666_666_667n,
    ">> FAIL: registration payment disagreement proof: bufferedWeiToNative arithmetic changed, re-derive the worked example");
  assert.equal(roundedUp - floored, 1n,
    ">> FAIL: registration payment disagreement proof: expected the two formulas to disagree by exactly 1 native unit for this priceWei, " +
    `got floor=${floored} roundedUp=${roundedUp} — if they now agree, the finding this test guards may no longer apply`);
});

test("registration payment: boundary matrix — bufferedWeiToNative over 0, 1, exact multiples, and large realistic prices", () => {
  const ratio = 100_000_000n; // 1e8, pinned to the real 10-decimal PAS ratio, not a 12-decimal assumption
  // priceWei = 0 (free registration): must stay 0, no buffer applied.
  assert.equal(bufferedWeiToNative(0n, ratio), 0n,
    ">> FAIL: registration payment boundary: zero price must convert to zero native payment");
  // priceWei = 1 wei (smallest possible nonzero price): floor formula would give
  // floor(floor(1*110/100)/1e8) = floor(1/1e8) = 0n (the historical spurious-underflow
  // case); bufferedWeiToNative must round up to the smallest payable unit.
  assert.equal(bufferedWeiToNative(1n, ratio), 1n,
    ">> FAIL: registration payment boundary: the smallest nonzero price must round up to 1 native unit, never floor to 0");
  // priceWei chosen so the buffered wei value is an EXACT multiple of ratio:
  // both formulas must agree here (no remainder to disagree over).
  const exactPriceWei = 100n * ratio; // buffered = 100*ratio*110/100 = 110*ratio, exact
  const exactBuffered = (exactPriceWei * 110n) / 100n;
  assert.equal(exactBuffered % ratio, 0n, "test setup sanity: buffered value must be an exact multiple of ratio");
  assert.equal(bufferedWeiToNative(exactPriceWei, ratio), oldFloorOnlyPaymentNative(exactPriceWei, ratio),
    ">> FAIL: registration payment boundary: an exact-multiple buffered value must agree under both floor and round-up (no remainder to round)");
  // Large realistic price (e.g. a 1000-PAS-equivalent oracle price): must still
  // round up correctly, not overflow or silently truncate.
  const largePriceWei = 1_000n * 10n ** 18n; // 1000 ether-units
  assert.equal(bufferedWeiToNative(largePriceWei, ratio), (largePriceWei * 110n / 100n) / ratio,
    ">> FAIL: registration payment boundary: large price is an exact multiple here, expected exact floor==ceil agreement");
});
