import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { weiToNative, DotNS, feeFloorFor, parseDomainName, classifyRegistrability, assertNotZeroRecipient, computeSubnodeIds } from "../dist/dotns.js";
import { namehash, zeroAddress, decodeFunctionData, toFunctionSelector } from "viem";

// bulletin-deploy #1443: transferSubname now ALSO probes isAuthorised
// (checkNodeAuthorization) before ever reaching a setSubnodeOwner shape
// probe or a plain owner()-equality check. Both isAuthorised and
// setSubnodeOwner go through the same clientWrapper.performDryRunCall, so
// stubs that care about ONE of the two dispatch on the encoded call's
// function selector. Valid (checksummable-shape) hex addresses are required
// wherever a value reaches viem's real encodeFunctionData — which is now
// true of every `evmAddress` in this suite, since checkNodeAuthorization
// always encodes it as isAuthorised's `account` argument.
const IS_AUTHORISED_SELECTOR = toFunctionSelector("isAuthorised(bytes32,address)");
const ADDR_SIGNER = "0x1111111111111111111111111111111111111111";
const ADDR_OWNER = "0x2222222222222222222222222222222222222222";
const ADDR_OPERATOR = "0x8888888888888888888888888888888888888888";
const ADDR_STRANGER = "0x7777777777777777777777777777777777777777";

// /simplify: reuses bareRevertProbeResult (defined further down, alongside
// the setSubnodeOwner shape-probe stubs it was originally written for) — the
// isAuthorised probe's bare-revert shape is byte-identical, since both are
// just "this selector doesn't exist on this registry deployment" reads via
// the same ReviveClientWrapper.performDryRunCall.
//
// Encodes a bare ABI bool return (32-byte word, low byte 0/1) — matches what
// DotnsRegistry.isAuthorised actually returns on success.
function encodedBoolProbeResult(value) {
  return {
    gasConsumed: { referenceTime: 0n, proofSize: 0n },
    gasRequired: { referenceTime: 0n, proofSize: 0n },
    storageDeposit: { value: 0n },
    result: { isOk: true, isErr: false, value: { data: "0x" + "00".repeat(31) + (value ? "01" : "00"), flags: 0n } },
  };
}

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
  d.substrateAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  // bulletin-deploy #1443: checkNodeAuthorization (the parent-authorisation
  // gate transferSubname now calls) always probes DotnsRegistry.isAuthorised
  // via a raw dry run before falling back to owner()-equality — this suite's
  // older tests model a registry that PREDATES that accessor, so the probe
  // bare-reverts (selector not found) and the fallback exercises the exact
  // owner()-equality behaviour these tests already pin via
  // contractCallNullable below. Tests that want isAuthorised itself
  // consulted override this with their own clientWrapper.
  d.clientWrapper = { performDryRunCall: async () => bareRevertProbeResult() };
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
  const d = stubSubname({ parentOwner: "0xPARENT", evmAddress: ADDR_SIGNER });
  await assert.rejects(() => d.transferSubname("app", "foo", "0xRECIP"), /only the owner of the parent/i);
});

test("transferSubname: errors when the parent is not registered", async () => {
  const d = stubSubname({ parentOwner: null, evmAddress: ADDR_OWNER });
  await assert.rejects(() => d.transferSubname("app", "foo", "0xRECIP"), /not registered/i);
});

test("transferSubname: no-op when the recipient already owns it", async () => {
  const d = stubSubname({ parentOwner: ADDR_OWNER, evmAddress: ADDR_OWNER, currentSubOwner: "0xRECIP" });
  const r = await d.transferSubname("app", "foo", "0xrecip");
  assert.equal(r.status, "skipped-already-owned");
});

test("transferSubname: reassigns via setSubnodeOwner when the signer owns the parent", async () => {
  const d = stubSubname({ parentOwner: ADDR_OWNER, evmAddress: ADDR_OWNER, currentSubOwner: "0xOLD", afterOwner: "0xRECIP" });
  const r = await d.transferSubname("app", "foo", "0xRECIP");
  assert.equal(r.status, "ok");
  assert.equal(r.txHash, "0xsub");
});

test("transferSubname: throws when the reassignment does not land", async () => {
  const d = stubSubname({ parentOwner: ADDR_OWNER, evmAddress: ADDR_OWNER, currentSubOwner: "0xOLD", afterOwner: "0xOLD" });
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
    parentOwner: ADDR_OWNER,
    evmAddress: ADDR_OWNER,
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

// Source-scan guard (bulletin-deploy #1304 follow-up), belt-and-suspenders on
// top of the behavioral pin above: every node derivation reachable from
// transferSubname must route through computeSubnodeIds, which itself routes
// through computeDomainNode(label, tld) — the sole caller of the shared
// ensNode() primitive (see the guard in dotns-token-id.test.js, which pins
// that primitive's uniqueness file-wide). This test's job is narrower and
// complementary: it doesn't care how the primitive is reached, only that (1)
// transferSubname routes through computeSubnodeIds and never bypasses it with
// its own inline node-derivation call, and (2) computeSubnodeIds's own two
// computeDomainNode(...) calls both forward the dynamic `tld` parameter,
// never a hardcoded suffix.
test("guard: transferSubname routes node derivation through computeSubnodeIds, which never hardcodes a TLD", () => {
  const srcPath = fileURLToPath(new URL("../src/dotns.ts", import.meta.url));
  const src = readFileSync(srcPath, "utf8");

  const transferStart = src.indexOf("async transferSubname(");
  assert.notEqual(transferStart, -1, ">> FAIL: guard transferSubname TLD hardcode: could not find 'async transferSubname(' in src/dotns.ts — has the method been renamed or moved?");
  const transferRest = src.slice(transferStart);
  const nextMethodOffset = transferRest.slice(1).search(/\n {2}(?:private\s+)?(?:async\s+)?[A-Za-z_]\w*\s*\(/);
  const transferBody = nextMethodOffset === -1 ? transferRest : transferRest.slice(0, nextMethodOffset + 1);

  assert.ok(
    /computeSubnodeIds\(/.test(transferBody),
    ">> FAIL: guard transferSubname TLD hardcode: transferSubname must derive its parent/subnode nodes via computeSubnodeIds(...), not an inline namehash(...)/computeDomainNode(...) call",
  );
  assert.ok(
    !/\bnamehash\(/.test(transferBody),
    ">> FAIL: guard transferSubname TLD hardcode: transferSubname must not call namehash(...) directly — a bare call here bypasses the single computeSubnodeIds derivation and can reintroduce a hardcoded TLD",
  );
  assert.ok(
    !/\bcomputeDomainNode\(/.test(transferBody),
    ">> FAIL: guard transferSubname TLD hardcode: transferSubname must not call computeDomainNode(...) directly either — that still reaches the shared primitive, but it bypasses computeSubnodeIds, the one place the sub/parent PAIR is supposed to be derived together",
  );

  const helperStart = src.indexOf("export function computeSubnodeIds(");
  assert.notEqual(helperStart, -1, ">> FAIL: guard transferSubname TLD hardcode: could not find 'export function computeSubnodeIds(' in src/dotns.ts — has the helper been renamed or moved?");
  const afterHelperStart = src.slice(helperStart);
  const closingBraceMatch = afterHelperStart.match(/\n\}/);
  assert.notEqual(
    closingBraceMatch, null,
    ">> FAIL: guard transferSubname TLD hardcode: could not find computeSubnodeIds's closing brace (a lone '}' at the start of a line) — has the helper's shape changed?",
  );
  const helperEnd = helperStart + closingBraceMatch.index + closingBraceMatch[0].length;
  const helperBody = src.slice(helperStart, helperEnd);

  assert.ok(
    !/\bnamehash\(/.test(helperBody),
    ">> FAIL: guard transferSubname TLD hardcode: computeSubnodeIds must not call namehash(...) directly any more — #1304 routes it through computeDomainNode(label, tld), the sole caller of the shared ensNode() primitive",
  );

  const calls = [...helperBody.matchAll(/computeDomainNode\(([^,]+),\s*([^)]+)\)/g)].map((m) => ({ label: m[1].trim(), tld: m[2].trim() }));
  assert.ok(
    calls.length >= 2,
    `>> FAIL: guard transferSubname TLD hardcode: expected at least 2 computeDomainNode(...) calls (parentNode + subnode) in computeSubnodeIds's body, found ${calls.length} — did the node-derivation shape change?`,
  );
  const offenders = [];
  for (const { label, tld } of calls) {
    if (tld !== "tld") offenders.push(`computeDomainNode(${label}, ${tld}) does not forward the dynamic tld parameter`);
  }
  assert.deepEqual(
    offenders,
    [],
    `>> FAIL: guard transferSubname TLD hardcode: ${JSON.stringify(offenders)} — every computeDomainNode(...) call in computeSubnodeIds must forward its tld parameter, never a hardcoded suffix like ".dot"`,
  );
});

// ---------------------------------------------------------------------------
// bulletin-deploy #1443: checkNodeAuthorization / DotnsRegistry.isAuthorised(node, account).
//
// Per upstream v0.7.0 IDotnsRegistry.sol/DotnsRegistry.sol: isAuthorised is
// "the canonical authorisation check the registry enforces on owner-gated
// entry points" and the "single source of truth" _authorised/isAuthorised
// both delegate to. Strictly wider than raw owner()-equality: a non-zero
// stored subnode owner must match, OR (for a tokenised node) the
// registrar's ERC-721 owner, an operator-for-all delegate, or a
// single-token approval all qualify. transferSubname's parent-authorisation
// gate used to test raw ownership equality only, refusing an
// approved/operator delegate the chain itself would accept.

// Isolated stub for checkNodeAuthorization itself — no transferSubname
// plumbing, just the two chain reads the method makes (owner(), then the
// raw isAuthorised dry-run probe).
function stubNodeAuthProbe({ owner, isAuthorisedResult, bareRevert = false }) {
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d._contracts = { DOTNS_REGISTRY: "0xRegistry" };
  d.ensureConnected = () => {};
  d.substrateAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  d.contractCallNullable = async (_addr, _abi, fn) => {
    if (fn !== "owner") throw new Error("unexpected call " + fn);
    return owner;
  };
  let probeCalls = 0;
  d.clientWrapper = {
    performDryRunCall: async () => {
      probeCalls += 1;
      return bareRevert ? bareRevertProbeResult() : encodedBoolProbeResult(isAuthorisedResult);
    },
  };
  return { d, getProbeCalls: () => probeCalls };
}

test("checkNodeAuthorization: consults isAuthorised and allows an operator-for-all signer who does not own the node", async () => {
  const { d, getProbeCalls } = stubNodeAuthProbe({ owner: ADDR_OWNER, isAuthorisedResult: true });
  const result = await d.checkNodeAuthorization("0x" + "11".repeat(32), ADDR_OPERATOR);
  assert.deepEqual(
    result, { authorised: true, owner: ADDR_OWNER },
    `>> FAIL: checkNodeAuthorization operator-for-all: expected {authorised:true, owner:"${ADDR_OWNER}"}, got ${JSON.stringify(result)}`,
  );
  assert.equal(getProbeCalls(), 1, ">> FAIL: checkNodeAuthorization operator-for-all: expected exactly one isAuthorised probe");
});

test("checkNodeAuthorization: refuses a signer who is neither owner nor approved, but still reports the parent's owner", async () => {
  const { d } = stubNodeAuthProbe({ owner: ADDR_OWNER, isAuthorisedResult: false });
  const result = await d.checkNodeAuthorization("0x" + "11".repeat(32), ADDR_STRANGER);
  assert.deepEqual(
    result, { authorised: false, owner: ADDR_OWNER },
    `>> FAIL: checkNodeAuthorization refusal: expected {authorised:false, owner:"${ADDR_OWNER}"} so a caller can still name the owner in its error message, got ${JSON.stringify(result)}`,
  );
});

test("checkNodeAuthorization: isAuthorised absent (bare revert) falls back to the ownership-equality check instead of refusing outright", async () => {
  const { d: ownerMatches } = stubNodeAuthProbe({ owner: ADDR_OWNER, bareRevert: true });
  const matched = await ownerMatches.checkNodeAuthorization("0x" + "11".repeat(32), ADDR_OWNER);
  assert.deepEqual(
    matched, { authorised: true, owner: ADDR_OWNER },
    `>> FAIL: checkNodeAuthorization fallback (match): isAuthorised absent must fall back to owner()-equality, not refuse outright; got ${JSON.stringify(matched)}`,
  );

  const { d: ownerDiffers } = stubNodeAuthProbe({ owner: ADDR_OWNER, bareRevert: true });
  const mismatched = await ownerDiffers.checkNodeAuthorization("0x" + "11".repeat(32), ADDR_STRANGER);
  assert.deepEqual(
    mismatched, { authorised: false, owner: ADDR_OWNER },
    `>> FAIL: checkNodeAuthorization fallback (mismatch): expected the ownership-equality fallback to refuse a non-owner, got ${JSON.stringify(mismatched)}`,
  );
});

// End-to-end through the real write path: transferSubname's parent gate.
function stubSubnameWithAuthProbe({ parentOwner, evmAddress, authorised, currentSubOwner = null, afterOwner = null, tld = "dot", sublabel = "app", parentLabel = "foo", txHash = "0xsub" }) {
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d.evmAddress = evmAddress;
  d._tld = tld;
  d._contracts = { DOTNS_REGISTRY: "0xRegistry" };
  d.ensureConnected = () => {};
  d.substrateAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  let probeCalls = 0;
  d.clientWrapper = {
    performDryRunCall: async () => {
      probeCalls += 1;
      return encodedBoolProbeResult(authorised);
    },
  };
  const { parentNode, subnode } = computeSubnodeIds(sublabel, parentLabel, tld);
  let subnodeCalls = 0;
  d.contractCallNullable = async (_addr, _abi, fn, args) => {
    if (fn !== "owner") throw new Error("unexpected call " + fn);
    const node = args[0];
    if (node === parentNode) return parentOwner;
    if (node === subnode) {
      subnodeCalls += 1;
      return subnodeCalls === 1 ? currentSubOwner : afterOwner;
    }
    throw new Error(`stubSubnameWithAuthProbe: owner() called with unrecognised node ${node}`);
  };
  let subnodeOwnerRecord = null;
  d.contractTransaction = async (_addr, _value, _abi, fn, args) => {
    if (fn !== "setSubnodeOwner") throw new Error("unexpected tx " + fn);
    subnodeOwnerRecord = args[0];
    return { kind: "hash", hash: txHash };
  };
  return { d, getProbeCalls: () => probeCalls, getSubnodeOwnerRecord: () => subnodeOwnerRecord };
}

test("transferSubname: an operator-for-all signer who does not own the parent is allowed to reassign", async () => {
  const { d, getProbeCalls, getSubnodeOwnerRecord } = stubSubnameWithAuthProbe({
    parentOwner: ADDR_OWNER, evmAddress: ADDR_OPERATOR, authorised: true, currentSubOwner: "0xOLD", afterOwner: "0xRECIP",
  });
  const r = await d.transferSubname("app", "foo", "0xRECIP");
  assert.equal(r.status, "ok", `>> FAIL: transferSubname operator-for-all: expected status "ok", got "${r.status}"`);
  assert.equal(getProbeCalls(), 1, ">> FAIL: transferSubname operator-for-all: expected exactly one isAuthorised probe");
  assert.equal(
    getSubnodeOwnerRecord().owner, "0xRECIP",
    ">> FAIL: transferSubname operator-for-all: setSubnodeOwner must still target the requested recipient even though the signer isn't the parent owner",
  );
});

test("transferSubname: refuses a signer who is neither the parent owner nor approved, naming the parent's owner", async () => {
  const { d } = stubSubnameWithAuthProbe({ parentOwner: ADDR_OWNER, evmAddress: ADDR_STRANGER, authorised: false });
  await assert.rejects(
    () => d.transferSubname("app", "foo", "0xRECIP"),
    (err) => new RegExp(ADDR_OWNER, "i").test(err.message) && err.message.includes(ADDR_STRANGER),
    ">> FAIL: transferSubname operator-for-all refusal: expected an error naming both the parent's owner and the refused signer",
  );
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
  const d = stubSubname({ parentOwner: ADDR_OWNER, evmAddress: ADDR_OWNER, currentSubOwner: "0xOLD", afterOwner: "0xRECIP" });
  const r = parsed.isSubdomain
    ? await d.transferSubname(parsed.sublabel, parsed.parentLabel, "0xRECIP")
    : await d.transferName(parsed.label, "0xRECIP");
  assert.equal(r.status, "ok", ">> FAIL: subname dispatch: transferSubname must complete normally, not be refused as a non-compliant label");
  assert.equal(r.txHash, "0xsub", ">> FAIL: subname dispatch: expected the transferSubname tx path (txHash 0xsub), not transferName's (0xabc) — confirms the correct method was actually invoked");
});

// ---------------------------------------------------------------------------
// bulletin-deploy #1435/#1453: setSubnodeOwner v0.7+ call-shape probe.
//
// DotNS v0.7 added a 5th field (`persist: bool`) to the on-chain
// SubnodeRecord tuple setSubnodeOwner takes, changing the function selector
// — the legacy 4-field encoding now bare-reverts (flags=1, empty `0x` data)
// on a v0.7+ chain. resolveSubnodeOwnerShape/buildSetSubnodeOwnerCall
// (src/dotns.ts) dry-run-probe the WRITE itself: try the v0.7+ 5-field shape
// (persist:true — #1453: persist:false reverts NotAuthorised from a
// non-controller on v0.8.0) first, fall back to the legacy 4-field shape on
// a bare revert, and propagate a revert WITH data (a real rejection, not a
// shape mismatch) rather than falling back. The result is cached on the
// DotNS instance (`_subnodeOwnerShape`) for the life of the connection.

// Canonical raw shapes ReviveClientWrapper.performDryRunCall resolves to —
// mirrors the { result: { isOk, value: { data, flags } } } shape every other
// dry-run stub in this suite already returns from that method.
function bareRevertProbeResult() {
  return {
    gasConsumed: { referenceTime: 0n, proofSize: 0n },
    gasRequired: { referenceTime: 0n, proofSize: 0n },
    storageDeposit: { value: 0n },
    result: { isOk: false, isErr: true, value: { data: "0x", flags: 1n } },
  };
}
function revertWithDataProbeResult(data = "0x1648fd01") {
  return {
    gasConsumed: { referenceTime: 0n, proofSize: 0n },
    gasRequired: { referenceTime: 0n, proofSize: 0n },
    storageDeposit: { value: 0n },
    result: { isOk: false, isErr: true, value: { data, flags: 1n } },
  };
}
function okProbeResult() {
  return {
    gasConsumed: { referenceTime: 0n, proofSize: 0n },
    gasRequired: { referenceTime: 0n, proofSize: 0n },
    storageDeposit: { value: 0n },
    result: { isOk: true, isErr: false, value: { data: "0x" + "00".repeat(32), flags: 0n } },
  };
}

// A transferSubname stub whose subname ownership is STATEFUL — the post-tx
// owner() read reflects whatever contractTransaction's setSubnodeOwner call
// actually wrote — so the same `d` can be driven through transferSubname
// more than once in the same test (needed for the caching test below, where
// a second real-looking write must reuse rather than re-probe the shape).
function stubSubnameForShapeProbe({
  parentOwner = ADDR_OWNER,
  evmAddress = ADDR_OWNER,
  initialSubOwner = "0xOLD",
  tld = "dot",
  sublabel = "app",
  parentLabel = "foo",
  probeDryRunCall,
} = {}) {
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d.evmAddress = evmAddress;
  d.substrateAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  d._tld = tld;
  d._contracts = { DOTNS_REGISTRY: "0xRegistry" };
  d.ensureConnected = () => {};
  // The constructor defaults this to "legacy" precisely so a caller that
  // never connect()s keeps pre-#1435 behaviour with zero probing (see the
  // field's own comment in src/dotns.ts) — force it back to "unresolved" so
  // this test's probe stub actually runs.
  d.__setSubnodeOwnerShapeForTest(null);

  // bulletin-deploy #1443: transferSubname ALSO probes isAuthorised
  // (checkNodeAuthorization) before ever reaching the setSubnodeOwner shape
  // probe these tests exist to exercise — both go through the same
  // clientWrapper.performDryRunCall, so dispatch by selector: isAuthorised
  // always bare-reverts (this stub simulates a chain that predates that
  // accessor — orthogonal to what these tests probe), falling back to
  // owner()-equality, which passes because parentOwner === evmAddress by
  // default. Only the OTHER (setSubnodeOwner) probe calls count towards
  // getProbeCalls().
  let probeCalls = 0;
  d.clientWrapper = {
    performDryRunCall: async (_origin, _addr, _value, encodedData) => {
      if (encodedData.slice(0, 10) === IS_AUTHORISED_SELECTOR) return bareRevertProbeResult();
      probeCalls += 1;
      return probeDryRunCall(encodedData);
    },
  };

  const parentNode = namehash(`${parentLabel}.${tld}`);
  const subnode = namehash(`${sublabel}.${parentLabel}.${tld}`);
  let currentSubOwner = initialSubOwner;
  d.contractCallNullable = async (_addr, _abi, fn, args) => {
    if (fn !== "owner") throw new Error("unexpected call " + fn);
    const node = args[0];
    if (node === parentNode) return parentOwner;
    if (node === subnode) return currentSubOwner;
    throw new Error(`stubSubnameForShapeProbe: owner() called with unrecognised node ${node}`);
  };
  const submittedCalls = [];
  d.contractTransaction = async (_addr, _value, abi, fn, args) => {
    if (fn !== "setSubnodeOwner") throw new Error("unexpected tx " + fn);
    submittedCalls.push({ abi, args });
    currentSubOwner = args[0].owner; // simulate the write landing, for the post-tx re-read
    return { kind: "hash", hash: "0xsub" };
  };

  return { d, getProbeCalls: () => probeCalls, getSubmittedCalls: () => submittedCalls };
}

test("transferSubname: setSubnodeOwner shape probe falls back to the legacy 4-field tuple on a bare (selector-not-found) revert", async () => {
  const { d, getProbeCalls, getSubmittedCalls } = stubSubnameForShapeProbe({
    probeDryRunCall: bareRevertProbeResult,
  });
  const r = await d.transferSubname("app", "foo", "0x1111111111111111111111111111111111111111");
  assert.equal(r.status, "ok", `>> FAIL: setSubnodeOwner shape probe legacy fallback: expected status "ok", got "${r.status}"`);
  assert.equal(getProbeCalls(), 1, ">> FAIL: setSubnodeOwner shape probe legacy fallback: expected exactly one probe dry-run call");
  const [{ abi, args }] = getSubmittedCalls();
  assert.equal(
    abi[0].inputs[0].components.length, 4,
    `>> FAIL: setSubnodeOwner shape probe legacy fallback: expected the submitted record tuple to have 4 components (no persist field) on a bare-revert probe, got ${abi[0].inputs[0].components.length}`,
  );
  assert.ok(
    !("persist" in args[0]),
    ">> FAIL: setSubnodeOwner shape probe legacy fallback: submitted args must not carry a persist field on the legacy 4-field shape",
  );
});

test("transferSubname: setSubnodeOwner shape probe uses the v0.7+ 5-field tuple with persist:true when the dry-run accepts it", async () => {
  const { d, getSubmittedCalls } = stubSubnameForShapeProbe({
    probeDryRunCall: okProbeResult,
  });
  const r = await d.transferSubname("app", "foo", "0x1111111111111111111111111111111111111111");
  assert.equal(r.status, "ok", `>> FAIL: setSubnodeOwner shape probe v0.7+: expected status "ok", got "${r.status}"`);
  const [{ abi, args }] = getSubmittedCalls();
  assert.equal(
    abi[0].inputs[0].components.length, 5,
    `>> FAIL: setSubnodeOwner shape probe v0.7+: expected the submitted record tuple to have 5 components (incl. persist) when the v0.7+ dry-run succeeds, got ${abi[0].inputs[0].components.length}`,
  );
  assert.equal(
    args[0].persist, true,
    ">> FAIL: setSubnodeOwner shape probe v0.7+: persist must be true — dotns#305 restricts persist:false to registered controllers, so a mnemonic-signed account reverts NotAuthorised on DotNS v0.8.0",
  );
});

// The shape probe dry-runs the write it is about to make, so its persist value
// has to match the submitted one. dotns#305 rejects persist:false from a
// non-controller, and the probe classifies a revert-with-data as a real
// rejection, so a stale false here would fail during the probe rather than
// the write (bulletin-deploy #1453).
test("transferSubname: the shape probe dry-runs persist:true, matching what it submits (dotns#305)", async () => {
  let probedData = null;
  const { d } = stubSubnameForShapeProbe({
    probeDryRunCall: (encodedData) => { probedData ??= encodedData; return okProbeResult(); },
  });
  await d.transferSubname("app", "foo", "0x1111111111111111111111111111111111111111");
  assert.ok(probedData, ">> FAIL: shape probe never issued a dry run, so this test asserts nothing");
  const V07_ABI = [{ inputs: [{ name: "record", type: "tuple", components: [{ name: "parentNode", type: "bytes32" }, { name: "subLabel", type: "string" }, { name: "parentLabel", type: "string" }, { name: "owner", type: "address" }, { name: "persist", type: "bool" }] }], name: "setSubnodeOwner", outputs: [{ name: "subnode", type: "bytes32" }], stateMutability: "nonpayable", type: "function" }];
  const { args } = decodeFunctionData({ abi: V07_ABI, data: probedData });
  assert.equal(
    args[0].persist, true,
    ">> FAIL: the shape probe must dry-run persist:true. A false here reverts NotAuthorised on DotNS v0.8.0, and resolveSubnodeOwnerShape propagates a revert-with-data, so the probe fails before the write is ever attempted",
  );
});

test("transferSubname: setSubnodeOwner shape probe propagates a revert WITH data instead of falling back to the legacy shape", async () => {
  const { d, getSubmittedCalls } = stubSubnameForShapeProbe({
    probeDryRunCall: () => revertWithDataProbeResult("0x1648fd01"),
  });
  await assert.rejects(
    () => d.transferSubname("app", "foo", "0x1111111111111111111111111111111111111111"),
    /Contract execution would revert/,
    ">> FAIL: setSubnodeOwner shape probe real-revert: a revert WITH data on the v0.7+ probe is a real rejection (permissions, bad parent, etc.) and must propagate, not be swallowed into a shape-fallback attempt",
  );
  assert.equal(
    getSubmittedCalls().length, 0,
    ">> FAIL: setSubnodeOwner shape probe real-revert: setSubnodeOwner must never be submitted when the shape probe itself reverted with data",
  );
});

test("setSubnodeOwner shape is cached per connection: a second subname write does not re-probe", async () => {
  const { d, getProbeCalls, getSubmittedCalls } = stubSubnameForShapeProbe({
    probeDryRunCall: bareRevertProbeResult,
  });
  await d.transferSubname("app", "foo", "0x2222222222222222222222222222222222222222");
  assert.equal(getProbeCalls(), 1, ">> FAIL: setSubnodeOwner shape cache: expected the first subname write to probe exactly once");
  await d.transferSubname("app", "foo", "0x3333333333333333333333333333333333333333");
  assert.equal(
    getProbeCalls(), 1,
    ">> FAIL: setSubnodeOwner shape cache: a second subname write in the same connection re-probed instead of reusing the cached shape",
  );
  assert.equal(getSubmittedCalls().length, 2, ">> FAIL: setSubnodeOwner shape cache: expected both writes to actually submit a setSubnodeOwner transaction");
  for (const { abi } of getSubmittedCalls()) {
    assert.equal(abi[0].inputs[0].components.length, 4, ">> FAIL: setSubnodeOwner shape cache: both writes must use the same (cached) legacy shape");
  }
});

// registerSubdomain's batched setSubnodeOwner + setResolver call (the other
// #1435 call site) must go through the same shape probe/cache.
function stubRegisterSubdomainForShapeProbe({
  evmAddress = "0x4444444444444444444444444444444444444444",
  tld = "dot",
  probeDryRunCall,
} = {}) {
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d.evmAddress = evmAddress;
  d.substrateAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  d._tld = tld;
  d._contracts = { DOTNS_REGISTRY: "0xRegistry", DOTNS_CONTENT_RESOLVER: "0xResolver" };
  d.ensureConnected = () => {};
  d.__setSubnodeOwnerShapeForTest(null);

  let probeCalls = 0;
  d.clientWrapper = {
    client: { query: { Timestamp: { Now: { getValue: async () => 1_000_000n } } } },
    performDryRunCall: async () => {
      probeCalls += 1;
      return probeDryRunCall();
    },
  };
  let submittedCalls = null;
  d.submitBatchedContractCalls = async (calls) => {
    submittedCalls = calls;
    return { kind: "hash", hash: "0xsubdomaintx" };
  };
  return { d, getProbeCalls: () => probeCalls, getSubmittedCalls: () => submittedCalls };
}

test("registerSubdomain: batched setSubnodeOwner call also goes through the shape probe (v0.7+ 5-field + persist:true)", async () => {
  const { d, getSubmittedCalls } = stubRegisterSubdomainForShapeProbe({ probeDryRunCall: okProbeResult });
  await d.registerSubdomain("mywallet", "myapp");
  const calls = getSubmittedCalls();
  const setSubnodeOwnerCall = calls.find((c) => c.functionName === "setSubnodeOwner");
  assert.ok(setSubnodeOwnerCall, ">> FAIL: registerSubdomain setSubnodeOwner shape: expected a setSubnodeOwner call in the batched submission");
  assert.equal(
    setSubnodeOwnerCall.abi[0].inputs[0].components.length, 5,
    ">> FAIL: registerSubdomain setSubnodeOwner shape: expected the v0.7+ 5-field tuple when the probe accepts it",
  );
  assert.equal(setSubnodeOwnerCall.args[0].persist, true, ">> FAIL: registerSubdomain setSubnodeOwner shape: persist must be true on the v0.7+ path (dotns#305 gates persist:false to registered controllers)");
  const setResolverCall = calls.find((c) => c.functionName === "setResolver");
  assert.ok(setResolverCall, ">> FAIL: registerSubdomain setSubnodeOwner shape: setResolver call missing from the batch — setResolver's own shape is unaffected by v0.7 and must still be submitted alongside it");
});

test("setSubnodeOwner shape cache is shared across call sites: registerSubdomain reuses a shape transferSubname already resolved", async () => {
  const tld = "dot";
  const d = Object.create(DotNS.prototype);
  d.connected = true;
  d.evmAddress = "0x4444444444444444444444444444444444444444";
  d.substrateAddress = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  d._tld = tld;
  d._contracts = { DOTNS_REGISTRY: "0xRegistry", DOTNS_CONTENT_RESOLVER: "0xResolver" };
  d.ensureConnected = () => {};
  d.__setSubnodeOwnerShapeForTest(null);

  // Both the isAuthorised probe (checkNodeAuthorization, run on every
  // transferSubname call) and the setSubnodeOwner shape probe this test
  // actually exercises share this one clientWrapper — dispatch by selector
  // so only the shape probe counts towards probeCalls (isAuthorised always
  // bare-reverts, falling back to owner()-equality, which passes because
  // every owner() mock below returns the same address as d.evmAddress).
  let probeCalls = 0;
  d.clientWrapper = {
    client: { query: { Timestamp: { Now: { getValue: async () => 1_000_000n } } } },
    performDryRunCall: async (_origin, _addr, _value, encodedData) => {
      if (encodedData.slice(0, 10) === IS_AUTHORISED_SELECTOR) return bareRevertProbeResult();
      probeCalls += 1;
      return bareRevertProbeResult();
    },
  };

  // --- leg 1: transferSubname resolves + caches "legacy" ---
  const xferParentNode = namehash("foo.dot");
  const xferSubnode = namehash("app.foo.dot");
  let xferSubnodeCalls = 0;
  d.contractCallNullable = async (_addr, _abi, fn, args) => {
    if (fn !== "owner") throw new Error("unexpected call " + fn);
    const node = args[0];
    if (node === xferParentNode) return "0x4444444444444444444444444444444444444444";
    if (node === xferSubnode) { xferSubnodeCalls += 1; return xferSubnodeCalls === 1 ? "0x5555555555555555555555555555555555555555" : "0x1111111111111111111111111111111111111111"; }
    throw new Error("unrecognised node " + node);
  };
  d.contractTransaction = async (_addr, _value, _abi, fn) => {
    if (fn !== "setSubnodeOwner") throw new Error("unexpected tx " + fn);
    return { kind: "hash", hash: "0xsub" };
  };
  await d.transferSubname("app", "foo", "0x1111111111111111111111111111111111111111");
  assert.equal(probeCalls, 1, ">> FAIL: setSubnodeOwner shape cache (cross-call-site): expected transferSubname to probe exactly once");

  // --- leg 2: registerSubdomain must reuse the cached shape, no new probe ---
  let submittedCalls = null;
  d.submitBatchedContractCalls = async (calls) => { submittedCalls = calls; return { kind: "hash", hash: "0xreg" }; };
  await d.registerSubdomain("mywallet", "myapp");
  assert.equal(
    probeCalls, 1,
    ">> FAIL: setSubnodeOwner shape cache (cross-call-site): registerSubdomain re-probed even though transferSubname already resolved the shape earlier on this same connection",
  );
  const setSubnodeOwnerCall = submittedCalls.find((c) => c.functionName === "setSubnodeOwner");
  assert.equal(
    setSubnodeOwnerCall.abi[0].inputs[0].components.length, 4,
    ">> FAIL: setSubnodeOwner shape cache (cross-call-site): expected registerSubdomain to reuse the cached legacy shape",
  );
});
