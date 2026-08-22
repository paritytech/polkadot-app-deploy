import { test } from "node:test";
import assert from "node:assert/strict";
import { weiToNative, DotNS, feeFloorFor, parseDomainName, classifyRegistrability, assertNotZeroRecipient } from "../dist/dotns.js";
import { namehash, zeroAddress } from "viem";

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

// --- zero-address burn guard -------------------------------------------
// transferFrom/setSubnodeOwner both accept the zero address as a recipient
// without reverting — it is a valid ERC-721/registry-owner value, just one
// nobody can ever recover a name from. Neither transferName nor
// transferSubname had a guard against it, so `--to 0x000...000` (a plausible
// typo for an empty --to, or a copy/paste slip) would silently and
// irreversibly burn the name. assertNotZeroRecipient is the single guard both
// paths call before touching the chain at all.

test("assertNotZeroRecipient: throws for the zero address", () => {
  assert.throws(
    () => assertNotZeroRecipient(zeroAddress, "giftbox.dot"),
    /zero address/i,
    ">> FAIL: assertNotZeroRecipient exact-case: expected a 'zero address' error for the literal zero address, got none or a different error",
  );
});

test("assertNotZeroRecipient: throws case-insensitively", () => {
  const upper = "0x" + "0".repeat(40).toUpperCase();
  assert.throws(
    () => assertNotZeroRecipient(upper, "giftbox.dot"),
    /zero address/i,
    ">> FAIL: assertNotZeroRecipient case-insensitive: an all-uppercase-hex zero address must still be caught (address comparisons are case-insensitive throughout this file)",
  );
});

test("assertNotZeroRecipient: does not throw for a real address", () => {
  assert.doesNotThrow(
    () => assertNotZeroRecipient("0x" + "ab".repeat(20), "giftbox.dot"),
    ">> FAIL: assertNotZeroRecipient false-positive: a real (non-zero) address must never be rejected by the burn guard",
  );
});

test("transferName: refuses to transfer to the zero address before any chain call", async () => {
  const d = stubDotns({ owner: "0xWORKER", evmAddress: "0xWORKER" });
  // If the guard fires AFTER a chain read (or not at all), this stub throws
  // "unexpected call" instead of the expected burn-guard error — proving the
  // guard runs first.
  d.contractCall = async (_a, _abi, fn) => { throw new Error("unexpected call " + fn + " — burn guard did not fire before the chain read"); };
  await assert.rejects(
    () => d.transferName("giftbox", zeroAddress),
    /zero address/i,
    ">> FAIL: transferName burn guard: expected transferName to refuse --to the zero address before any ownerOf/transferFloor call",
  );
});

// transferSubname touches contractCallNullable("owner", [node]) three times —
// parent owner, current subname owner, post-tx re-read — plus
// contractTransaction(setSubnodeOwner). Every call's node/args is captured
// (d.__nullableCalls / d.__txCall) so tests can assert the ACTUAL node
// derivation, not just call order — the #paseo-tld follow-up fixed a real bug
// where this method hardcoded `.dot` in all three node computations, and the
// original version of this stub was blind to it by construction (it never
// looked at the `node` argument at all).
function stubSubname({ parentOwner, evmAddress, currentSubOwner, afterOwner, txHash = "0xsub", tld = "dot" }) {
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d.evmAddress = evmAddress;
  d._contracts = { DOTNS_REGISTRY: "0xRegistry" };
  d._tld = tld;
  d.ensureConnected = () => {};
  let ownerCalls = 0;
  d.__nullableCalls = [];
  d.contractCallNullable = async (_addr, _abi, fn, args) => {
    if (fn !== "owner") throw new Error("unexpected call " + fn);
    d.__nullableCalls.push({ fn, node: args?.[0] });
    ownerCalls += 1;
    if (ownerCalls === 1) return parentOwner;
    if (ownerCalls === 2) return currentSubOwner;
    return afterOwner;
  };
  d.contractTransaction = async (...args) => {
    d.__txCall = args;
    return { kind: "hash", hash: txHash };
  };
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

test("transferSubname: refuses to transfer to the zero address before any chain call", async () => {
  const d = stubSubname({ parentOwner: "0xOWNER", evmAddress: "0xOWNER" });
  d.contractCallNullable = async (_a, _b, fn) => { throw new Error("unexpected call " + fn + " — burn guard did not fire before the chain read"); };
  await assert.rejects(
    () => d.transferSubname("app", "foo", zeroAddress),
    /zero address/i,
    ">> FAIL: transferSubname burn guard: expected transferSubname to refuse --to the zero address before any owner() read",
  );
});

// #paseo-tld follow-up: transferSubname was added (twin-only, PR #151) AFTER
// the per-env DotNS TLD port landed upstream, so it hardcoded `.dot` in three
// places (fullName, parentNode, subnode) — exactly the derivation-site bug
// class fixed elsewhere in src/dotns.ts (see computeDomainTokenId's doc
// comment). The tests above never caught it: stubSubname ignored the `node`
// argument entirely and drove results purely by call ORDER, so a wrong node
// value could never fail them. This test asserts the ACTUAL node values
// against an INDEPENDENTLY computed namehash, under a NON-default TLD, so a
// hardcoded ".dot" reintroduction fails immediately instead of silently
// passing.
test("transferSubname: node derivation — parentNode/subnode/setSubnodeOwner all use this._tld, not a hardcoded .dot", async () => {
  const d = stubSubname({
    parentOwner: "0xOWNER",
    evmAddress: "0xOWNER",
    currentSubOwner: "0xOLD",
    afterOwner: "0xRECIP",
    tld: "paseo",
  });
  const r = await d.transferSubname("app", "foo", "0xRECIP");
  assert.equal(r.status, "ok");

  // Independently computed — NOT derived from any dotns.ts helper — so this
  // can't agree with a wrong implementation by construction.
  const expectedParentNode = namehash("foo.paseo");
  const expectedSubnode = namehash("app.foo.paseo");
  const wrongDotParentNode = namehash("foo.dot");
  const wrongDotSubnode = namehash("app.foo.dot");

  assert.equal(d.__nullableCalls.length, 3,
    ">> FAIL: transferSubname node derivation: expected exactly 3 owner() reads (parent, current sub, post-tx)");
  assert.equal(d.__nullableCalls[0].node, expectedParentNode,
    `>> FAIL: transferSubname parent-owner check must query namehash("foo.paseo"), not namehash("foo.dot") (${wrongDotParentNode}); got ${d.__nullableCalls[0].node}`);
  assert.equal(d.__nullableCalls[1].node, expectedSubnode,
    `>> FAIL: transferSubname current-subname-owner check must query namehash("app.foo.paseo"), not namehash("app.foo.dot") (${wrongDotSubnode}); got ${d.__nullableCalls[1].node}`);
  assert.equal(d.__nullableCalls[2].node, expectedSubnode,
    `>> FAIL: transferSubname post-tx re-read must query namehash("app.foo.paseo"); got ${d.__nullableCalls[2].node}`);

  // contractTransaction(contractAddress, value, abi, functionName, args, statusCallback)
  assert.ok(d.__txCall, ">> FAIL: transferSubname must call contractTransaction");
  assert.equal(d.__txCall[3], "setSubnodeOwner");
  const [subnodeRecord] = d.__txCall[4];
  assert.equal(subnodeRecord.parentNode, expectedParentNode,
    ">> FAIL: transferSubname's setSubnodeOwner call must pass the paseo-tld parentNode, not a hardcoded .dot one");
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
