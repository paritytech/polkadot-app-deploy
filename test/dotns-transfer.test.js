import { test } from "node:test";
import assert from "node:assert/strict";
import { weiToNative, DotNS, feeFloorFor, parseDomainName, classifyRegistrability } from "../dist/dotns.js";

test("weiToNative: zero stays zero", () => {
  assert.equal(weiToNative(0n, 100000000n), 0n);
});

test("weiToNative: exact multiple floors cleanly", () => {
  // 10 ether wei / 1e8 ratio = 1e11 native, exact
  assert.equal(weiToNative(10n * 10n ** 18n, 100000000n), 100000000000n);
});

test("weiToNative: remainder rounds up so msg.value >= fee", () => {
  assert.equal(weiToNative(100000001n, 100000000n), 2n); // 1.00000001 -> 2
  assert.equal(weiToNative(1n, 100000000n), 1n);
});

// Build a DotNS instance with chain I/O stubbed. transferName only touches
// contractCall (ownerOf, transferFloor) and contractTransaction.
function stubDotns({ owner, evmAddress, floorWei = 0n, txHash = "0xabc" }) {
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d.evmAddress = evmAddress;
  d._contracts = { DOTNS_REGISTRAR: "0xReg", POP_RULES: "0xPop" };
  d._nativeToEthRatio = 100000000n;
  d.ensureConnected = () => {};
  d.contractCall = async (_addr, _abi, fn) => {
    if (fn === "ownerOf") return owner;
    if (fn === "transferFloor") return floorWei;
    throw new Error("unexpected call " + fn);
  };
  d.contractTransaction = async () => ({ kind: "hash", hash: txHash });
  return d;
}

test("transferName: no-op when recipient already owns it", async () => {
  const d = stubDotns({ owner: "0xRECIP", evmAddress: "0xWORKER" });
  const r = await d.transferName("giftbox", "0xrecip");
  assert.equal(r.status, "skipped-already-owned");
});

test("transferName: errors when a third party owns it", async () => {
  const d = stubDotns({ owner: "0xOTHER", evmAddress: "0xWORKER" });
  await assert.rejects(() => d.transferName("giftbox", "0xRECIP"), /owned by 0xOTHER/);
});

test("transferName: transfers when worker owns it", async () => {
  // ownerOf returns worker first, recipient on the post-transfer re-read.
  const d = stubDotns({ owner: "0xWORKER", evmAddress: "0xWORKER", floorWei: 10n * 10n ** 18n });
  let calls = 0;
  d.contractCall = async (_a, _abi, fn) => {
    if (fn === "transferFloor") return 10n * 10n ** 18n;
    if (fn === "ownerOf") return ++calls === 1 ? "0xWORKER" : "0xRECIP";
    throw new Error("unexpected " + fn);
  };
  const r = await d.transferName("giftbox", "0xRECIP");
  assert.equal(r.status, "ok");
  assert.equal(r.txHash, "0xabc");
  assert.equal(r.feeWei, 10n * 10n ** 18n);
});

// transferSubname touches only contractCallNullable("owner", node) — three
// times: parent owner, current subname owner, post-tx re-read — plus
// contractTransaction(setSubnodeOwner). The node arg is ignored here; we drive
// results by call order.
function stubSubname({ parentOwner, evmAddress, currentSubOwner, afterOwner, txHash = "0xsub" }) {
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d.evmAddress = evmAddress;
  d._contracts = { DOTNS_REGISTRY: "0xRegistry" };
  d.ensureConnected = () => {};
  let ownerCalls = 0;
  d.contractCallNullable = async (_addr, _abi, fn) => {
    if (fn !== "owner") throw new Error("unexpected call " + fn);
    ownerCalls += 1;
    if (ownerCalls === 1) return parentOwner;
    if (ownerCalls === 2) return currentSubOwner;
    return afterOwner;
  };
  d.contractTransaction = async () => ({ kind: "hash", hash: txHash });
  return d;
}

test("transferSubname: errors when the signer does not own the parent", async () => {
  const d = stubSubname({ parentOwner: "0xPARENT", evmAddress: "0xWORKER" });
  await assert.rejects(() => d.transferSubname("app", "foo", "0xRECIP"), /only the owner of the parent/i);
});

test("transferSubname: errors when the parent is not registered", async () => {
  const d = stubSubname({ parentOwner: null, evmAddress: "0xOWNER" });
  await assert.rejects(() => d.transferSubname("app", "foo", "0xRECIP"), /not registered/i);
});

test("transferSubname: no-op when the recipient already owns it", async () => {
  const d = stubSubname({ parentOwner: "0xOWNER", evmAddress: "0xOWNER", currentSubOwner: "0xRECIP" });
  const r = await d.transferSubname("app", "foo", "0xrecip");
  assert.equal(r.status, "skipped-already-owned");
});

test("transferSubname: reassigns via setSubnodeOwner when the signer owns the parent", async () => {
  const d = stubSubname({ parentOwner: "0xOWNER", evmAddress: "0xOWNER", currentSubOwner: "0xOLD", afterOwner: "0xRECIP" });
  const r = await d.transferSubname("app", "foo", "0xRECIP");
  assert.equal(r.status, "ok");
  assert.equal(r.txHash, "0xsub");
});

test("transferSubname: throws when the reassignment does not land", async () => {
  const d = stubSubname({ parentOwner: "0xOWNER", evmAddress: "0xOWNER", currentSubOwner: "0xOLD", afterOwner: "0xOLD" });
  await assert.rejects(() => d.transferSubname("app", "foo", "0xRECIP"), /did not land/i);
});

test("feeFloorFor: adds the transfer fee to the register floor", () => {
  const base = feeFloorFor("register", 2000000000000n, 0n, 0n);
  const withFee = feeFloorFor("register", 2000000000000n, 0n, 5000000000n);
  assert.equal(withFee - base, 5000000000n);
});

test("feeFloorFor: adds the transfer fee to the already-owned floor", () => {
  const base = feeFloorFor("already-owned-by-us", 2000000000000n, 0n, 0n);
  const withFee = feeFloorFor("already-owned-by-us", 2000000000000n, 0n, 7n);
  assert.equal(withFee - base, 7n);
});

// Pin: `pad transfer <subname>.<parent>.dot` must still route through
// DotNS.transferSubname, never get refused as a non-compliant registerable
// label. transfer.ts's runTransfer dispatches on parseDomainName's
// isSubdomain flag: `parsed.isSubdomain ? dotns.transferSubname(...) :
// dotns.transferName(...)`. classifyRegistrability's PopRules-derived rules
// (trailing-digit count, hyphen-base, reserved-base) apply ONLY to
// registered top-level names via preflight/register() — parseDomainName's
// subname branch never calls classifyRegistrability, and validateDomainLabel
// (which it DOES call, bare, on both halves) is contract-syntax-only
// (charset/length/edge-hyphen) since #1185. A sublabel that would be
// refused outright as a top-level registration (here: "app1", 1 trailing
// digit) must still parse and dispatch to transferSubname untouched.
test("subname dispatch: a sublabel classifyRegistrability would refuse as a top-level name still reaches transferSubname (#1190/#1185 non-regression)", async () => {
  // Sanity check the premise: "app1" (1 trailing digit) IS refused by
  // classifyRegistrability when treated as a registerable top-level name —
  // otherwise this test wouldn't actually be pinning anything.
  const registrability = classifyRegistrability("app1");
  assert.equal(
    registrability.registrable, false,
    ">> FAIL: subname dispatch premise: \"app1\" (1 trailing digit) should be non-registrable as a top-level name, or this test isn't exercising the guard it claims to",
  );

  const parsed = parseDomainName("app1.mydomain.dot");
  assert.equal(parsed.isSubdomain, true, ">> FAIL: subname dispatch: \"app1.mydomain.dot\" must parse as a subdomain, not throw as a non-compliant label");
  assert.equal(parsed.sublabel, "app1", ">> FAIL: subname dispatch: sublabel must be the raw \"app1\", untouched by any PopRules rule");
  assert.equal(parsed.parentLabel, "mydomain", ">> FAIL: subname dispatch: parentLabel must be \"mydomain\"");
  assert.equal(parsed.fullName, "app1.mydomain.dot", ">> FAIL: subname dispatch: fullName must round-trip the input");

  // Mirror transfer.ts's actual dispatch: `parsed.isSubdomain ? transferSubname(...) : transferName(...)`.
  const d = stubSubname({ parentOwner: "0xOWNER", evmAddress: "0xOWNER", currentSubOwner: "0xOLD", afterOwner: "0xRECIP" });
  const r = parsed.isSubdomain
    ? await d.transferSubname(parsed.sublabel, parsed.parentLabel, "0xRECIP")
    : await d.transferName(parsed.label, "0xRECIP");
  assert.equal(r.status, "ok", ">> FAIL: subname dispatch: transferSubname must complete normally, not be refused as a non-compliant label");
  assert.equal(r.txHash, "0xsub", ">> FAIL: subname dispatch: expected the transferSubname tx path (txHash 0xsub), not transferName's (0xabc) — confirms the correct method was actually invoked");
});
