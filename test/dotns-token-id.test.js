import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computeDomainTokenId, DEFAULT_TLD } from "../dist/dotns.js";
import { namehash } from "viem";

// #1240 follow-up (ported from the private twin, bulletin-deploy, where this
// bug was found and fixed in production — see that repo's #1240/#1244): the
// per-environment DotNS TLD port converted nine `namehash(`${x}.${this._tld}`)`
// template sites. It MISSED a tenth derivation — computeDomainTokenId
// hardcoded a `.dot` node (the old DOT_NODE constant) and hand-rolled
// `keccak256(concatHex([DOT_NODE, labelhash]))` instead — so a grep for
// "namehash(`" never matched it, and post-register ownerOf() always looked
// up the .dot tokenId no matter which env actually registered the name.
//
// Ground truth below is pulled from a REAL deploy of "ssoqedtuwf.paseo" on
// paseo-next-v2 (bulletin-deploy, the same physical chain this twin targets),
// block 24465 (ExtrinsicSuccess): the registrar minted tokenId
// 0x08d2efbf...043d8, but the (buggy, pre-fix) post-register ownerOf lookup
// queried 0x09a17726...ad2e7 — namehash("ssoqedtuwf.dot") — and reverted with
// ERC721NonexistentToken after the 11 PAS mint had already succeeded. These
// values cannot drift; they are literal on-chain fact, not derived from the
// code under test.
const PASEO_TOKEN_ID = 0x08d2efbf56d3825632503ef01734f6240aa49f4024c75caf83634a41b2e043d8n;
const DOT_TOKEN_ID = 0x09a17726efcde36396bb708ae23d986499bdd15c5e431723059c04280f5ad2e7n;
const LABEL = "ssoqedtuwf";

test("computeDomainTokenId: pins the real on-chain paseo tokenId from bulletin-deploy block 24465", () => {
  assert.equal(
    computeDomainTokenId(LABEL, "paseo"),
    PASEO_TOKEN_ID,
    `>> FAIL: computeDomainTokenId paseo: expected the block-24465 minted tokenId ${PASEO_TOKEN_ID}, got ${computeDomainTokenId(LABEL, "paseo")} — the .paseo node derivation has drifted`,
  );
});

test("computeDomainTokenId: pins the real on-chain dot tokenId (the WRONG id the pre-fix bug looked up)", () => {
  assert.equal(
    computeDomainTokenId(LABEL, "dot"),
    DOT_TOKEN_ID,
    `>> FAIL: computeDomainTokenId dot: expected ${DOT_TOKEN_ID}, got ${computeDomainTokenId(LABEL, "dot")} — the .dot node derivation has drifted`,
  );
});

test("computeDomainTokenId: paseo and dot tokenIds for the SAME label must differ", () => {
  assert.notEqual(
    computeDomainTokenId(LABEL, "paseo"),
    computeDomainTokenId(LABEL, "dot"),
    `>> FAIL: computeDomainTokenId cross-tld: paseo and dot tokenIds collided for label "${LABEL}" — TLD is not actually affecting the derivation, reintroducing the #1240 follow-up bug`,
  );
});

test("computeDomainTokenId: defaults to DEFAULT_TLD when no tld is passed", () => {
  assert.equal(
    computeDomainTokenId(LABEL),
    computeDomainTokenId(LABEL, DEFAULT_TLD),
    `>> FAIL: computeDomainTokenId default arg: no-tld call must match an explicit DEFAULT_TLD ("${DEFAULT_TLD}") call`,
  );
});

// Cross-check against the independent derivation: this is the equivalence
// that was silently violated by the hardcoded-.dot-node bug. Every other
// tokenId/node site in src/dotns.ts derives via namehash(`${x}.${tld}`); this
// asserts computeDomainTokenId agrees with that same primitive for both TLDs
// this twin actually uses on-chain today (paseo-next-v2 and devnet).
for (const tld of ["dot", "paseo"]) {
  test(`computeDomainTokenId: agrees with namehash(label.${tld}) directly`, () => {
    const expected = BigInt(namehash(`${LABEL}.${tld}`));
    assert.equal(
      computeDomainTokenId(LABEL, tld),
      expected,
      `>> FAIL: computeDomainTokenId vs namehash cross-check (${tld}): computeDomainTokenId(${JSON.stringify(LABEL)}, ${JSON.stringify(tld)}) = ${computeDomainTokenId(LABEL, tld)} but namehash("${LABEL}.${tld}") = ${expected} — the two derivation paths have diverged again`,
    );
  });
}

// Guard test (bulletin-deploy #1304): the whitelist-based guard this replaces
// enumerated the four shapes the ssoqedtuwf incident actually took (a
// hardcoded *_NODE hex constant, `concatHex(` reappearing, an inlined 32-byte
// hex literal in keccak256(...), or a literal ".dot" in a namehash()
// template). That only catches a NEW bad derivation if it happens to repeat
// an old mistake — a site written as `namehash(\`${x}.${someParam}\`)` with a
// stale local, a shadowed variable, or a wrongly-defaulted argument passes
// every one of those clauses, because none of them assert *how* the TLD
// reached the template.
//
// This guard is strictly stronger: it doesn't enumerate bad shapes at all. It
// asserts there is exactly ONE place in src/dotns.ts that calls viem's
// namehash(), and that it is inside the ensNode() primitive every
// node/tokenId derivation (computeDomainNode, computeDomainTokenId,
// computeSubnodeIds, checkTldNodeConsistency) is required to go through. A
// second derivation path — whatever shape it takes, including one that has
// never been seen before — cannot exist without adding a second textual
// `namehash(` call, which this test forbids outright.
//
// It still catches every one of the four original incident shapes: (a)/(c) a
// hardcoded node constant or an inlined hex literal fed into keccak256(...)
// bypass namehash() entirely, so they're covered by the concatHex/keccak256
// clauses kept below (constructing a node WITHOUT calling namehash() at all
// is the other half of the bug class this file must forbid); (b) concatHex(
// reappearing is the same manual-node-concat mechanism; (d) a literal ".dot"
// inside a namehash() template would itself BE a second `namehash(` call site
// (since it can't be the sole one inside ensNode, whose argument is a
// parameter, not a literal), so it is caught by the call-count check alone.
test("guard: namehash( is called from exactly one place in src/dotns.ts — the sole node-derivation primitive", () => {
  const srcPath = fileURLToPath(new URL("../src/dotns.ts", import.meta.url));
  const src = readFileSync(srcPath, "utf8");

  // Strip comments and string/template literal bodies before counting, so
  // prose that mentions "namehash(" (comments, error-message text) can't
  // masquerade as — or hide — a real call site. Order matters: strip block
  // comments, then backtick/double-quote string bodies, THEN line comments —
  // a `//` inside a quoted URL must be neutralized by the string strip
  // *before* the line-comment regex runs. Single-quoted strings are
  // deliberately NOT stripped: this file has none, only prose apostrophes
  // ("don't", "it's") in comments.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\/.*$/gm, "");

  const callSites = [...codeOnly.matchAll(/\bnamehash\(/g)];
  assert.equal(
    callSites.length,
    1,
    `>> FAIL: guard namehash chokepoint: found ${callSites.length} real call site(s) of namehash( in src/dotns.ts (expected exactly 1) — every node/tokenId derivation must go through the single ensNode() primitive; a second call site means a second, independently-writable derivation path exists again, which is the exact bug class that reverted after an 11 PAS mint had already succeeded`,
  );

  assert.match(
    src,
    /function ensNode\(fullName: string\): `0x\$\{string\}` \{\s*return namehash\(fullName\);\s*\}/,
    ">> FAIL: guard namehash chokepoint: the sole namehash( call must live inside the ensNode() primitive with this exact shape — if this fails, ensNode was renamed/reshaped without updating this pin",
  );

  // Keep the original guard's coverage of the two ways a node can be built
  // WITHOUT ever calling namehash() at all: a hardcoded *_NODE hex constant,
  // or a hand-rolled concatHex(...)/keccak256(...) reconstruction.
  const offenders = [];
  const nodeConstRe = /const\s+(\w*[Nn]ode\w*)\s*(?::\s*`[^`]*`)?\s*=\s*"(0x[0-9a-fA-F]{64})"/g;
  let m;
  while ((m = nodeConstRe.exec(src)) !== null) {
    offenders.push(`hardcoded *_NODE constant reintroduced: ${m[1]} = ${m[2]}`);
  }
  if (/\bconcatHex\s*\(/.test(src)) {
    offenders.push("concatHex(...) reappeared in src/dotns.ts — this is the manual node-concat mechanism the fix removed");
  }
  const inlineRe = /keccak256\([^)]*0x[0-9a-fA-F]{64}[^)]*\)/g;
  while ((m = inlineRe.exec(src)) !== null) {
    offenders.push(`32-byte hex literal inlined directly into keccak256(...): ${m[0].slice(0, 80)}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `>> FAIL: guard hardcoded TLD node: ${JSON.stringify(offenders)} — a namehash-of-a-TLD constant (like the old DOT_NODE) must never be hardcoded; derive it from the active tld via ensNode() at call time instead`,
  );
});

// Broader guard (twin-specific, #paseo-tld sweep): no *node-derivation* call
// site in src/dotns.ts may embed a literal ".dot" suffix inside a namehash()
// template — every one of the nine sites #1240 converted, PLUS
// DotNS.transferSubname (added by this twin's own PR #151, after the
// upstream #1240 port ran, and fixed separately) must interpolate the
// resolved tld instead. A regex for one syntax (namehash(`...dot`)) is
// exactly the kind of narrow sweep that missed computeDomainTokenId
// originally — this checks the namehash() call sites directly, independent
// of that guard.
test("guard: no namehash(...) call in src/dotns.ts embeds a literal .dot suffix", () => {
  const srcPath = fileURLToPath(new URL("../src/dotns.ts", import.meta.url));
  const src = readFileSync(srcPath, "utf8");
  const badNamehashRe = /namehash\(`[^`]*\.dot`\)/g;
  const offenders = [...src.matchAll(badNamehashRe)].map((m) => m[0]);
  assert.deepEqual(
    offenders,
    [],
    `>> FAIL: guard hardcoded .dot in namehash(): ${JSON.stringify(offenders)} — every namehash() call in a node-derivation path must interpolate the resolved tld (e.g. \${this._tld}), never a literal ".dot"`,
  );
});
