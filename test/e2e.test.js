import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "node:crypto";
import { mutateFixture, makeMultiChunkFixture } from "./helpers/e2e-fixture.js";
import { buildFixture as buildIncrementalFixture } from "./helpers/e2e-incremental-fixture.js";
import { buildManifestSidecar, buildPvmAppManifest } from "./helpers/e2e-manifest-fixture.js";
import { runBulletinDeploy } from "./helpers/e2e-cli.js";
import { trackTimers, armExitGuard } from "./helpers/e2e-exit-guard.js";
import { resolveContenthashOnChain, resolveTextRecordOnChain } from "./helpers/e2e-verify.js";
import { startFaultProxy } from "./helpers/ws-fault-proxy.mjs";
import { DEFAULT_MNEMONIC, sanitizeDomainLabel, DotNS, deploy, poolAccountDerivationPath } from "@parity/polkadot-app-deploy";
import { probeSignerPopStatus } from "./helpers/probe-pop-status.js";
import { resolveE2eEnv, resolveE2eEnvId } from "./helpers/e2e-env.js";
import { encodeContenthash, DEFAULT_BULLETIN_RPC } from "@parity/polkadot-app-deploy/deploy";
import { fetchManifestRoundtrip } from "@parity/polkadot-app-deploy/manifest-roundtrip";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { getPolkadotSigner } from "polkadot-api/signer";
import {
  assertDeploySucceeded,
  assertStdoutMatches,
  parseLineOrExplain,
  assertOnChainMatches,
  failWith, assertFixtureOwnership, assertFixtureNotDrifted } from "./helpers/e2e-failure.js";

// The CLI prints "CID: bafy..." at the end of a successful deploy. We parse
// that — not a client-side recomputation — so we verify "what the CLI said
// it uploaded matches what DotNS stores", avoiding any merkleization
// determinism rabbit hole.
function parseDeployedCid(stdout, scenario = "deploy") {
  // Walk lines bottom-up: the CLI prints the final CID near the end, possibly
  // after non-CID lines. parseLineOrExplain on the full blob would match the
  // FIRST occurrence (top-down); we want the last.
  const lines = String(stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^CID:\s+(bafy\S+)/);
    if (m) return m[1];
  }
  // No CID found — throw via the helper for structured output.
  return parseLineOrExplain(stdout, {
    pattern: /^CID:\s+(bafy\S+)/m,
    scenario,
    what: "deployed CID",
    hint: "every successful deploy ends with a 'CID: bafy...' line. Missing means the CLI failed before final-summary emission (check earlier stderr).",
  })[1];
}

// Parse the chunk-skip rate from a deploy's stdout.
// Looks for the Probed summary line emitted by renderSummary in incremental-stats.ts:
//   "  Probed:        18 chunks  →  15 on chain, 2 absent"
// Returns probePresent / probedTotal as a number in [0, 1].
// Throws if the Probed line is missing — a silent pass on a missing parse is
// more dangerous than a false-positive test failure.
function parseChunkSkipRateFromOutput(stdout, scenario = "S-INC") {
  const m = parseLineOrExplain(stdout, {
    pattern: /Probed:\s+(\d+)\s+chunks\s+→\s+(\d+)\s+on chain/,
    scenario,
    what: "chunk-probe summary line",
    hint: "format changed in #518 from 'cached, to upload' to 'on chain, absent'. If the CLI wording changed again, update the pattern here; if the deploy never ran the incremental path, check the manifest-fetch logs.",
  });
  const probedTotal = parseInt(m[1], 10);
  const probePresent = parseInt(m[2], 10);
  // 0/0 = no chunks to probe = fast-path / no work. The caller's regression
  // check (skipRate < 0.6) treats this as "fully skipped" rather than a
  // false-positive regression — returning 0 here would fire even though
  // nothing was actually re-uploaded.
  if (probedTotal === 0) return 1;
  return probePresent / probedTotal;
}

// Parse bytes uploaded from the spec § 9 summary line:
//   "  Upload:        2.1 MB across 3 chunks (vs 5.1 MB if full deploy)"
// Returns bytesUploaded as a number in bytes (decimal MB × 1,000,000).
// Returns 0 when the line is absent — perfect cache case (nothing uploaded)
// legitimately omits the line. Tests asserting "<= N KB" pass trivially in
// that case, which is the right behavior.
function parseBytesUploadedFromOutput(stdout) {
  const m = stdout.match(/Upload:\s+([\d.]+)\s+MB\s+across\s+(\d+)\s+chunks/);
  if (!m) return 0;
  return parseFloat(m[1]) * 1_000_000;
}

// Apply a Vite-rebuild patch to a v1 fixture, producing a "v2" build in-place.
// The patch directory contains:
//   - patch.json: { delete: [...] } listing files to remove from v1
//   - patch/: directory whose contents are copied over v1 (overwrites + adds)
// This simulates a real frontend rebuild where one source file changed,
// causing Vite to emit a new content-hashed bundle filename and update
// index.html's script tag.
function applyVitePatch(targetDir, fixtureRoot) {
  const patchManifest = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "patch.json"), "utf-8")
  );
  for (const rel of patchManifest.delete ?? []) {
    const abs = path.join(targetDir, rel);
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  }
  fs.cpSync(path.join(fixtureRoot, "patch"), targetDir, { recursive: true });
}

// On-chain reads can lose a race with tail-in-flight txs from a cancelled
// earlier run (GH cancel-in-progress cancels the job but doesn't rollback
// submitted txs). Retry a few times — the expected value is the last-written
// one, so it wins once all concurrent tx propagation settles.
async function readContenthashWithRetry(label, expected, attempts = 6, delayMs = 10_000) {
  let onChain = "";
  for (let i = 1; i <= attempts; i++) {
    onChain = (await resolveContenthashOnChain(label, E2E_ENV_ID)).toLowerCase();
    if (onChain === expected) return onChain;
    if (i < attempts) {
      console.log(`  verify attempt ${i}/${attempts}: on-chain=${onChain.slice(0, 18)}... expected=${expected.slice(0, 18)}... — retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return onChain;
}

// Poll a text record until `ready(raw)` holds. On-chain reads can lose a race
// with tail-in-flight txs, same as readContenthashWithRetry above.
async function readTextRecordWithRetry(label, key, envId, ready, attempts = 6, delayMs = 10_000) {
  let raw = "";
  for (let i = 1; i <= attempts; i++) {
    raw = await resolveTextRecordOnChain(label, key, envId);
    if (ready(raw)) return raw;
    if (i < attempts) {
      console.log(`  ${key} text-record read attempt ${i}/${attempts}: ${raw ? "present, not ready yet" : "empty"}, retrying in ${delayMs / 1000}s`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return raw;
}

let signerPopStatus = -1;

const ENABLED = process.env.E2E === "1";
if (ENABLED) trackTimers();
const SIGNER = process.env.E2E_SIGNER ?? "pool";
const MERKLE = process.env.E2E_MERKLE ?? "js";
const SCENARIO = process.env.E2E_SCENARIO ?? "s1";
const PAD_ENV =
  process.env.PAD_ENV ??
  process.env.DOTNS_ENV ??
  null;
if (process.env.DOTNS_ENV && !process.env.PAD_ENV) {
  console.warn("DOTNS_ENV is deprecated; use PAD_ENV. Will be removed in a future release.");
}
// The env the run deploys against, explicit or the CLI's own default.
const E2E_ENV_ID = resolveE2eEnvId(PAD_ENV);
const RUN_TAG = `${process.env.GITHUB_RUN_ID ?? "local"}-${(process.env.GITHUB_SHA ?? "dev").slice(0, 7)}`;
process.env.DEPLOY_TAG ??= "e2e-local";
if (ENABLED && !process.env.DEPLOY_TAG?.startsWith("e2e-")) {
  throw new Error(`E2E deploy tag must start with 'e2e-' (got: ${process.env.DEPLOY_TAG}). Check DEPLOY_TAG env var.`);
}
const RUN_TOKEN = `${process.env.GITHUB_RUN_ID ?? "local"}${(process.env.GITHUB_SHA ?? "dev").slice(0, 7)}`.toLowerCase().replace(/[^a-z0-9]/g, "");
const DEPLOY_TIMEOUT_MS = 15 * 60 * 1000;

const ALICE_MNEMONIC = DEFAULT_MNEMONIC;

function pickStableLabel() {
  if (SIGNER === "direct") {
    return signerPopStatus >= 2 ? "e2edirect" : "e2edirect01";
  }
  // #1054: a pinned pool leg owns its own per-leg domain (e2epoolleg<NN>).
  const perLeg = perLegPoolLabel();
  if (perLeg) return perLeg;
  // E2E_POOL_LABEL lets nightly-pr-coverage use a dedicated pool fixture domain
  // (e2eprpool01) so it doesn't contend with nightly-s1-pool on e2epoolns01.
  if (process.env.E2E_POOL_LABEL) return process.env.E2E_POOL_LABEL;
  return signerPopStatus >= 2 ? "e2epool" : "e2epoolns01";
}

function pickDirectLabel() {
  return signerPopStatus >= 2 ? "e2edirect" : "e2edirect01";
}
// Per-leg domain isolation for nightly-pr-coverage (#863 follow-up). Multiple
// pool legs (s-inc js/kubo, s-inc-roundtrip, s-inc-portability) share pickIncLabel
// and otherwise deploy to the SAME domain (e2eincpool01) concurrently → setContenthash
// overwrite race. When BULLETIN_POOL_ACCOUNT_INDEX is set (the matrix pins a distinct
// pool account per leg), append it as a zero-padded 2-digit suffix to give each leg a
// distinct domain. 2 trailing digits pass the DotNS sanitizer unchanged; the NoStatus
// branch keeps a ≥9-char base (e2eincpool/e2erotpool) so the fresh domain is registerable
// without full PoP. Unset (normal/non-CI deploys, main nightly chain) → unchanged.
function poolLegSuffix() {
  const idx = process.env.BULLETIN_POOL_ACCOUNT_INDEX;
  if (idx == null || idx === "") return null;
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0 || n > 99) return null;
  return String(n).padStart(2, "0");
}
// #1054: when a pool leg is pinned to a pool account (BULLETIN_POOL_ACCOUNT_INDEX),
// that account is the DotNS OWNER too (not bare Alice), so concurrent legs stop
// sharing Alice's single Asset Hub nonce (the `Invalid: Stale` collision class).
function poolLegIndex() {
  const idx = process.env.BULLETIN_POOL_ACCOUNT_INDEX;
  if (idx == null || idx === "") return null;
  const n = Number(idx);
  return Number.isInteger(n) && n >= 0 && n <= 99 ? n : null;
}
// Per-leg DotNS domain owned by that leg's pool account. Base "e2epoolleg" (10 chars,
// ≥9 so a NoStatus account can register it) + zero-padded 2-digit index. Round-trips
// through sanitizeDomainLabel unchanged (asserted in test/test.js).
function perLegPoolLabel() {
  const n = poolLegIndex();
  return n == null ? null : `e2epoolleg${String(n).padStart(2, "0")}`;
}
// DotNS-owner CLI args for a pinned pool leg: sign DotNS ops as //deploy/<index>
// (the SAME account used for Bulletin storage), not the default bare Alice.
function poolOwnerArgs() {
  const n = poolLegIndex();
  return n == null ? [] : ["--mnemonic", ALICE_MNEMONIC, "--derivation-path", poolAccountDerivationPath(n)];
}
function pickIncLabel() {
  const perLeg = perLegPoolLabel();
  if (perLeg) return perLeg;
  const suf = poolLegSuffix();
  if (signerPopStatus >= 2) return suf ? `e2einc${suf}` : "e2einc";
  return suf ? `e2eincpool${suf}` : "e2eincpool01";
}
function pickRotLabel() {
  const perLeg = perLegPoolLabel();
  if (perLeg) return perLeg;
  const suf = poolLegSuffix();
  if (signerPopStatus >= 2) return suf ? `e2erot${suf}` : "e2erot";
  return suf ? `e2erotpool${suf}` : "e2erotpool01";
}

export function noStatusRunLabel(prefix) {
  return sanitizeDomainLabel(`${prefix}${RUN_TOKEN}x00`);
}

// Builds the sanitizer-safe label used by pickFreshRunLabel's PoP-Full branch.
// Exported (with `tag` as an explicit param) so the fix is unit-testable in
// test/test.js without depending on the module-level RUN_TAG/signerPopStatus
// state, which is fixed at import time and can't vary across "invocations"
// within one process.
//
// Root cause this guards against: RUN_TAG = `${run_id}-${sha7}`. When the
// sha7 suffix happens to be all-decimal-digits (recorded failure:
// "26648857693-2994449", sha7 = "2994449"), the *entire* post-prefix portion
// of the raw string is digits/dashes, so sanitizeDomainLabel's trailing-digit
// collapse strips it down to `<prefix>` + the last 2 digits of the ORIGINAL
// sha (here "49") — a value that's IDENTICAL across every run that shares
// that HEAD sha, e.g. "e2esub49" every nightly run in a row until `main`
// advances. That's the nightly `@HEAD s-subdomain` collision: "Domain
// e2esub49.dot is already owned by ...".
//
// Fix: anchor the trailing-digit run at exactly 2 by appending a non-digit
// letter + fixed "00" (mirrors noStatusRunLabel's `x00` trick above).
// sanitizeDomainLabel's `trailingDigitCount === 2` fast path then returns the
// WHOLE string unchanged, so 100% of `tag`'s per-run entropy (run_id AND
// sha) survives sanitization no matter how the sha happens to end.
export function buildFreshLabelFromTag(prefix, tag) {
  return sanitizeDomainLabel(`${prefix}${tag}x00`);
}

export function pickFreshRunLabel(prefix) {
  if (signerPopStatus < 2) return noStatusRunLabel(prefix);
  return buildFreshLabelFromTag(prefix, RUN_TAG);
}

// Idempotency helper for the S-TRANSFER* scenarios (bulletin #1364/#1334). The
// release retry wrapper (tools/release-retry-wrapper.mjs) re-runs this whole
// test file on a transient failure, and RUN_TAG (`${GITHUB_RUN_ID}-${sha7}`) /
// RUN_TOKEN are fixed for the run, so a retry reuses the SAME label the first
// attempt used — and DotNS ownership persists on chain across that retry.
// DotNS.register() is NOT idempotent: ensureNotRegistered throws "Domain X
// already owned by Y" for ANY existing owner, including the same signer that
// registered it moments ago. So a retry that got far enough to register (or
// further) would hard-fail here instead of converging.
//
// Deliberately NOT a pre-read via DotNS.checkOwnership: that helper ends in
// `catch { return { owned: false, owner: null } }` — a flaked ownerOf read
// (the documented paseo-next-v2 timeout flake under E2E matrix load) would be
// swallowed into "unregistered", we'd call register() anyway, and walk
// straight into the exact "already owned by" failure this fix exists to
// avoid. Instead, attempt register() and only treat ITS "already owned by
// <addr>" failure — which ensureNotRegistered only ever throws after a real
// successful non-zero ownerOf read, never on a swallowed RPC error — as a
// converge-to-<addr> signal. Any other failure propagates unchanged. No
// wasted on-chain writes either way: ensureNotRegistered runs (in parallel
// with classifyName) before the commit-reveal transaction, so a thrown
// "already owned" never got that far.
//
// Exported (with `reg` as an injectable param exposing only `.register`) so
// this is unit-testable in test/test.js without a live chain.
export async function registerOrConverge(reg, label) {
  try {
    await reg.register(label);
    return null; // freshly registered by the connected signer
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const m = msg.match(/already owned by (0x[0-9a-fA-F]+)/i);
    if (!m) throw err;
    return m[1];
  }
}

// Shared by S-TRANSFER and S-TRANSFER-SUBNAME's setup: registerOrConverge a
// label, then assert its existing owner (if any) is one of the accounts this
// scenario expects — anything else means the fixture drifted to a genuine
// third party, and converging past that silently would hide a real problem.
// Returns the existing owner (or null for a fresh registration) so callers
// that need to branch on WHICH allowed account it was (S-TRANSFER: Alice vs.
// Bob) still can.
export async function registerOrConvergeChecked(reg, label, allowedOwners, failContext) {
  const existingOwner = await registerOrConverge(reg, label);
  if (existingOwner === null) return null;
  assert.ok(
    allowedOwners.some((addr) => addr.toLowerCase() === existingOwner.toLowerCase()),
    `>> FAIL: ${failContext}: ${label} is owned by an unexpected third party ${existingOwner} — cannot converge as either a fresh registration or a retry of this run`,
  );
  return existingOwner;
}

// Burst-heavy re-upload scenarios get a DEDICATED derived signer so they don't
// contend on Alice's shared nonce stream (the documented Invalid::Stale failure
// mode — see the MANIFEST_SCENARIOS note below). These accounts are provisioned
// (funded + Bulletin-authorized) by tools/setup-e2e-derivation-signers.mjs.
// Applied regardless of E2E_ENV_ID — every other direct-signer leg signs as
// root Alice, who owns the e2edirect fixtures on every env the harness
// deploys to.
const ISOLATED_DIRECT_SIGNERS = {
  "s9": "//e2e-s9",
  "s-grandpa-reupload": "//e2e-sgrandpa",
};

function directSignerDerivationPath() {
  return ISOLATED_DIRECT_SIGNERS[SCENARIO] ?? null;
}

function buildArgs(fixtureDir, label) {
  const args = [fixtureDir, label, "--tag", process.env.DEPLOY_TAG];
  if (MERKLE === "js") args.push("--js-merkle");
  args.push("--env", E2E_ENV_ID);
  // Direct-signer e2e leg: signs as root Alice, who owns the e2edirect
  // fixtures on every env the harness deploys to (isolated per-scenario
  // signers, e.g. S9/S-GRANDPA-REUPLOAD, override via directSignerDerivationPath()).
  if (SIGNER === "direct") {
    args.push("--mnemonic", ALICE_MNEMONIC);
    const deriv = directSignerDerivationPath();
    if (deriv) args.push("--derivation-path", deriv);
  } else {
    // #1054: a pinned pool leg signs DotNS as its own pool account (//deploy/<index>),
    // which owns its per-leg domain — no more shared bare-Alice Asset Hub nonce.
    args.push(...poolOwnerArgs());
  }
  // Manifest sidecar is restricted to the scenarios where the manifest path is
  // load-bearing for coverage (s1 happy-path, s-inc incremental). Running it
  // unconditionally on every @HEAD scenario added ~70 extra Asset Hub txs per
  // run on Alice's shared nonce stream, evicting sibling jobs from the mempool
  // and blowing through the 3-attempt × 180s retry budget.
  const MANIFEST_SCENARIOS = new Set(["s1", "s-inc"]);
  if (MANIFEST_SCENARIOS.has(SCENARIO)) {
    // Every manifest scenario passes an already-suffixed domain, so the env's
    // TLD comes from the argument itself. A literal default would double-suffix
    // a label that already carries a non-"dot" TLD (#1244).
    assert.ok(label.includes("."),
      `>> FAIL: buildArgs: ${SCENARIO} builds a manifest sidecar and needs the env's TLD, but got the bare label "${label}". Pass the domain with its resolveE2eTld() suffix.`);
    const sidecarTld = label.slice(label.lastIndexOf(".") + 1);
    const { configPath } = buildManifestSidecar({ buildDir: fixtureDir, label, tld: sidecarTld });
    args.push("--config", configPath);
  }
  return args;
}

function buildInputCarArgs(dumpPath, label) {
  const args = ["--input-car", dumpPath, label, "--tag", process.env.DEPLOY_TAG];
  args.push("--env", E2E_ENV_ID);
  if (SIGNER === "direct") {
    args.push("--mnemonic", ALICE_MNEMONIC);
    const deriv = directSignerDerivationPath();
    if (deriv) args.push("--derivation-path", deriv);
  } else {
    // #1054: a pinned pool leg signs DotNS as its own pool account (//deploy/<index>).
    args.push(...poolOwnerArgs());
  }
  return args;
}

async function resolveDotnsEnvConnectOptions() {
  return (await resolveE2eEnv(E2E_ENV_ID)).dotnsConnectOptions;
}

// #paseo-tld: DotNS's TLD is per-environment (paseo-next-v2 following its
// redeploy: "paseo" — see src/environments.ts's per-env `tld` field). Every
// `.dot`-suffixed label/target in this file below must resolve through this
// helper instead of hardcoding the old suffix, or deploys/assertions
// silently target the wrong on-chain node.
async function resolveE2eTld() {
  return (await resolveE2eEnv(E2E_ENV_ID)).tld;
}

async function resolveE2eGateway() {
  if (process.env.BULLETIN_GATEWAY) return normalizeGatewayBase(process.env.BULLETIN_GATEWAY);
  return normalizeGatewayBase((await resolveE2eEnv(E2E_ENV_ID)).gateway);
}

async function resolveE2eBulletinRpc() {
  return (await resolveE2eEnv(E2E_ENV_ID)).bulletin;
}

function normalizeGatewayBase(url) {
  return url.replace(/\/+$/, "").replace(/\/ipfs$/, "");
}

// --- S-V060-UNBLOCK label builders (bulletin #1423, issue #1410) --------
//
// These build the two label SHAPES v0.6.0 unblocks, deliberately WITHOUT
// going through sanitizeDomainLabel or noStatusRunLabel/pickFreshRunLabel —
// both of those exist to normalize a label to something already registrable
// on every profile, which would defeat the entire point here (the shapes
// below are illegal PRE-v0.6.0 by design; sanitizing them away would test
// nothing). validateDomainLabel itself does no digit-shape rewriting (only
// charset/length/hyphen-edge checks — see src/CLAUDE.md), so a raw string
// built here reaches classifyLabelStatus completely unmodified.
//
// Digit->letter substitution (0-9 -> a-j) so a numeric tag (RUN_TOKEN is
// `${GITHUB_RUN_ID}${sha7}`) can supply per-run entropy for the BASE portion
// of a label without ever contributing a digit itself — both builders need
// total control over the trailing digit COUNT (exactly 2 for one, exactly 1
// for the other), so the entropy segment must never end in (or consist of)
// a raw digit.
function tagToLetters(tag) {
  return String(tag)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d)));
}

// Both label shapes below need a FIXED-WIDTH entropy segment (8 chars total
// for the base-8 shape leaves only 5 free chars once the fixed prefix/anchor
// letter are accounted for) — too narrow to embed `tag` verbatim the way
// buildFreshLabelFromTag does. A naive tail-slice of `tag` was tried first
// and rejected: RUN_TOKEN is `${GITHUB_RUN_ID}${sha7}`, and slicing only the
// last N characters lands entirely inside sha7 (7 chars, longer than either
// entropy segment), so two DIFFERENT run_ids sharing the SAME HEAD sha (the
// exact, documented buildFreshLabelFromTag regression — sha7 genuinely
// repeats across a run of nightlies until `main` advances) produced the
// IDENTICAL label. Hashing the WHOLE tag (SHA-1, cheap, deterministic, no
// external dependency) instead makes every output character sensitive to
// every input character via the hash's avalanche property, so run_id and
// sha7 both matter regardless of entropy-segment width.
function hashLettersFromTag(tag, length) {
  const hex = createHash("sha1").update(String(tag)).digest("hex");
  return tagToLetters(hex).slice(0, length);
}

// The production "dotworld01" shape: an 8-character base with EXACTLY 2
// trailing digits. Old profiles (poprules-startingPrice/v0.5.8-rc1):
// baseLength = 10 - 2 = 8 (the 6-8 band), trailingDigits===2 means
// isLiteSignal is true, so classifyByLadder returns PopLite — a NoStatus
// signer cannot register it (classifyRegistrability itself does NOT object
// to this shape; the demand is a personhood-TIER requirement, checked
// separately by canRegister/classifyDotnsLabel, not a naming-rule
// violation). v0.6.0: no lite-username match (no '.' separator), so
// baseLength = label.length AS WRITTEN = 10 -> NoStatus, open to any account
// (classifyLabelStatus's v0.6.0 branch, src/dotns.ts). `tag` is an explicit
// param (mirrors buildFreshLabelFromTag) so this is unit-testable without
// depending on module-level RUN_TOKEN state.
export function buildBase8TwoDigitLabel(tag) {
  const entropy = hashLettersFromTag(tag, 5);
  const base = `dw${entropy}x`; // 2 + 5 + 1 = 8 chars, always ends in a letter
  return `${base}01`; // 10 chars total, exactly 2 trailing digits
}

// A "myapp-pr7" shape: EXACTLY 1 trailing digit, total length >= 9 as
// written. Old profiles: classifyLabelStatus's trailing-digit-count gate
// fires on trailingDigits===1 regardless of baseLength -> Reserved
// (unregistrable — classifyRegistrability itself refuses this one, rule
// "trailing-digits"). v0.6.0: that rule is deleted entirely (#1410) ->
// baseLength = label.length AS WRITTEN (>= 9) -> NoStatus.
export function buildOneTrailingDigitLabel(tag) {
  const entropy = hashLettersFromTag(tag, 8);
  return `pr${entropy}7`; // 2 + 8 + 1 = 11 chars, exactly 1 trailing digit
}

// Detect the live DotNS ABI profile via a short-lived, read-only connection —
// the SAME detection connect() itself runs (detectProtocolVersion, src/dotns.ts),
// never inferred from E2E_ENV_ID's name or environments.json config (a
// configured `dotnsProtocol` pin is asserted against the live probe, never
// obeyed over it — see connect()'s own comment). Reads the profile via the
// public `protocolVersion` getter, not by scraping connect()'s own log line.
// Used by S-V060-UNBLOCK to decide whether the chain has the v0.6.0 redeploy
// before spending a real deploy attempt on label shapes that only make sense
// there.
//
// Returns a STRUCTURED outcome, not a bare profile string, because "no
// contract code at the configured POP_RULES address" and "a different, real
// ABI profile is live" are DIFFERENT conditions with DIFFERENT remedies (wait
// for an in-flight redeploy vs. point --env at a chain that already has
// v0.6.0) and must never be collapsed into one "not v0.6.0" message —
// classifyProtocolVersion (src/dotns-protocol.ts) gives the no-code case its
// own distinct reason text ("No contract deployed at this address…") for
// exactly this reason; this helper preserves that distinction instead of
// flattening it. Any OTHER detection failure (code present-or-unverified but
// neither discriminator answered; a genuine connection/RPC error) is NOT
// classified as either of the two known outcomes and is rethrown — an
// unclassified condition must fail loudly, never silently read as a skip.
async function detectDotnsProfile() {
  const probe = new DotNS();
  try {
    await probe.connect({ mnemonic: DEFAULT_MNEMONIC, ...(await resolveDotnsEnvConnectOptions()) });
    return { profile: probe.protocolVersion, noCode: false, error: null };
  } catch (e) {
    const msg = e?.message ?? String(e);
    if (/No contract deployed at this address/.test(msg)) {
      return { profile: null, noCode: true, error: msg };
    }
    throw e;
  } finally {
    probe.disconnect();
  }
}

describe("e2e", { skip: !ENABLED }, () => {
  after(() => armExitGuard());
  before(async () => {
    signerPopStatus = await probeSignerPopStatus({
      dotnsFactory: () => new DotNS(),
      signer: SIGNER,
      bulletinDeployEnv: E2E_ENV_ID,
      resolveEnvConnectOptions: resolveDotnsEnvConnectOptions,
      defaultMnemonic: DEFAULT_MNEMONIC,
      derivationPath: directSignerDerivationPath(),
    });
  });

  describe("S1 — happy path, stable label", { skip: SCENARIO !== "s1" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} to stable label`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = pickStableLabel();
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S1" });

        const deployedCid = parseDeployedCid(stdout, "S1");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S1", label });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S1-SMOKE — happy path, per-run fresh label", { skip: SCENARIO !== "s1-smoke" }, () => {
    test(`smoke ${SIGNER}/${MERKLE} on fresh label`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = pickFreshRunLabel("e2esmoke");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assert.strictEqual(code, 0, `deploy failed (exit ${code}). Stderr tail: ${stderr.slice(-500)}`);

        const deployedCid = parseDeployedCid(stdout);
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assert.strictEqual(onChain, expected,
          `on-chain contenthash must match the CID the CLI uploaded (${deployedCid})`);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S2 — happy path, fresh registration", { skip: SCENARIO !== "s2" }, () => {
    test(`fresh-register ${SIGNER}/${MERKLE}`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      // Full-status signers keep the historical fresh label. NoStatus signers
      // need a base length >= 9 with exactly two trailing digits so v2 does not
      // require Personhood status that the signer does not already have.
      const label = pickFreshRunLabel("e2e-fresh");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S2" });

        const deployedCid = parseDeployedCid(stdout, "S2");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S2", label });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S-TRANSFER — register then hand over via the transfer command", { skip: SCENARIO !== "s-transfer" }, () => {
    // Exercises the zero-mobile-sig transfer mechanism on chain: a worker
    // (Alice) registers a name, then the `transfer` recovery command hands it to
    // a recipient and is idempotent on re-run. A NoStatus-class label keeps this
    // registrable regardless of Alice's live PoP tier. The recipient is an
    // explicit H160 (Bob) so the scenario needs no mobile session — the deploy
    // orchestration's session→recipient path is covered by unit tests +
    // resolveDeployActors, and the full session flow by the manual e2e-local proof.
    const BOB_H160 = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
    test(`register as Alice → transfer to recipient → idempotent re-run`, { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      const label = noStatusRunLabel("e2exfer");
      const connectOpts = await resolveDotnsEnvConnectOptions();
      const envArgs = ["--env", E2E_ENV_ID];

      // 1. Register a fresh name owned by Alice (in-process — no storage upload,
      //    keeping the flake surface to the DotNS commit-reveal path only).
      //    Retry-safe: if a prior, transiently-failed attempt within this same
      //    run already carried this label all the way to the recipient (Bob),
      //    there is nothing left for Alice to register or transfer — record
      //    that so step 2 expects the CLI's idempotent no-op output instead of
      //    a fresh "Transferred" (see registerOrConverge above for why
      //    register() itself can't just be re-run unconditionally).
      const reg = new DotNS();
      await reg.connect({ mnemonic: DEFAULT_MNEMONIC, ...connectOpts });
      const aliceH160 = reg.evmAddress;
      assert.notEqual(
        aliceH160.toLowerCase(), BOB_H160.toLowerCase(),
        ">> FAIL: S-TRANSFER: worker must differ from the recipient or the transfer is a no-op",
      );
      let preOwnedByRecipient = false;
      try {
        const existingOwner = await registerOrConvergeChecked(reg, label, [aliceH160, BOB_H160], "S-TRANSFER");
        if (existingOwner !== null) {
          preOwnedByRecipient = existingOwner.toLowerCase() === BOB_H160.toLowerCase();
        }
      } finally {
        reg.disconnect();
      }

      // 2. Hand over via the `transfer` CLI command (exercises commands/transfer.ts
      //    + DotNS.transferName + the live transferFloor quote). transferName
      //    asserts ownerOf == recipient before returning, so exit 0 IS the
      //    on-chain proof the transfer landed. On a genuinely fresh run this
      //    must still be a real "Transferred" — preOwnedByRecipient only
      //    relaxes the expectation when the on-chain state already proved
      //    (above) that a prior attempt completed the handover.
      const t1 = await runBulletinDeploy({
        args: ["transfer", label, "--to", BOB_H160, ...envArgs],
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      assert.equal(
        t1.code, 0,
        `>> FAIL: S-TRANSFER: transfer command exited ${t1.code}: ${(t1.stderr || t1.stdout).split("\n").slice(-3).join(" ")}`,
      );
      assert.match(
        t1.stdout,
        preOwnedByRecipient ? /already owned by/i : /Transferred .* to 0x41dccbd4/i,
        preOwnedByRecipient
          ? ">> FAIL: S-TRANSFER: retry of an already-completed handover should report the recipient already owns it, not attempt a fresh transfer"
          : ">> FAIL: S-TRANSFER: transfer command did not report a successful handover to the recipient",
      );

      // 3. Re-run: idempotent no-op (recipient already owns it).
      const t2 = await runBulletinDeploy({
        args: ["transfer", label, "--to", BOB_H160, ...envArgs],
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      assert.equal(
        t2.code, 0,
        `>> FAIL: S-TRANSFER: idempotent re-run exited ${t2.code}: ${(t2.stderr || t2.stdout).split("\n").slice(-3).join(" ")}`,
      );
      assert.match(
        t2.stdout, /already owned by/i,
        ">> FAIL: S-TRANSFER: second transfer should be a no-op (already-owned), not a re-transfer",
      );
    });
  });

  // S-TRANSFER-SUBNAME — the `transfer` command's subname path (port of
  // bulletin-deploy PR #150/#151: the `app.<name>` subnames deploy itself
  // creates could not be moved by `transfer` at all — a subname argument
  // failed validateDomainLabel's "Invalid domain label" check on the `.`, and
  // even past that transferName only moves base names as ERC-721 tokens, so
  // there was no code path for a subname at all). No E2E coverage of this
  // path existed anywhere before this scenario.
  //
  // Two legs under fresh-per-run parents (mirrors S-SUBDOMAIN's before()):
  //   handover          — register app.<parent> as Alice, hand it to a
  //                        recipient via the CLI, verify the on-chain subnode
  //                        owner actually changed, then re-run for idempotency
  //   not-parent-owner  — attempt to transfer a subname whose parent is owned
  //                        by Alice, but signed as an account that is NOT
  //                        Alice; must fail with the actionable
  //                        parent-ownership error, never the old misleading
  //                        "Invalid domain label"
  describe("S-TRANSFER-SUBNAME — transfer a subname via setSubnodeOwner", { skip: SCENARIO !== "s-transfer-subname", concurrency: false }, () => {
    const RECIPIENT_H160 = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
    let freshParent = "";
    let otherParent = "";

    before(async () => {
      freshParent = pickFreshRunLabel("e2exfersub");
      otherParent = pickFreshRunLabel("e2exfernop");
      const connectOpts = await resolveDotnsEnvConnectOptions();
      const reg = new DotNS();
      await reg.connect({ mnemonic: DEFAULT_MNEMONIC, ...connectOpts });
      const aliceH160 = reg.evmAddress;
      try {
        // freshParent: registered AND given an "app" subname, both owned by
        // Alice — the handover leg transfers app.<freshParent> to the recipient.
        // Retry-safe: base-domain ownership of freshParent/otherParent is never
        // moved by this scenario (only the "app" subname is), so on a retry
        // within the same run Alice still owns both — registerOrConverge skips
        // the doomed re-register instead of hitting "already owned by <Alice>".
        // registerSubdomain itself needs no such guard: setSubnodeOwner (and,
        // batched atomically with it, setResolver) are parent-owner-authorised,
        // not subnode-owner-authorised, so re-running it unconditionally simply
        // reasserts Alice as the subnode owner even if a prior attempt already
        // handed app.<freshParent> to the recipient — converging the fixture
        // back to the state the handover test below expects to start from.
        await registerOrConvergeChecked(reg, freshParent, [aliceH160], "S-TRANSFER-SUBNAME setup");
        await reg.registerSubdomain("app", freshParent);
        // otherParent: registered by Alice only. No subname needed — the
        // not-parent-owner leg must fail at the parent-ownership check
        // before transferSubname ever reads the subnode.
        await registerOrConvergeChecked(reg, otherParent, [aliceH160], "S-TRANSFER-SUBNAME setup");
      } finally {
        reg.disconnect();
      }
    });

    test("handover — register app.<parent> as Alice, transfer to a recipient, verify on-chain, idempotent re-run", { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      const tld = await resolveE2eTld();
      const target = `app.${freshParent}.${tld}`;
      const envArgs = ["--env", E2E_ENV_ID];

      const t1 = await runBulletinDeploy({
        args: ["transfer", target, "--to", RECIPIENT_H160, ...envArgs],
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      assert.equal(
        t1.code, 0,
        `>> FAIL: S-TRANSFER-SUBNAME handover: transfer command exited ${t1.code}: ${(t1.stderr || t1.stdout).split("\n").slice(-3).join(" ")}`,
      );
      assert.match(
        t1.stdout, /Transferred .* to 0x41dccbd4/i,
        ">> FAIL: S-TRANSFER-SUBNAME handover: transfer command did not report a successful handover to the recipient",
      );

      // On-chain proof the subnode owner actually changed. Any connected
      // account can read it — checkSubdomainOwnership returns the raw
      // registry owner regardless of which account is connected; only its
      // `owned` field is relative to the connected signer, and we don't use
      // that here.
      const verifier = new DotNS();
      await verifier.connect({ mnemonic: DEFAULT_MNEMONIC, ...(await resolveDotnsEnvConnectOptions()) });
      let onChainOwner;
      try {
        ({ owner: onChainOwner } = await verifier.checkSubdomainOwnership("app", freshParent));
      } finally {
        verifier.disconnect();
      }
      assert.equal(
        onChainOwner?.toLowerCase(), RECIPIENT_H160.toLowerCase(),
        `>> FAIL: S-TRANSFER-SUBNAME handover: on-chain subnode owner is ${onChainOwner}, expected the recipient ${RECIPIENT_H160} — the CLI reported success but the registry disagrees`,
      );

      // Re-run: idempotent no-op (recipient already owns it).
      const t2 = await runBulletinDeploy({
        args: ["transfer", target, "--to", RECIPIENT_H160, ...envArgs],
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      assert.equal(
        t2.code, 0,
        `>> FAIL: S-TRANSFER-SUBNAME handover: idempotent re-run exited ${t2.code}: ${(t2.stderr || t2.stdout).split("\n").slice(-3).join(" ")}`,
      );
      assert.match(
        t2.stdout, /already owned by/i,
        ">> FAIL: S-TRANSFER-SUBNAME handover: second transfer should be a no-op (already-owned), not a re-transfer",
      );
    });

    // Regression guard for the ORIGINAL bug this scenario exists to cover: a
    // subname argument must never fall through to validateDomainLabel's
    // "Invalid domain label" rejection, and the real failure mode (signer
    // isn't the parent owner) must be reported actionably.
    test("not-parent-owner — transferring a subname under a parent you don't own fails with the actionable ownership error, not 'Invalid domain label'", { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      const tld = await resolveE2eTld();
      const target = `app.${otherParent}.${tld}`;
      const envArgs = ["--env", E2E_ENV_ID];

      // otherParent is owned by Alice (root, DEFAULT_MNEMONIC). Sign this
      // attempt as the well-known dev account //Bob instead — a real, funded
      // account on this testnet (see attemptTestnetTopUp in src/dotns.ts) but
      // NOT the parent owner. DOTNS_KEY_URI is read directly by
      // DotNS.connect() and takes precedence over the CLI's default mnemonic;
      // unlike --mnemonic (which transfer.ts doesn't expose a
      // --derivation-path for), it's parsed as a full Substrate URI (phrase +
      // derivation), giving us a distinct signer identity with zero CLI
      // plumbing changes.
      const t = await runBulletinDeploy({
        args: ["transfer", target, "--to", RECIPIENT_H160, ...envArgs],
        env: { DOTNS_KEY_URI: `${DEFAULT_MNEMONIC}//Bob` },
        timeoutMs: DEPLOY_TIMEOUT_MS,
      });
      assert.notEqual(
        t.code, 0,
        `>> FAIL: S-TRANSFER-SUBNAME not-parent-owner: expected a non-zero exit (signer //Bob does not own ${otherParent}.${tld}), got exit 0 — the parent-ownership guard did not fire`,
      );
      assert.match(
        t.stderr, /only the owner of the parent/i,
        `>> FAIL: S-TRANSFER-SUBNAME not-parent-owner: expected the actionable parent-ownership error, got: ${t.stderr.split("\n").slice(-5).join(" ")}`,
      );
      assert.doesNotMatch(
        t.stderr, /Invalid domain label/i,
        ">> FAIL: S-TRANSFER-SUBNAME not-parent-owner: got the OLD misleading 'Invalid domain label' rejection instead — the subname argument fell through to validateDomainLabel rather than being routed to transferSubname (this is the exact bug #150/#151 fixed)",
      );
    });
  });

  describe("S3 — domain owned by different account", { skip: SCENARIO !== "s3" }, () => {
    test(`deploy to pre-owned label rejects with exit 78`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const tld = await resolveE2eTld();
      // Env-conditional: the two fixtures are provisioned separately, so a
      // failure must name which one it actually used — otherwise the operator
      // repairs the wrong label.
      // Label is e2eownedns03 (not e2eownedns02) on paseo-next-v2: the Asset
      // Hub re-genesis emptied the .paseo namespace, and by the time this
      // fixture was (re-)provisioned a third party had already registered
      // e2eownedns02.paseo (owner 0x237a2b18…, neither Bob nor the funder) —
      // it can't be repaired, the name simply isn't ours on this chain.
      // Verified live 2026-08-22 via checkOwnership: e2eownedns02.paseo owner
      // 0x237a2b1824AC4a87095c25EC30e1431060725909 (squatter), e2eownedns03.paseo
      // owner 0x41dCCBD49b26c50d34355Ed86ff0FA9E489d1e01 (Bob, BOB_H160 below).
      const ownedLabel = E2E_ENV_ID === "paseo-next-v2"
        ? `e2eownedns03.${tld}`
        : `e2eownedns01.${tld}`;
      const envLabel = E2E_ENV_ID;
      // Bob's H160 (from docs/e2e-bootstrap.md).
      const BOB_H160 = "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01";
      const bareLabel = ownedLabel.replace(new RegExp(`\\.${tld}$`), "");

      // PRECHECK (bulletin #1378/#1341): read on-chain ownership directly,
      // BEFORE attempting the ~2-3 minute deploy. A DotNS redeploy wipes the
      // registry silently (CREATE3 keeps every contract address identical,
      // so nothing else signals the reset) — without this, a wiped fixture
      // surfaces only downstream, as "expected exit 78, got 0", which reads
      // like a product regression instead of the environment problem it
      // actually is. Uses a single short-lived DotNS connection dedicated to
      // this read (S3 has no other open client to reuse) rather than
      // inferring ownership from CLI text the way assertFixtureNotDrifted
      // (below) does after the fact.
      const precheckClient = new DotNS();
      await precheckClient.connect({ mnemonic: DEFAULT_MNEMONIC, ...(await resolveDotnsEnvConnectOptions()) });
      // register-test-fixture-equivalent admin repair can only move a name the
      // funder (root Alice) holds. Both drift checks below use this to pick
      // the right fix (bulletin #1398).
      const funder = precheckClient.evmAddress;
      let ownership;
      try {
        ownership = await precheckClient.checkOwnership(bareLabel, BOB_H160);
      } finally {
        precheckClient.disconnect();
      }
      assertFixtureOwnership({ ownership, label: bareLabel, tld, expectedOwner: BOB_H160, scenario: "S3", envLabel, funder });

      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          // S3 needs a label owned by a DIFFERENT account from the deploy signer.
          // `e2eowned.dot` was the historical fixture for PopFull signers but its
          // chain ownership drifted to Alice (see e2e run 26648857693 / v0.7.30-rc.1
          // S3 failure — `transferFrom` reverts with a custom error so we can't easily
          // restore it). Both `e2eownedns01.<tld>` and `e2eownedns03.<tld>` are
          // PoP-class-compatible with all signers (≥9-char NoStatus, accepts Full
          // signers fine) and are stable-owned by Bob on both envs — use the same
          // env-conditional for every PoP status.
          args: buildArgs(fixtureDir, ownedLabel),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        const combined = `${stdout}\n${stderr}`;

        // Distinguish FIXTURE DRIFT from a product regression before asserting
        // on the exit code. Both surface as "got 0", but they need completely
        // different responses, and a bare exit-code mismatch reads like a
        // product bug, which is how this sat red for a week in bulletin-deploy.
        // Returns without throwing when the output shows no drift, so the
        // exit-code check below reports the failure (bulletin #1398).
        assertFixtureNotDrifted({ output: combined, label: bareLabel, tld, expectedOwner: BOB_H160, funder, scenario: "S3", envLabel });

        if (code !== 78) {
          failWith({
            scenario: "S3",
            message: `expected EXIT_CODE_NO_RETRY (78), got ${code} for ${ownedLabel} on env "${envLabel}"`,
            context: combined,
            keywords: ["Error", "already owned", "domain"],
            hint: "S3 deploys to a domain owned by a DIFFERENT account; the CLI must refuse with exit 78 (no-retry).",
          });
        }

        // Pinning to Bob specifically (not a generic pattern) catches a reject
        // that happened for the wrong reason — e.g. a network error.
        if (!new RegExp(`is already owned by ${BOB_H160}`, "i").test(stderr)) {
          failWith({
            scenario: "S3",
            message:
              `exited 78 but the rejection did not name Bob (${BOB_H160}) as owner of ${ownedLabel} ` +
              `on env "${envLabel}" — the deploy was refused for the wrong reason`,
            context: combined,
            keywords: ["already owned", "Error", "Domain"],
            hint: "Exit 78 is also used for other non-retryable refusals; S3 must fail specifically on ownership.",
          });
        }
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S5 sets DOTNS_COMMITMENT_BUFFER=0 to remove the safety margin against
  // the dotns-sdk#105 timing race (CLI's waitForMinimumCommitmentAge compares
  // wall-clock to block.timestamp; when block-time lags wall-clock, the
  // reveal can fire too early and revert with CommitmentTooNew). Whether the
  // race manifests on a given run is timing-dependent — sometimes the chain
  // produces blocks fast enough that buffer=0 is plenty.
  //
  // Hard assertions (always-on contract):
  //   - deploy exits 0 (buffer=0 must not break the flow)
  //   - actionable-error text never appears (if both attempts failed, that
  //     would be a real regression)
  //
  // Soft signal (timing-dependent, informational only):
  //   - if "with DOTNS_COMMITMENT_BUFFER=60s" is present, the retry path
  //     fired and recovered — extra confidence in the recovery.
  //   - if absent, the race didn't manifest this run; not a failure.
  //
  // The retry-path code itself is covered by the unit tests on
  // isExplicitCommitmentBuffer + the buffer-escalation logic in
  // test/test.js. This E2E proves only that buffer=0 doesn't break a real
  // chain deploy.
  describe("S5 — DOTNS_COMMITMENT_BUFFER=0 race + retry recovery", { skip: SCENARIO !== "s5" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} with buffer=0 succeeds (retry path covered when race fires)`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      // Per-run unique label so the deploy actually goes through register()
      // (where the retry path lives in src/dotns.ts), not setContenthash.
      // Mirrors the .github/workflows/e2e.yml nightly-s5 fix from #205.
      const label = pickFreshRunLabel("e2e-s5");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.${tld}`),
          env: { DOTNS_COMMITMENT_BUFFER: "0" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S5", step: "deploy after retry" });
        // Verbatim from src/dotns.ts: actionable-error throw on double-failure.
        if (/DotNS register failed after retry:/.test(stdout)) {
          failWith({
            scenario: "S5",
            message: "actionable-error text appeared — BOTH register attempts failed instead of recovering on retry",
            context: stdout,
            keywords: ["DotNS register", "retry", "commit"],
            hint: "S5 expects the in-tool retry path (DOTNS_COMMITMENT_BUFFER bump) to succeed on attempt 2. If both attempts fail, the bug is in commit-reveal handling.",
          });
        }
        const retryFired = /with DOTNS_COMMITMENT_BUFFER=60s/.test(stdout);
        console.log(`[S5] retry path ${retryFired ? "fired and recovered" : "did not fire — race did not manifest this run"}`);
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S6 forces transport-level failover by pointing BULLETIN_RPC at an
  // unroutable address (RFC 3330). src/deploy.ts:811-813 prepends user-rpc
  // to BULLETIN_ENDPOINTS, leaving the public Bulletin endpoint as the
  // backup; papi rotates after the first endpoint fails fast. The
  // captureWarning("Bulletin RPC failover", …) is Sentry-only — we don't
  // assert against stdout here. Sentry-side assertion lives in
  // tools/verify_nightly_telemetry.py (#181 P1).
  describe("S6 — primary RPC unreachable, papi rotates to backup", { skip: SCENARIO !== "s6" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} with unroutable primary RPC succeeds via failover`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = pickStableLabel();
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.${tld}`),
          env: { BULLETIN_RPC: "ws://127.0.0.1:1/" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S6", step: "deploy via failover" });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S7 exercises the in-process Revive transaction path restored by PR #237.
  // When a host process — playground-cli's phone/QR session — passes its own
  // PolkadotSigner to DotNS.connect(), bulletin-deploy must submit DotNS
  // contract calls through polkadot-api/Revive. This path was broken after
  // the #158 dotns-cli migration and is restored in PR #237.
  //
  // The test calls DotNS directly (not via the CLI subprocess) so the
  // injected signer actually reaches the in-process path. No file upload
  // is needed — setContenthash is what exercises the restored code.
  //
  // A fixed CIDv1 is used so retries are idempotent (the contract stores
  // whatever bytes you write; it doesn't validate the CID exists anywhere).
  describe("S7 — external PolkadotSigner injects into DotNS.connect (in-process Revive path)", { skip: SCENARIO !== "s7" }, () => {
    test(`setContenthash via injected PolkadotSigner`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      // S7 has no pool/direct split: the point is to test the external-signer
      // code path itself, not the CLI signer selection. Always use the pool
      // account (Alice root mnemonic → stable pool label) regardless of E2E_SIGNER.
      //
      // Cannot use pickFreshRunLabel here: this test calls setContenthash
      // DIRECTLY via the external PolkadotSigner, without going through the
      // CLI's register() path. A fresh unregistered label reverts on chain.
      // Tier 4 fresh-label cleanup is therefore limited to S8 (which deploys
      // through the CLI and gets register() for free).
      const label = signerPopStatus >= 2 ? "e2epool" : "e2epoolns01";

      // Build a signer using the same Keyring + getPolkadotSigner pattern
      // that DotNS uses internally (src/dotns.ts:676-680). The difference is
      // that we pass it as an external object to DotNS.connect() rather than
      // letting DotNS construct it from a mnemonic.
      await cryptoWaitReady();
      const keyring = new Keyring({ type: "sr25519" });
      const account = keyring.addFromMnemonic(ALICE_MNEMONIC);
      const polkadotSigner = getPolkadotSigner(
        account.publicKey,
        "Sr25519",
        async (input) => account.sign(input),
      );

      const testCid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
      const expected = ("0x" + encodeContenthash(testCid)).toLowerCase();

      const dotns = new DotNS();
      try {
        await dotns.connect({
          signer: polkadotSigner,
          signerAddress: account.address,
          ...(await resolveDotnsEnvConnectOptions()),
        });
        // setContenthash routes through contractTransaction (in-process Revive)
        // when _usesExternalSigner is true, and does an internal post-write
        // read-back before returning. A throw here means either the Revive call
        // reverted or the on-chain value didn't match — both are real failures.
        await dotns.setContenthash(label, expected);
        // Cross-verify via the resolver read path, independent of the
        // setContenthash write path used above.
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S7", label });
      } finally {
        dotns.disconnect();
      }
    });

    // S7b: verify that Bulletin storage uploads use storageSigner when provided.
    // Programmatic callers pass both signer (DotNS) and storageSigner (Bulletin).
    // Confirms "Using slot signer:" appears in console output, proving
    // getSlotSignerProvider was selected over pool fallback.
    test(`full deploy() routes Bulletin storage through storageSigner when provided`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = signerPopStatus >= 2 ? "e2epool" : "e2epoolns01";
      const tld = await resolveE2eTld();

      await cryptoWaitReady();
      const keyring = new Keyring({ type: "sr25519" });
      const account = keyring.addFromMnemonic(ALICE_MNEMONIC);
      const polkadotSigner = getPolkadotSigner(
        account.publicKey,
        "Sr25519",
        async (input) => account.sign(input),
      );

      // Intercept console.log to capture storage-path log lines without
      // suppressing them (forward to process.stdout so the test log is intact).
      const capturedLogs = [];
      const originalConsoleLog = console.log;
      console.log = (...args) => {
        capturedLogs.push(args.map(String).join(" "));
        originalConsoleLog(...args);
      };

      const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-s7b-"));
      fs.writeFileSync(path.join(fixtureDir, "index.html"), "<h1>S7b external signer storage test</h1>");

      try {
        // Resolve the whole env (endpoints + contracts + ipfs) the same way the
        // CLI's --env does — pass `env`, NOT a partial mix of rpc + contracts,
        // so the bulletin RPC and the DotNS contract addresses stay consistent.
        await deploy(fixtureDir, `${label}.${tld}`, {
          signer: polkadotSigner,
          signerAddress: account.address,
          // S7b contract: programmatic callers pass storageSigner explicitly.
          // Alice is the pool account and is authorized on Bulletin.
          storageSigner: polkadotSigner,
          storageSignerAddress: account.address,
          env: E2E_ENV_ID,
          jsMerkle: true,
        });
      } finally {
        console.log = originalConsoleLog;
        try { fs.rmSync(fixtureDir, { recursive: true }); } catch {}
      }

      // The decisive assertion: getSlotSignerProvider emits this line when storageSigner
      // is selected. If this fails, the reconnect factory fell back to pool (regression).
      const signerLog = capturedLogs.find((l) => l.includes(`Using slot signer: ${account.address}`));
      assert.ok(
        signerLog != null,
        `>> FAIL: S7: Bulletin storage did not go through storageSigner — expected "Using slot signer: ${account.address}" in console output but it was absent; pool fallback likely`,
      );
    });
  });

  // S-INC-ROUNDTRIP verifies that the manifest embedded in the deployed CAR
  // is readable back via the gateway and matches the local manifest.json
  // written during the deploy. Uses fetchManifestRoundtrip from
  // src/manifest-roundtrip.ts, which GETs the full CAR and parses the
  // .bulletin-deploy/manifest.json leaf.
  //
  // Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md (§ 10)
  describe("S-INC-ROUNDTRIP — gateway readback integrity", { skip: SCENARIO !== "s-inc-roundtrip" }, () => {
    test(`manifest embedded in deployed CAR matches local manifest.json`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickIncLabel();
      const tld = await resolveE2eTld();
      const gateway = await resolveE2eGateway();
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-rt-"));
      buildIncrementalFixture({ targetDir: fix1, seed: "s-inc-roundtrip", runTag: RUN_TAG + "-rt" });
      try {
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC-ROUNDTRIP" });

        const deployedCid = parseDeployedCid(r1.stdout, "S-INC-ROUNDTRIP");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        await readContenthashWithRetry(label, expected);

        // Read the local manifest.json the CLI wrote during deploy.
        const localManifestPath = path.join(fix1, ".bulletin-deploy", "manifest.json");
        assert.ok(fs.existsSync(localManifestPath),
          `CLI must write .bulletin-deploy/manifest.json to the build dir`);
        const localManifestJson = JSON.parse(fs.readFileSync(localManifestPath, "utf8"));

        // Fetch the same manifest from the gateway — poll with a 5-min budget
        // to account for gateway indexing delay.
        const result = await fetchManifestRoundtrip(deployedCid, {
          gateway,
          budgetMs: 5 * 60 * 1000,
          pollIntervalMs: 10_000,
          perRequestTimeoutMs: 30_000,
        });
        assert.ok(result.ok,
          `fetchManifestRoundtrip failed: ${result.ok ? "" : result.reason}`);

        // JSON-equality (not byte-equality) to tolerate whitespace differences
        // between what the CLI writes and what the gateway serves.
        const gatewayManifestJson = JSON.parse(new TextDecoder().decode(result.manifestBytes));
        assert.deepStrictEqual(gatewayManifestJson, localManifestJson,
          `gateway manifest must match local manifest.json`);
      } finally {
        fs.rmSync(fix1, { recursive: true, force: true });
      }
    });
  });

  // S-INC-PORTABILITY verifies that a manifest written by workspace A is
  // usable as the incremental baseline for workspace B (a "fresh clone" of the
  // same content). If the chunk-hash encoding or file-path normalization is
  // workspace-specific, the second deploy from B would miss all cached chunks
  // and show 0 % skip rate instead of the expected ≥ 95 %.
  //
  // Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md (§ 11 — portability)
  describe("S-INC-PORTABILITY — cross-workspace dedup", { skip: SCENARIO !== "s-inc-portability" }, () => {
    test(`second deploy from a fresh workspace gets ≥ 95 % chunk-skip rate`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickIncLabel();
      const tld = await resolveE2eTld();
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-port-A-"));
      const fix2 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-port-B-"));
      buildIncrementalFixture({ targetDir: fix1, seed: "s-inc-portability", runTag: RUN_TAG + "-port" });
      try {
        // Deploy from workspace A
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC-PORTABILITY", step: "first deploy" });

        // Verify the manifest was written.
        const localManifestPath = path.join(fix1, ".bulletin-deploy", "manifest.json");
        assert.ok(fs.existsSync(localManifestPath),
          `CLI must write .bulletin-deploy/manifest.json in workspace A`);

        // Copy the entire fixture (including the .bulletin-deploy directory) to
        // workspace B. fs.cpSync preserves the manifest.json, simulating a
        // "fresh clone" that carries the prior manifest for incremental dedup.
        fs.cpSync(fix1, fix2, { recursive: true });
        assert.ok(fs.existsSync(path.join(fix2, ".bulletin-deploy", "manifest.json")),
          `manifest must be present in workspace B after copy`);

        // Deploy from workspace B (same content, manifest imported from A)
        const r2 = await runBulletinDeploy({
          args: buildArgs(fix2, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r2, { scenario: "S-INC-PORTABILITY", step: "second deploy" });

        // Bytes-uploaded gate: byte-identical redeploy from a fresh workspace
        // should upload only the section 0 (manifest, ~5-10 KB) + section 2
        // (root dir + volatile, ~5-10 KB) delta. Section 1 (5.1 MB stable
        // content) must be 100 % cached if the manifest is portable across
        // workspaces. Live observation: ~10-20 KB uploaded.
        const bytesUploaded = parseBytesUploadedFromOutput(r2.stdout);
        if (bytesUploaded > 50_000) {
          failWith({
            scenario: "S-INC-PORTABILITY",
            message: `bytes uploaded ${(bytesUploaded / 1024).toFixed(1)} KB > 50 KB ceiling`,
            context: r2.stdout,
            keywords: ["Probed", "Cache", "Manifest"],
            hint: "byte-identical redeploy from another workspace should re-upload only manifest+section-2 overhead. If section 1 chunks were re-uploaded, the manifest is not portable.",
          });
        }
      } finally {
        // Cleanup tmp dirs (best-effort).
        try { fs.rmSync(fix1, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(fix2, { recursive: true, force: true }); } catch {}
      }
    });
  });

  // S-INC-CROSSLABEL verifies that Bulletin's content-addressed storage lets
  // a byte-identical redeploy under a BRAND NEW label reuse another domain's
  // already-uploaded chunks, even with NO previous manifest at all for the
  // new label (manifest_source: none / first_deploy). Unlike S-INC-PORTABILITY
  // (which carries workspace A's manifest.json into workspace B to hit the
  // fast "embedded" path), this scenario builds workspace B from scratch —
  // proving the probe-only path (storeChunkedContent's skipCids probe against
  // TransactionStorage.TransactionByContentHash) is what actually enables
  // sharing, not manifest portability. Chunk CIDs for files >= CHUNK_SIZE_TARGET
  // (1 MiB) are a pure function of that file's bytes, independent of domain or
  // manifest history.
  //
  // Spec: port of bulletin #1571/#1387.
  describe("S-INC-CROSSLABEL — cross-label dedup with no previous manifest", { skip: SCENARIO !== "s-inc-crosslabel" }, () => {
    test(`second label's first-ever deploy still skips section-1 chunks uploaded under the first label`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const labelA = pickFreshRunLabel("e2exlbla");
      const labelB = pickFreshRunLabel("e2exlblb");
      const tld = await resolveE2eTld();
      const fixA = fs.mkdtempSync(path.join(os.tmpdir(), "e2exlbl-A-"));
      const fixB = fs.mkdtempSync(path.join(os.tmpdir(), "e2exlbl-B-"));
      // Same seed for both — section-1 (>1 MiB + content-hashed) files must
      // be byte-identical across workspaces for their chunk CIDs to coincide.
      // Different runTag only affects the volatile index.html padding.
      buildIncrementalFixture({ targetDir: fixA, seed: "s-inc-crosslabel", runTag: RUN_TAG + "-xlbl-a" });
      try {
        // Deploy under label A — puts the shared content on chain.
        const rA = await runBulletinDeploy({
          args: buildArgs(fixA, `${labelA}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(rA, { scenario: "S-INC-CROSSLABEL", step: "deploy under label A" });

        // Build workspace B from scratch — deliberately NOT copying fixA's
        // .bulletin-deploy/manifest.json. Label B has never been deployed to,
        // so this must hit the true first-deploy path (manifest_source: none).
        // (buildIncrementalFixture never writes .bulletin-deploy/manifest.json
        // itself — only the CLI does, during deploy — so there's no separate
        // precondition to assert here; the "no previous manifest" property is
        // verified below via the deploy's own "Manifest:" summary line, which
        // is the assertion that can actually catch a regression.)
        buildIncrementalFixture({ targetDir: fixB, seed: "s-inc-crosslabel", runTag: RUN_TAG + "-xlbl-b" });

        const rB = await runBulletinDeploy({
          args: buildArgs(fixB, `${labelB}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(rB, { scenario: "S-INC-CROSSLABEL", step: "first-ever deploy under label B" });

        // Manifest line must say true first-deploy (no previous manifest),
        // confirming B's own domain genuinely has no manifest history — this
        // is what distinguishes the scenario from S-INC-PORTABILITY.
        assertStdoutMatches(rB.stdout, /Manifest:\s+first deploy \(no previous manifest\)/, {
          scenario: "S-INC-CROSSLABEL",
          what: "manifest_source: none / first_deploy for label B",
          hint: "label B must be genuinely fresh (never deployed before). If this fails with an 'embedded'/'heuristic_fallback' line instead, label B collided with a previously-used domain — check pickFreshRunLabel's per-run uniqueness.",
        });

        // Despite no previous manifest, the probe-only path must still find
        // and skip label A's already-uploaded section-1 chunks (global,
        // content-addressed storage — dedup doesn't need a manifest or a
        // domain link, only coinciding chunk CIDs). Note: unlike S-INC's own
        // >= 60% regression floor, this scenario requires a full 100% skip —
        // every section-1 chunk was just uploaded under label A, so anything
        // less than "all found on chain" means cross-label reuse missed one.
        // (Unlike S-INC-PORTABILITY, which never asserts on this line at all —
        // its embedded-manifest fast path is a different code path — this
        // scenario's whole point is exercising the probe, so it must run.)
        //
        // parseChunkSkipRateFromOutput treats "0 chunks probed" as a 100 %
        // skip (its general convention: nothing to do = nothing missed).
        // That's the wrong read here — this scenario forces the probe-only
        // path specifically, so "0 probed" would mean that path silently
        // didn't run at all, which is exactly the regression this test
        // exists to catch. Assert a non-zero probe count explicitly before
        // trusting the shared helper's ratio.
        assertStdoutMatches(rB.stdout, /Probed:\s+(?!0\s+chunks)\d+\s+chunks/, {
          scenario: "S-INC-CROSSLABEL",
          what: "at least one chunk actually probed for label B",
          hint: "0 chunks probed means the probe-only path didn't run at all for label B — this scenario exists specifically to exercise that path.",
        });
        const skipRate = parseChunkSkipRateFromOutput(rB.stdout, "S-INC-CROSSLABEL");
        if (skipRate < 1) {
          failWith({
            scenario: "S-INC-CROSSLABEL",
            message: `cross-label chunk-skip rate ${(skipRate * 100).toFixed(1)}% < 100% — some section-1 chunks uploaded under label A were not found on chain for label B`,
            context: rB.stdout,
            keywords: ["Probed", "Cache", "Manifest"],
            hint: "every section-1 chunk uploaded under label A should be found by label B's skipCids probe, since chunk CIDs for files >= 1 MiB are a pure function of file bytes.",
          });
        }

        // Bytes-uploaded gate: with all section-1 chunks skipped, label B's
        // first-ever deploy should upload only section 0 (manifest) + section
        // 2 (root dir + volatile index.html) overhead — well under the
        // ceiling S-INC/S-INC-PORTABILITY already use for the same fixture.
        const bytesUploaded = parseBytesUploadedFromOutput(rB.stdout);
        if (bytesUploaded > 50_000) {
          failWith({
            scenario: "S-INC-CROSSLABEL",
            message: `bytes uploaded ${(bytesUploaded / 1024).toFixed(1)} KB > 50 KB ceiling on a cross-label, no-manifest redeploy`,
            context: rB.stdout,
            keywords: ["Probed", "Cache", "Manifest"],
            hint: "live observation on S-INC/S-INC-PORTABILITY's same fixture is ~10-20 KB. Significantly more means cross-label chunk reuse silently stopped working.",
          });
        }
      } finally {
        try { fs.rmSync(fixA, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(fixB, { recursive: true, force: true }); } catch {}
      }
    });
  });

  // S-INC-ASSET-ROTATION simulates a real frontend rebuild: one source file
  // changed, Vite emits a new content-hashed bundle filename and updates
  // index.html's script tag. The expected behaviour: the unchanged 9.1 MB
  // worth of stable content-hashed assets (vendor/css/fonts/metadata bundles)
  // stay cached in section 1, only the rotated bundle (~466 KB) and the
  // tiny volatile section (HTML + manifest) need re-uploading.
  //
  // Fixture: github.com/paritytech/Rock-Paper-Scissors built with Vite 7.0,
  // 60 files / 9.6 MB total. Patch swaps the index-*.js bundle (1 source-line
  // string change). Stored as v1 + patch (~10 MB total) instead of v1+v2 (20 MB).
  //
  // Assertions:
  //   - First deploy uploads the full ~9.6 MB (probe finds 0 of N chunks on chain)
  //   - Second deploy uploads ≤ 1.5 MB (rotated bundle + section-2 overhead)
  describe("S-INC-ASSET-ROTATION — realistic Vite rebuild", { skip: SCENARIO !== "s-inc-asset-rotation" }, () => {
    test(`bundle filename rotation re-uploads only the changed file`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickRotLabel();
      const tld = await resolveE2eTld();
      const fixtureRoot = path.resolve("test/fixtures/realistic-vite");
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2erot-"));
      // Stage v1 of the build into the deploy workspace.
      fs.cpSync(path.join(fixtureRoot, "v1"), fix1, { recursive: true });
      try {
        // First deploy: 9.6 MB site, all chunks new (or already on chain from
        // a prior test run — we don't assert on first-deploy chunk-skip rate).
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.${tld}`),
          env: { NODE_OPTIONS: "--max-old-space-size=512" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC-ASSET-ROTATION", step: "first deploy" });

        // Manifest must be written so the second deploy can do prev-anchor
        // ordering + classification.
        const localManifestPath = path.join(fix1, ".bulletin-deploy", "manifest.json");
        assert.ok(fs.existsSync(localManifestPath),
          `CLI must write .bulletin-deploy/manifest.json after first deploy`);

        // Apply the Vite-rebuild patch: delete the old bundle, write the new
        // bundle + updated index.html. Manifest in .bulletin-deploy/ is
        // preserved (patch.json doesn't touch it).
        applyVitePatch(fix1, fixtureRoot);

        // Second deploy: only the rotated bundle + HTML should be new.
        // Same heap bump for the redeploy — phase B re-merkleizes the same site.
        const r2 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.${tld}`),
          env: { NODE_OPTIONS: "--max-old-space-size=512" },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r2, { scenario: "S-INC-ASSET-ROTATION", step: "second deploy" });

        // Bytes-uploaded gate: rotating one ~466 KB content-hashed bundle in a
        // 9.6 MB site should re-upload only the bundle bytes + section 2 overhead.
        // Live observation: ~700 KB uploaded. 1.5 MB ceiling = ~2× headroom for
        // chunk-packing variability (sibling small files in the same chunk as the
        // rotated bundle may also re-upload).
        //
        // #1355: root cause was CONTENT_HASH_RE (src/manifest.ts) only
        // admitting [A-Za-z0-9] in the hash segment, so Vite/Rollup bundle
        // names whose base64url hash suffix contains "_" or "-" (e.g.
        // errors-CHrKVge_.js) fell through to "volatile" and were fully
        // re-uploaded on every deploy despite their CID never changing.
        // Fixed by widening CONTENT_HASH_RE's class to admit the full
        // base64url alphabet — a pure name-based classification with no
        // history-dependence. (An earlier attempt fixed this via a
        // prevManifest CID-match in the CAR-section classifier instead; that
        // broke S-INC-PORTABILITY by letting content-identical,
        // name-unclassified files like index.html migrate into section 1's
        // tail between deploys — reverted.) Ceiling stays at 1.5 MB — a
        // future regression here means the dedup broke again, not that the
        // budget is stale.
        const bytesUploaded = parseBytesUploadedFromOutput(r2.stdout);
        if (bytesUploaded > 1_500_000) {
          failWith({
            scenario: "S-INC-ASSET-ROTATION",
            message: `bytes uploaded ${(bytesUploaded / 1024 / 1024).toFixed(2)} MB > 1.5 MB ceiling`,
            context: r2.stdout,
            keywords: ["Probed", "Cache", "Manifest"],
            hint: "a 466 KB asset rotation should re-upload ≤ 1.5 MB; significantly more suggests a chunk-alignment regression.",
          });
        }

        console.log(`   ✓ Asset rotation: uploaded ${(bytesUploaded / 1024 / 1024).toFixed(2)} MB ` +
                    `(rotated bundle is 466 KB).`);
      } finally {
        try { fs.rmSync(fix1, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe("S-INC — incremental upload v2 (chunk reuse on re-deploy)", { skip: SCENARIO !== "s-inc" }, () => {
    test(`re-deploy identical content reuses chunks via gateway probe`, { timeout: (DEPLOY_TIMEOUT_MS + 30_000) * 2 }, async () => {
      const label = pickIncLabel();
      const tld = await resolveE2eTld();
      // 5MB fixture so chunks > 1 — gives the incremental path actual chunk
      // reuse to exercise. The mutated SPA fixture (~500B) fits in a single
      // chunk; a single chunk always changes between deploys because the
      // embedded manifest's `deployed_at` shifts.
      const fix1 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-1-"));
      buildIncrementalFixture({ targetDir: fix1, seed: "s-inc", runTag: RUN_TAG + "-inc" });
      try {
        const r1 = await runBulletinDeploy({
          args: buildArgs(fix1, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-INC", step: "first deploy" });
        const cid1 = parseDeployedCid(r1.stdout, "S-INC");
        const expected1 = ("0x" + encodeContenthash(cid1)).toLowerCase();
        await readContenthashWithRetry(label, expected1);

        // The gateway needs a moment to index newly-stored content before the
        // 2nd deploy can fetch the embedded manifest. Poll HEAD on the root
        // URL (the deployed CID's bytes ARE the inner CAR; v2 fetch grabs
        // the whole CAR and parses locally rather than sub-path GET — see
        // src/manifest-fetch.ts). Falls through after timeout; the test's
        // assertions will catch a stale gateway clearly.
        const gateway = await resolveE2eGateway();
        const rootUrl = `${gateway}/ipfs/${cid1}`;
        const propagationDeadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < propagationDeadline) {
          try {
            const res = await fetch(rootUrl, { method: "HEAD" });
            if (res.status === 200) break;
          } catch { /* network blips OK */ }
          await new Promise((r) => setTimeout(r, 10_000));
        }

        // Second deploy of the same content — incremental flow should skip
        // chunks for the stable files (vendor.js, runtime.wasm, css, fonts,
        // images). Only the chunk(s) containing the embedded manifest +
        // index.html differ between deploys (deployed_at moves).
        const fix2 = fs.mkdtempSync(path.join(os.tmpdir(), "e2einc-2-"));
        buildIncrementalFixture({ targetDir: fix2, seed: "s-inc", runTag: RUN_TAG + "-inc" });
        try {
          const r2 = await runBulletinDeploy({
            args: buildArgs(fix2, `${label}.${tld}`),
            timeoutMs: DEPLOY_TIMEOUT_MS,
          });
          assertDeploySucceeded(r2, { scenario: "S-INC", step: "second deploy" });

          // Regression canary: chunk-skip rate floor. A drop below 60 % typically
          // signals a chunk-alignment bug (the v3 file-aligned chunker should
          // produce > 90 % section-1 hits on unchanged stable files).
          const skipRate = parseChunkSkipRateFromOutput(r2.stdout, "S-INC");
          if (skipRate < 0.6) {
            failWith({
              scenario: "S-INC",
              message: `chunk-skip regression: ${(skipRate * 100).toFixed(1)} % < 60 %`,
              context: r2.stdout,
              keywords: ["Probed", "Cache", "Manifest"],
              hint: "likely a chunk-alignment bug. The v3 file-aligned chunker should produce > 90 % section-1 hits on unchanged stable files.",
            });
          }

          // Bytes-uploaded gate: byte-identical redeploy should upload only the
          // section 0 (manifest) + section 2 (root dir + volatile) overhead, which
          // is well under 50 KB for the synthetic 5 MB fixture. Catches any
          // regression where incremental upload silently stops working.
          const bytesUploaded = parseBytesUploadedFromOutput(r2.stdout);
          if (bytesUploaded > 50_000) {
            failWith({
              scenario: "S-INC",
              message: `bytes uploaded ${(bytesUploaded / 1024).toFixed(1)} KB > 50 KB ceiling on byte-identical redeploy`,
              context: r2.stdout,
              keywords: ["Probed", "Cache", "Manifest"],
              hint: "live observation is ~10-20 KB. Significantly more means incremental upload silently stopped working.",
            });
          }

          // Manifest fetch path: must be either embedded (optimized) or
          // heuristic_fallback (graceful degradation when gateway times out).
          // Both produce correct deploys; we just confirm the prev-manifest
          // pipeline ran (didn't silently bypass).
          assertStdoutMatches(r2.stdout, /Manifest:\s+(embedded|heuristic_fallback)/, {
            scenario: "S-INC",
            what: "prev-manifest pipeline (embedded or heuristic_fallback)",
            hint: "second deploy should run the prev-manifest pipeline (not bypass it).",
          });
          assertStdoutMatches(r2.stdout, /Probed:\s+\d+ chunks\b/, {
            scenario: "S-INC",
            what: "probe summary line",
            hint: "second deploy should print a 'Probed: N chunks' summary.",
          });
          assertStdoutMatches(r2.stdout, /Cache:\s/, {
            scenario: "S-INC",
            what: "incremental Cache summary line",
            hint: "second deploy should print a 'Cache:' summary line.",
          });

          // CID may shift (deployed_at in manifest changes), but DotNS must still
          // resolve the new contenthash on-chain.
          const cid2 = parseDeployedCid(r2.stdout, "S-INC");
          const expected2 = ("0x" + encodeContenthash(cid2)).toLowerCase();
          await readContenthashWithRetry(label, expected2);
        } finally {
          fs.rmSync(fix2, { recursive: true, force: true });
        }
      } finally {
        fs.rmSync(fix1, { recursive: true, force: true });
      }
    });
  });

  // S8 exercises the chunk-upload retry/reconnect path under fault injection
  // — the actual failure mode behind #142 / #216 / #271. A local WS reverse
  // proxy (test/helpers/ws-fault-proxy.mjs) sits between bulletin-deploy and
  // the real Bulletin RPC and injects mid-upload disconnects via terminate()
  // (abrupt TCP close, closer to chain-side `WS halt (3)` than a graceful
  // close-with-code).
  //
  // Two test cases:
  //   - drop-once: one mid-upload halt → deploy survives via reconnect.
  //                 Regression guard for #278's fix (suppress unhandled
  //                 connection errors so doReconnect can engage).
  //   - rapid-storm: drops every 2s → deploy bails with the new
  //                  "Retry budget exhausted" error (#271). Regression
  //                  guard for the budget bound NOT being silently broken,
  //                  AND for #278's suppression NOT trapping us in an
  //                  infinite loop.
  //
  // Uses a fresh per-run label (pickFreshRunLabel("s8smoke")) so concurrent
  // nightly runs don't race on the same domain. Both subtests use the same
  // label binding — pick once at describe scope, use twice. Keep the two
  // subtests serial: both use the same signer/account on paseo-next-v2, so
  // overlapping deploys can race nonces and make fallback inclusion checks
  // ambiguous.
  //
  // Background — what the harness validates:
  //   - PAPI's getProxy().connect re-broadcasts active transactions by
  //     iterating a Map it then mutates inside the iteration callback.
  //     V8's forEach visits the new entries, generating thousands of
  //     4 MB JSON-RPC strings until OOM. Heap snapshot at near-OOM
  //     showed proxyOpaque IDs counting from 4 to 364 from a single
  //     halt — i.e. PAPI emitted ~360 distinct broadcasts during one
  //     reconnect cycle. Tracked upstream as bulletin-deploy #287.
  //   - Workaround in src/deploy.ts: hook onStatusChanged for
  //     WsEvent.CLOSE/ERROR, synchronously call client.destroy() so
  //     PAPI's forEach guard (state.type === 0) short-circuits before
  //     the next iteration step. Combined with a flag the chunk-upload
  //     loop checks before each batch (so halts in the gap between
  //     batches still trigger doReconnect rather than running the next
  //     batch against a destroyed client).
  describe("S8 — chunk-upload survives WS halt + budget bails clean on storm", { skip: SCENARIO !== "s8", concurrency: false }, () => {
    const label = pickFreshRunLabel("s8smoke");
    test("drop-once mid-upload: deploy succeeds via reconnect, budget never trips", { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      // Multi-chunk fixture so the upload spans long enough that mid-upload
      // is a real point in time (not after-the-fact). 7 MB → 4 chunks of 2 MB.
      const { fixtureDir } = await makeMultiChunkFixture(`s8a-${RUN_TAG}`);
      // dropAtMs=40s lands well into chunk submission. With incremental upload,
      // the manifest fetch (up to ~30s with gateway timeout) precedes the chunk
      // loop, so drops before that window hit the probe phase, not doReconnect.
      const proxy = await startFaultProxy({
        mode: "once",
        dropAtMs: 40_000,
        upstream: await resolveE2eBulletinRpc(),
      });
      try {
        const tld = await resolveE2eTld();
        const args = buildArgs(fixtureDir, `${label}.${tld}`);
        const { code, stdout, stderr } = await runBulletinDeploy({
          args,
          env: { BULLETIN_RPC: proxy.url },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        if (code !== 0) {
          failWith({
            scenario: "S8",
            message: `drop-once deploy must succeed (exit ${code}, drops injected: ${proxy.stats.dropsInjected})`,
            context: stderr,
            keywords: ["Error", "Stale", "Connection"],
            hint: "S8 drop-once injects one mid-upload WS drop; the CLI must reconnect and finish the upload. Any non-zero exit here means the reconnect logic broke — check src/deploy.ts WS-halt handling.",
          });
        }
        // The drop must actually have fired — otherwise we proved nothing.
        assert.ok(proxy.stats.dropsInjected >= 1, `proxy injected ${proxy.stats.dropsInjected} drops; expected ≥1`);
        // No assertion on the reconnect log line: the drop can land outside the
        // chunk-upload window (e.g. during DotNS root-node confirmation), in which
        // case PAPI's WsProvider reconnects transparently without our code logging.
        // The invariant is code===0 + dropsInjected>=1, not which reconnect path fired.
        // Budget must NOT have tripped on a single drop.
        assert.doesNotMatch(stderr + stdout, /Retry budget exhausted/, "budget should not trip on a single transient drop");
      } finally {
        await proxy.close();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    test("rapid-storm: deploy doesn't crash with uncaught (either survives or bails clean)", { timeout: DEPLOY_TIMEOUT_MS + 60_000 }, async () => {
      const { fixtureDir } = await makeMultiChunkFixture(`s8b-${RUN_TAG}`);
      // 10s warmup so auth completes, then drops every 2s for a BOUNDED 40s window,
      // then the storm stops so the deploy can recover and complete. The storm must
      // be bounded: the progress-aware retry budget (#864) recovers through an
      // *unbounded* storm indefinitely rather than bailing, so it would never reach a
      // clean outcome and would hit the job timeout. With a bounded burst we assert the
      // stronger property — the deploy SURVIVES the storm and finishes (clean success).
      // A clean "Retry budget exhausted" bail is still acceptable; only an uncaught
      // crash (exit 2) is a regression.
      const proxy = await startFaultProxy({
        mode: "rapid",
        initialDelayMs: 10_000,
        dropEveryMs: 2_000,
        dropDurationMs: 40_000,
        upstream: await resolveE2eBulletinRpc(),
      });
      try {
        const tld = await resolveE2eTld();
        const args = buildArgs(fixtureDir, `${label}.${tld}`);
        const { code, stdout, stderr } = await runBulletinDeploy({
          args,
          env: { BULLETIN_RPC: proxy.url },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        const combined = stderr + stdout;
        // Acceptable: clean success (PAPI absorbed all drops) OR clean
        // budget bail. Unacceptable: exit 2 from uncaughtException, which
        // would mean #278's suppression broke.
        const cleanSuccess = code === 0;
        const cleanBail = code === 1 && /Retry budget exhausted|max reconnections.*exhausted|ChainHead disjointed/i.test(combined);
        if (!(cleanSuccess || cleanBail)) {
          failWith({
            scenario: "S8",
            message: `deploy must either survive cleanly or bail with budget/reconnect-exhausted error or ChainHead disjointed; got exit ${code}. Drops injected: ${proxy.stats.dropsInjected}`,
            context: stderr,
            keywords: ["Error", "Stale", "Connection"],
            hint: "an uncaught crash (exit 2) means #278's suppression broke.",
          });
        }
        // Either way, must not crash with uncaught.
        assert.doesNotMatch(combined, /Suppressed.*connection error.*[A-Z][a-zA-Z]*Error: (?!.*WS halt|.*heartbeat|.*Unable to connect)/, "no non-connection error should leak through the suppression filter");
      } finally {
        await proxy.close();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S9 — parallel deploys from same direct signer (nonce-collision resilience)", { skip: SCENARIO !== "s9", concurrency: false }, () => {
    test("two fresh-label deploys from same key both exit 0, nonce-advance fires on collision", { timeout: DEPLOY_TIMEOUT_MS * 2 + 5 * 60 * 1000 + 60_000 }, async () => {
      // Prefix must be ≥6 chars per PopRules (`baselength <= 5 → Reserved`).
      // The old 3-char `s9a`/`s9b` prefixes got trimmed-to-base by the
      // sanitizer and rejected (see e2e run 26648857693 / v0.7.30-rc.1 S9).
      const labelA = pickFreshRunLabel("s9racea");
      const labelB = pickFreshRunLabel("s9raceb");
      const tld = await resolveE2eTld();

      function s9Args(fixtureDir, label) {
        return [
          fixtureDir,
          `${label}.${tld}`,
          "--tag", process.env.DEPLOY_TAG,
          "--mnemonic", ALICE_MNEMONIC,
          ...(MERKLE === "js" ? ["--js-merkle"] : []),
          ...(directSignerDerivationPath() ? ["--derivation-path", directSignerDerivationPath()] : []),
          "--env", E2E_ENV_ID,
        ];
      }

      // Multi-chunk fixture (~7 MB / 4 chunks) gives ~30-60s upload so both
      // deploys overlap on Bulletin chain chunk txs and contend on the same nonce.
      // GRANDPA wait is capped at 30s (vs 90s default) because S9 tests nonce
      // collision resilience, not GRANDPA recovery — lower wait keeps runtime
      // within the 15-min per-deploy limit on slower testnets (paseo-next-v2).
      const S9_GRANDPA_WAIT_MS = 30_000;
      const { fixtureDir: fixA } = await makeMultiChunkFixture(`s9a-${RUN_TAG}`);
      const { fixtureDir: fixB } = await makeMultiChunkFixture(`s9b-${RUN_TAG}`);
      try {
        const s9Env = { BULLETIN_GRANDPA_NATURAL_WAIT_MS: String(S9_GRANDPA_WAIT_MS) };
        // Per-deploy timeout extends DEPLOY_TIMEOUT_MS by 5 min to absorb
        // nonce-collision retries on slower testnets (paseo-next-v2 12s blocks).
        const S9_DEPLOY_TIMEOUT_MS = DEPLOY_TIMEOUT_MS + 5 * 60 * 1000;
        const [rA, rB] = await Promise.all([
          runBulletinDeploy({ args: s9Args(fixA, labelA), env: s9Env, timeoutMs: S9_DEPLOY_TIMEOUT_MS }),
          runBulletinDeploy({ args: s9Args(fixB, labelB), env: s9Env, timeoutMs: S9_DEPLOY_TIMEOUT_MS }),
        ]);

        assertDeploySucceeded(rA, { scenario: "S9", step: "deploy A" });
        assertDeploySucceeded(rB, { scenario: "S9", step: "deploy B" });

        const combined = rA.stdout + rA.stderr + rB.stdout + rB.stderr;
        // Accept ANY of the deploy's nonce-collision-recovery signals — not just
        // the "consumed → included" heuristic (deploy.ts nonce-advance fallback /
        // consumed-heuristic logs), but crucially the "Nonce-collision re-upload"
        // line (deploy.ts:1346), which is the DEFINITIVE evidence the resilience
        // path engaged: it only fires when a chunk's nonce advanced under it AND
        // the chunk was actually missing, forcing a fresh-nonce re-upload. The
        // earlier grep missed this — #1100 saw a run emit "Nonce-collision
        // re-upload" 34× (both deploys succeeded, recovery worked) while the old
        // regex's phrases appeared 0× → false red. This is a stronger signal, not
        // a weaker assertion.
        assert.match(
          combined,
          /(nonce (advanced past \d+|consumed \(current=|\d+ consumed)|Nonce-collision re-upload|nonce-advance collision)/i,
          ">> FAIL: S9: neither parallel deploy logged any nonce-collision-recovery signal " +
            "(expected one of: 'Nonce-collision re-upload', 'nonce advanced past N', or 'nonce N consumed (current=...)'). " +
            "Both use the same signer, so their Bulletin chunk txs share a nonce counter and MUST contend. " +
            "If this fails, the deploys ran sequentially / fixture overlap was insufficient (the race did not stage) — " +
            "widen makeMultiChunkFixture rather than weakening this check; not necessarily a product defect (check timestamps).",
        );
      } finally {
        fs.rmSync(fixA, { recursive: true, force: true });
        fs.rmSync(fixB, { recursive: true, force: true });
      }
    });
  });

  describe("S-GRANDPA-REUPLOAD — stale finalized head must NOT trigger re-upload (#1049)", { skip: SCENARIO !== "s-grandpa-reupload", concurrency: false }, () => {
    // staleDurationMs (15s) > NATURAL_WAIT_MS (10s): the proxy stale window
    // outlasts the natural wait, so the finality-lag path fires reliably.
    //
    // Pre-#1049 this scenario asserted the OLD (buggy) behavior: a re-upload
    // fired and succeeded. That was the exact regression the issue reports —
    // the proxy only freezes chain_getFinalizedHead; chunks are genuinely
    // present in best-block the entire time. Post-#1049, the correct
    // behavior is to detect best-block presence and skip re-upload entirely,
    // then let GRANDPA catch up (bounded) once the stale window ends.
    const STALE_DURATION_MS = 15_000;
    const NATURAL_WAIT_MS = 10_000;
    const LAGGING_WAIT_MS = 20_000;

    test("stale chain_getFinalizedHead does not trigger re-upload; deploy exits 0", { timeout: DEPLOY_TIMEOUT_MS + STALE_DURATION_MS + 60_000 }, async () => {
      const rpc = await resolveE2eBulletinRpc();
      const proxyStartedAt = Date.now();
      const proxy = await startFaultProxy({
        mode: "stale-finalized-head",
        staleDurationMs: STALE_DURATION_MS,
        upstream: rpc,
      });
      const { fixtureDir } = await makeMultiChunkFixture(`s-grandpa-reupload-${RUN_TAG}`);
      try {
        const label = pickFreshRunLabel("sgreupload");
        const tld = await resolveE2eTld();
        const args = [
          fixtureDir,
          `${label}.${tld}`,
          "--tag", process.env.DEPLOY_TAG,
          "--mnemonic", ALICE_MNEMONIC,
          ...(directSignerDerivationPath() ? ["--derivation-path", directSignerDerivationPath()] : []),
          "--env", E2E_ENV_ID,
        ];
        const result = await runBulletinDeploy({
          args,
          env: {
            BULLETIN_RPC: proxy.url,
            BULLETIN_GRANDPA_NATURAL_WAIT_MS: String(NATURAL_WAIT_MS),
            BULLETIN_GRANDPA_LAGGING_WAIT_MS: String(LAGGING_WAIT_MS),
          },
          timeoutMs: DEPLOY_TIMEOUT_MS + STALE_DURATION_MS,
        });

        if (result.code !== 0) {
          failWith({
            scenario: "S-GRANDPA-REUPLOAD",
            message: `deploy must exit 0 despite stale finalized head; got exit ${result.code}`,
            context: result.stderr,
            keywords: ["Error", "finalised", "missing", "lagging"],
            hint: "Proxy held a stale chain_getFinalizedHead hash for 15s so chunks appear absent at finalized head, " +
              "but they are genuinely present in best-block the whole time. Code must detect best-block presence, " +
              "skip re-upload, and succeed once GRANDPA catches up (or after the bounded lagging wait).",
          });
        }

        // A 0 here has three different causes that the count alone cannot
        // tell apart: the client never asked for a finalised head, it asked
        // after the stale window had closed, or it asked over a channel this
        // proxy cannot see (a chainHead_* subscription rather than the legacy
        // method, or a different endpoint). Dump what the proxy observed so
        // the next occurrence answers that instead of prompting more theory.
        //
        // One theory already tested and rejected upstream (bulletin #1449):
        // content-addressed chunk reuse making Phase B upload nothing.
        // Re-running against a chain that already held identical chunks did
        // NOT reproduce it, so the fixture is deliberately left unsalted.
        const seenMethods = Object.entries(proxy.stats.methodCounts ?? {})
          .sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([m, n]) => `${m}x${n}`).join(", ") || "(none)";
        const windowInfo = proxy.stats.staleWindowOpenedAt
          ? `stale window opened +${proxy.stats.staleWindowOpenedAt - proxyStartedAt}ms after proxy start`
          : "stale window never opened (no finalised-head response passed through)";
        assert.ok(
          proxy.stats.dropsInjected >= 1,
          `>> FAIL: S-GRANDPA-REUPLOAD: proxy intercepted ${proxy.stats.dropsInjected} chain_getFinalizedHead responses; expected >= 1.\n` +
            `  chain_getFinalizedHead requests seen by proxy: ${proxy.stats.finalizedHeadRequests}\n` +
            `  ...answered after the window closed: ${proxy.stats.finalizedHeadOutsideWindow}\n` +
            `  ${windowInfo}\n` +
            `  proxy connections: ${proxy.stats.connections}\n` +
            `  methods through the proxy: ${seenMethods}\n` +
            `  How to read it: requests=0 WITH chainHead_* present means the client used the subscription path and this ` +
            `proxy never sees the probe. requests>0 with outsideWindow>0 means the probe ran after the window. ` +
            `requests=0 with no chainHead_* means the probe never ran — check whether Phase B uploaded any chunks.`,
        );

        const combined = result.stdout + result.stderr;
        assert.match(
          combined,
          /chunks? (?:not yet finalised|still missing after wait)/i,
          ">> FAIL: S-GRANDPA-REUPLOAD: expected 'chunks not yet finalised' log — stale-head path did not fire",
        );
        assert.match(
          combined,
          /finality-lagging/i,
          ">> FAIL: S-GRANDPA-REUPLOAD: expected a 'finality-lagging' log — deploy.ts did not detect best-block " +
            "presence for chunks missing only at (stale) finalized head",
        );
        assert.doesNotMatch(
          combined,
          /re-upload(?:ed|ing)/i,
          ">> FAIL: S-GRANDPA-REUPLOAD: a re-upload fired even though chunks were present in best-block the whole " +
            "time — this is exactly the #1049 regression (stale finalized head must never cause a re-upload)",
        );
      } finally {
        await proxy.close();
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S-MORTALITY — chunk tx mortal era expiry triggers retry path", { skip: SCENARIO !== "s-mortality", concurrency: false }, () => {
    // What this scenario validates: when chunk txs hit their mortal era and
    // expire, the production retry path (storeChunkedContent retry loop)
    // detects the expiry and reissues the tx with a fresh nonce. Whether
    // the deploy ultimately succeeds is NOT the test's concern — the
    // artificial expiry pressure may overwhelm even the resilience layer
    // on a slow chain. What we measure is whether the resilience FIRED.
    //
    // Pass condition: the "mortal era expiry — reissuing with fresh nonce"
    // log line appears in the deploy output (sufficient evidence the retry
    // path engaged).
    // Fail condition: the log line never appears (resilience didn't engage,
    // either because no chunk expired or because the code path is broken).
    // Deploy exit code: explicitly NOT asserted. Either outcome is fine.
    //
    // Label uses noStatusRunLabel (PoP-independent) so the test works in
    // both PopFull and NoStatus signer environments. Period=4 (~24s on 6s
    // blocks) is generous enough to let SOME chunks land while still
    // triggering expiry on slower batches.
    test("forced chunk expiry engages the retry path", { timeout: DEPLOY_TIMEOUT_MS + 3 * 60 * 1000 }, async () => {
      const label = noStatusRunLabel("smortality");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await makeMultiChunkFixture(`s-mortality-${RUN_TAG}`);
      try {
        const args = [
          fixtureDir,
          `${label}.${tld}`,
          "--tag", process.env.DEPLOY_TAG,
          "--mnemonic", ALICE_MNEMONIC,
          ...(MERKLE === "js" ? ["--js-merkle"] : []),
          ...(directSignerDerivationPath() ? ["--derivation-path", directSignerDerivationPath()] : []),
          "--env", E2E_ENV_ID,
        ];
        const result = await runBulletinDeploy({
          args,
          env: {
            BULLETIN_CHUNK_MORTALITY_PERIOD: "4",
            // Forced expiry pushes the global recovery-budget guard
            // (RETRY_BUDGET_MAX_EVENTS=5 in RETRY_BUDGET_WINDOW_MS=30000)
            // into the path of the mortality-retry path. Without raising
            // the budget, "Retry budget exhausted" fires before any
            // chunk reaches its mortal era — different resilience layer
            // wins the race. Raising the budget gives the mortality path
            // room to engage and be observed in the log.
            BULLETIN_RETRY_BUDGET_MAX: "30",
            BULLETIN_RETRY_BUDGET_WINDOW_MS: "180000",
          },
          timeoutMs: DEPLOY_TIMEOUT_MS + 3 * 60 * 1000,
        });

        const combined = result.stdout + result.stderr;
        // The resilience layer for failed chunk submissions has two log
        // surfaces, depending on how the chain rejected the tx:
        //   - "Retrying chunk N (attempt X/Y)" — generic retry log, fires
        //     for any failure mode (BadProof, subscription error,
        //     isValid:false, timeout). storeChunkedContent retry loop.
        //   - "mortal era expiry — reissuing with fresh nonce" — specific
        //     path for isValid:false (clean detection of mortality on the
        //     submission side, before the chain rejects).
        // Either log appearing in the deploy output is sufficient evidence
        // the resilience mechanism engaged. With BULLETIN_CHUNK_MORTALITY_PERIOD=4
        // and several chunks, at least one chunk should hit retry under
        // organic chain timing.
        const resilienceFired =
          /Retrying chunk \d+ \(attempt \d+\/\d+\)/i.test(combined) ||
          /mortal era expiry — reissuing with fresh nonce/i.test(combined);
        assert.ok(
          resilienceFired,
          ">> FAIL: S-MORTALITY: resilience didn't fire — no chunk-retry log appeared. " +
            "BULLETIN_CHUNK_MORTALITY_PERIOD=4 means chunk txs expire after ~4 blocks (~24s on paseo-next-v2). " +
            "If no retry log appeared, the chain was unusually stable (all chunks landed first try — consider " +
            "reducing the period further) or the retry code path is broken (check storeChunkedContent retry " +
            "loop in src/deploy.ts).\n\nstderr tail:\n" + (result.stderr ?? "").slice(-500),
        );
        // Deploy exit code is NOT asserted. Artificial expiry pressure may
        // overwhelm even the resilience layer (per-chunk retries exhaust at
        // MAX_CHUNK_RETRIES=3, or recovery-budget exhausts at 5/30s); both
        // are acceptable outcomes — we've already proven the retry mechanism
        // engaged via the log assertion above. Tests of resilience layers
        // measure that the mechanism FIRED, not that the deploy succeeded.
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  // S-SUBDOMAIN — subdomain registration under a fresh parent (#655).
  // Deploys three legs under a fresh-per-run parent label:
  //   basic       — happy-path subdomain (app.<parent>.dot)
  //   long-digits — regression guard for #654 trailing-digit sanitiser bug (pr265.<parent>.dot)
  //   orphan      — deploy to <sub>.nonexistent<token>.dot with no parent; must fail with
  //                 naming.subdomain_orphan classification (exit 78, NonRetryableError)
  describe("S-SUBDOMAIN — subdomain registration under a fresh parent", { skip: SCENARIO !== "s-subdomain", concurrency: false }, () => {
    // Scoped to this describe block; set in before() and read by the three legs.
    let freshParent = "";

    before(async () => {
      // Register a fresh parent name for this run so legs don't depend on
      // persistent fixture state. Mirrors exactly how S2 does fresh registration.
      freshParent = pickFreshRunLabel("e2esub");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${freshParent}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-SUBDOMAIN before()" });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    // Leg 1: basic happy-path subdomain deploy.
    test("basic — app.<parent>.<tld> deploys and resolves on-chain", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const tld = await resolveE2eTld();
      const target = `app.${freshParent}.${tld}`;
      const { fixtureDir } = await mutateFixture(RUN_TAG + "-sub-basic");
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, target),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-SUBDOMAIN basic" });

        const deployedCid = parseDeployedCid(stdout, "S-SUBDOMAIN basic");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        // readContenthashWithRetry takes the bare label (no .dot); getContenthash
        // does namehash("app.<parent>.dot") — correct subnode hash.
        const onChain = await readContenthashWithRetry(`app.${freshParent}`, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S-SUBDOMAIN basic", label: target });
        // Owner check is implicit: only the parent owner can write to app.<parent>.dot
        // via setSubnodeOwner; a contenthash readback that matches proves successful registration.
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    // Leg 2: long-digits regression guard (#654 trailing-digit sanitiser bug).
    // parseDomainName's subname branch never applies any digit-count rule to
    // a sublabel (validateDomainLabel is contract-syntax-only there), so
    // "pr265" is preserved as-is. This leg MUST pass on current main; the
    // assertion at the subnode "pr265.<parent>" would return empty if the
    // digit suffix was stripped.
    test("long-digits — pr265.<parent>.<tld> sublabel preserved (regression guard #654)", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const tld = await resolveE2eTld();
      const target = `pr265.${freshParent}.${tld}`;
      const { fixtureDir } = await mutateFixture(RUN_TAG + "-sub-digits");
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, target),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-SUBDOMAIN long-digits" });

        const deployedCid = parseDeployedCid(stdout, "S-SUBDOMAIN long-digits");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        // Querying exactly "pr265.<freshParent>" — if the sublabel was sanitised to
        // "pr" this read would return "0x" (empty) and assertOnChainMatches would fail,
        // catching the regression.
        const onChain = await readContenthashWithRetry(`pr265.${freshParent}`, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S-SUBDOMAIN long-digits", label: target });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });

    // Leg 3: orphan — parent does NOT exist; must fail deterministically.
    // noStatusRunLabel produces a PoP-independent unique label (appends x00 to
    // prevent trailing-digit sanitiser from reducing the uniqueness guarantee).
    // isExpectedError("Cannot deploy ...: parent ....dot is owned by no one") → true
    // → deploy.expected='true', exit 78 (NonRetryableError → EXIT_CODE_NO_RETRY).
    test("orphan — sub.<nonexistent>.<tld> rejected with exit 78", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const tld = await resolveE2eTld();
      const orphanParent = noStatusRunLabel("nonexist");
      const target = `sub.${orphanParent}.${tld}`;
      const { fixtureDir } = await mutateFixture(RUN_TAG + "-sub-orphan");
      try {
        const { code, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, target),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        if (code !== 78) {
          failWith({
            scenario: "S-SUBDOMAIN orphan",
            message: `expected EXIT_CODE_NO_RETRY (78), got ${code}`,
            context: stderr,
            keywords: ["Cannot deploy", "parent", "owned", "subdomain"],
            hint: "S-SUBDOMAIN orphan deploys to a subdomain whose parent does not exist; the CLI must refuse with exit 78 (NonRetryableError). A non-78 exit means either the guard path is broken or the parent was unexpectedly registered.",
          });
        }
        // #paseo-tld: generalized to accept THIS env's tld, mirroring the
        // naming.subdomain_orphan regex fix in src/telemetry.ts.
        assert.match(
          stderr,
          new RegExp(`Cannot deploy\\s+[\\w.-]+\\.${tld}:\\s*parent\\s+[\\w.-]+\\.${tld}\\s+is owned by no one`, "i"),
          `>> FAIL: S-SUBDOMAIN orphan: expected "Cannot deploy ... parent ....${tld} is owned by no one" in stderr — naming.subdomain_orphan guard did not fire`,
        );
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });

  describe("S-CAR — deploy from pre-built CAR file (--input-car)", { skip: SCENARIO !== "s-car" }, () => {
    test(`deploy pool/${MERKLE} via --input-car matches normal deploy CID`, { timeout: DEPLOY_TIMEOUT_MS * 2 + 60_000 }, async () => {
      // Use a fresh per-run label so first deploy hits register() rather than
      // racing with S1 on the stable pool label. Env var LABEL lets the nightly workflow
      // pass a unique per-run label; default falls back to a local stable label.
      const tld = await resolveE2eTld();
      const label = process.env.LABEL ?? (signerPopStatus >= 2 ? `e2escarpool.${tld}` : `e2escarpool01.${tld}`);
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      const dumpPath = path.join(os.tmpdir(), `e2e-s-car-${Date.now()}.car`);
      try {
        // Step 1: Normal deploy + CAR dump — establishes the expected CID.
        const r1 = await runBulletinDeploy({
          args: buildArgs(fixtureDir, label),
          env: { PAD_DUMP_CAR: dumpPath },
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r1, { scenario: "S-CAR", step: "first (normal) deploy" });
        assert.ok(fs.existsSync(dumpPath),
          `PAD_DUMP_CAR should have written ${dumpPath}`);
        const cid1 = parseDeployedCid(r1.stdout, "S-CAR");

        // Step 2: Redeploy the same content via --input-car.
        // No build-dir positional arg when --input-car is set.
        const r2 = await runBulletinDeploy({
          args: buildInputCarArgs(dumpPath, label),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded(r2, { scenario: "S-CAR", step: "--input-car deploy" });
        const cid2 = parseDeployedCid(r2.stdout, "S-CAR");

        // CID from --input-car must exactly match what the normal deploy computed.
        assert.strictEqual(cid2, cid1,
          `--input-car CID (${cid2}) must match normal deploy CID (${cid1})`);

        // On-chain DotNS contenthash must reflect the --input-car deploy.
        const expectedHash = ("0x" + encodeContenthash(cid2)).toLowerCase();
        const labelBare = label.replace(new RegExp(`\\.${tld}$`), "");
        const onChain = await readContenthashWithRetry(labelBare, expectedHash, 6, 10_000);
        assertOnChainMatches(onChain.toLowerCase(), expectedHash, { scenario: "S-CAR", label: labelBare });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
        fs.rmSync(dumpPath, { force: true });
      }
    });
  });

  // #1163: --no-manifest (--content-only) must take the content-only path even
  // when a product config is discoverable — proving shouldPublishManifest()'s
  // short-circuit actually fires in the real CLI, not just in unit tests.
  // The per-leg pool domain (BULLETIN_POOL_ACCOUNT_INDEX, #1054) dedicated to
  // this scenario never sees a manifest publish, so "manifest text record
  // empty" / "app subname absent" hold across every re-run, not just the first.
  describe("S-CONTENT-ONLY — --no-manifest skips manifest publishing despite a discoverable config (#1163)", { skip: SCENARIO !== "s-content-only" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} with --no-manifest takes the content-only path`, { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const label = perLegPoolLabel() ?? pickFreshRunLabel("e2enomani");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      const { configPath, sidecarDir } = buildManifestSidecar({ buildDir: fixtureDir, label: `${label}.${tld}`, tld });
      try {
        const args = [...buildArgs(fixtureDir, `${label}.${tld}`), "--config", configPath, "--no-manifest"];
        const { code, stdout, stderr } = await runBulletinDeploy({
          args,
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-CONTENT-ONLY" });

        // The plain content deploy must still have succeeded and resolve
        // on-chain — --no-manifest changes ONLY the manifest-publish decision.
        const deployedCid = parseDeployedCid(stdout, "S-CONTENT-ONLY");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S-CONTENT-ONLY", label });

        // #1163: assert the manifest path never ran, despite the config at
        // configPath being genuinely discoverable (tryLoadProductConfig still
        // loads it — shouldPublishManifest() is what must gate the skip).
        const connectOpts = await resolveDotnsEnvConnectOptions();
        const dotns = new DotNS();
        await dotns.connect({ mnemonic: ALICE_MNEMONIC, ...connectOpts });
        try {
          const manifestText = await dotns.getTextRecord(label, "manifest");
          if (manifestText !== "") {
            failWith({
              scenario: "S-CONTENT-ONLY",
              message: `root 'manifest' text record must be empty with --no-manifest set, got ${manifestText.length} B`,
              context: manifestText,
              hint: "a non-empty record means --no-manifest did not short-circuit shouldPublishManifest() (#1163) even though a config was discoverable.",
            });
          }

          const appSub = await dotns.checkSubdomainOwnership("app", label);
          if (appSub.owner !== null) {
            failWith({
              scenario: "S-CONTENT-ONLY",
              message: `app.${label}.${tld} subname must not exist with --no-manifest set (owner=${appSub.owner})`,
              hint: "manifest publish (which registers per-executable subnames) must never run when --no-manifest is set.",
            });
          }
        } finally {
          dotns.disconnect();
        }
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
        fs.rmSync(sidecarDir, { recursive: true, force: true });
      }
    });
  });

  // #1094: publishManifest must resolve ITS OWN Bulletin endpoint from the
  // deploy's --env/--rpc (via resolveBulletinEndpoints/setBulletinEndpoints —
  // the same precedence deploy() itself uses) before uploading the icon,
  // otherwise the icon lands on the module's hardcoded DEFAULT_BULLETIN_RPC
  // regardless of which chain the rest of the deploy targeted.
  //
  // This exercises that resolution against a REAL non-default env end-to-end.
  // Every e2eEligible env in environments.json (paseo-next-v2, devnet) has a
  // Bulletin endpoint that differs from DEFAULT_BULLETIN_RPC, and
  // nightly-pr-coverage always sets PAD_ENV via select-env, so this
  // scenario is "non-default" by construction in CI.
  //
  // Note: the exact standalone-call regression #1094 fixed (publishManifest()
  // invoked without a preceding in-process deploy() in the same process) can't
  // be reproduced through the CLI, because the CLI always calls deploy()
  // before publishManifest() in one process, and deploy() sets the
  // module-level Bulletin endpoint as a side effect either way. That exact
  // standalone-call shape is unit-tested directly in
  // test/product-manifest.test.js. This E2E scenario instead proves the real
  // end-to-end behavior a unit test (which mocks the network) cannot: the
  // icon actually lands on, and is fetchable from, the resolved env's own
  // gateway.
  describe("S-MANIFEST-ENV — manifest publish honors --env for icon Bulletin storage on a non-default env (#1094)", { skip: SCENARIO !== "s-manifest-env" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} with a manifest lands the icon on the resolved env's Bulletin chain`, { timeout: DEPLOY_TIMEOUT_MS + 5 * 60 * 1000 + 30_000 }, async () => {
      // The regression this guards is publishManifest ignoring --env and
      // uploading to the built-in endpoint, so the run's own Bulletin endpoint
      // has to differ from it for the scenario to prove anything.
      const envBulletinRpc = await resolveE2eBulletinRpc();
      assert.notEqual(envBulletinRpc, DEFAULT_BULLETIN_RPC,
        `>> FAIL: S-MANIFEST-ENV: ${E2E_ENV_ID} resolves to the built-in Bulletin endpoint ${envBulletinRpc}, so an icon uploaded to the wrong chain would be indistinguishable from a correct one. Run this scenario against an env with its own Bulletin chain.`);

      const label = perLegPoolLabel() ?? pickFreshRunLabel("e2emanenv");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      const { configPath, iconPath, sidecarDir } = buildManifestSidecar({ buildDir: fixtureDir, label: `${label}.${tld}`, tld });
      try {
        const args = [...buildArgs(fixtureDir, `${label}.${tld}`), "--config", configPath];
        const { code, stdout, stderr } = await runBulletinDeploy({
          args,
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-MANIFEST-ENV" });

        const deployedCid = parseDeployedCid(stdout, "S-MANIFEST-ENV");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S-MANIFEST-ENV", label });

        const iconCid = parseLineOrExplain(stdout, {
          // The icon is a single small file → a raw-codec CIDv1 ("bafk…"), NOT
          // the dag-pb "bafy…" of a directory/root. Match any CIDv1 base32
          // (baf…) so both codecs are accepted (the earlier bafy-only pattern
          // false-failed S-MANIFEST-ENV on the real bafk icon CID).
          pattern: /Icon CID:\s+(baf\S+)/,
          scenario: "S-MANIFEST-ENV",
          what: "manifest icon CID",
          hint: "publishManifest logs 'Icon CID: bafk...' right after uploading the icon (src/manifest/publish.ts). Missing means manifest publish either didn't run or failed before reaching the icon upload — check for a preceding 'Manifest publish failed' line.",
        })[1];

        // Poll the RESOLVED env's own gateway (not the module default) —
        // gateway indexing lags the on-chain write by a few seconds (same
        // tolerance pattern as S-INC's root-URL poll above).
        const gatewayBase = await resolveE2eGateway();
        const iconUrl = `${gatewayBase}/ipfs/${iconCid}`;
        const wantBytes = fs.readFileSync(iconPath);
        let gotBytes = null;
        let lastStatus = null;
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(iconUrl, { cache: "no-store" });
            lastStatus = res.status;
            if (res.status === 200) {
              gotBytes = Buffer.from(await res.arrayBuffer());
              if (gotBytes.equals(wantBytes)) break;
            }
          } catch { /* network blips OK — same tolerance as S-INC's poll */ }
          await new Promise((r) => setTimeout(r, 10_000));
        }

        if (!gotBytes || !gotBytes.equals(wantBytes)) {
          failWith({
            scenario: "S-MANIFEST-ENV",
            message: `icon CID ${iconCid} not retrievable (byte-identical) from ${E2E_ENV_ID}'s own gateway (${iconUrl}) within 5 min (last HTTP status ${lastStatus})`,
            hint: "publishManifest may have uploaded the icon to the wrong Bulletin chain (DEFAULT_BULLETIN_RPC instead of the resolved env) — the #1094 regression this scenario guards against.",
          });
        }
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
        fs.rmSync(sidecarDir, { recursive: true, force: true });
      }
    });
  });

  describe("S-MANIFEST-PVM: App v2 PolkaVM manifest publishes and round-trips on app.<label>", { skip: SCENARIO !== "s-manifest-pvm" }, () => {
    test(`deploy ${SIGNER}/${MERKLE} with a PolkaVM App v2 manifest`, { timeout: DEPLOY_TIMEOUT_MS + 5 * 60 * 1000 + 30_000 }, async () => {
      const scenario = "S-MANIFEST-PVM";
      const label = perLegPoolLabel() ?? pickFreshRunLabel("e2epvmman");
      const tld = await resolveE2eTld();
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      // Nothing runs it; with manifest.json it makes detectBuildMarkers see a PolkaVM app build.
      fs.writeFileSync(path.join(fixtureDir, "app.polkavm"), `e2e polkavm placeholder ${RUN_TAG}\n`);
      const appManifest = buildPvmAppManifest();
      const { configPath, sidecarDir } = buildManifestSidecar({ buildDir: fixtureDir, label: `${label}.${tld}`, tld, appManifest });
      try {
        const args = [...buildArgs(fixtureDir, `${label}.${tld}`), "--config", configPath];
        const { code, stdout, stderr } = await runBulletinDeploy({
          args,
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario });

        // The executable's path is the build dir, so app.<label> carries the deploy's CID.
        const deployedCid = parseDeployedCid(stdout, scenario);
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(`app.${label}`, expected);
        assertOnChainMatches(onChain, expected, { scenario, label: `app.${label}` });

        const wantJson = JSON.stringify(appManifest);
        const gotJson = await readTextRecordWithRetry(`app.${label}`, "executable", E2E_ENV_ID, (raw) => raw === wantJson);
        if (gotJson !== wantJson) {
          failWith({
            scenario,
            message: `'executable' text record on app.${label}.${tld} does not byte-match the validated manifest`,
            context: `wrote: ${wantJson}\nchain: ${gotJson === "" ? "(unset)" : gotJson}`,
            hint: "The record lands in the same tx as the contenthash checked above, and the read was retried, so this is not lag: src/manifest/publish.ts wrote bytes other than JSON.stringify of the manifest.",
          });
        }
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
        fs.rmSync(sidecarDir, { recursive: true, force: true });
      }
    });
  });

  // S-V060-UNBLOCK — bulletin #1423/#1410. v0.6.0 deletes PopRules'
  // trailing-digit-count rule and changes how baseLength is measured,
  // unblocking two label shapes that are illegal on every earlier generation:
  //   A. base-8 + exactly 2 trailing digits (the production "dotworld01"
  //      shape) — old profiles: 6-8 base band + 2-digit Lite signal => PopLite.
  //   B. exactly 1 trailing digit, base >= 9 as written ("myapp-pr7" shape)
  //      — old profiles: the independent 1-or-3+-trailing-digit rule => Reserved.
  // Both classify NoStatus on v0.6.0 (open to any account).
  //
  // NOTE — this twin has no preview env, so this scenario only ever runs
  // against paseo-next-v2.
  //
  // GATED, not by SCENARIO's static describe-skip (profile is only knowable
  // from a live chain probe), but dynamically per-test via detectDotnsProfile():
  //   - default (no E2E_REQUIRE_PROFILE): a non-v0.6.0 chain SKIPS loudly,
  //     naming the detected profile — a silent skip here would be a false
  //     green identical in shape to the noStatusRunLabel blind spot this
  //     scenario exists to close.
  //   - E2E_REQUIRE_PROFILE=v0.6.0: a non-v0.6.0 chain FAILS instead, because
  //     the caller explicitly asked for v0.6.0 validation and did not get it.
  //
  // False-green guard: on testnets, when preflight's canRegister check fails
  // for a NoStatus signer, the CLI can self-serve a fresh personhood proof via
  // AliasAccounts.reprove_alias_account (the "auto-reprove" path, src/dotns.ts's
  // preflight internals) and retry — a signer whose alias happens to be stale
  // would then pass preflight via a REFRESHED PoP grant, not via v0.6.0's
  // NoStatus semantics, and the deploy would succeed for entirely the wrong
  // reason on an OLD-profile chain too. Every assertion below therefore checks
  // the MECHANISM (profile + classification + absence of that self-grant
  // path), not just exit code 0.
  describe("S-V060-UNBLOCK — v0.6.0 unblocks base-8+2-digit and 1-trailing-digit labels (#1410)", { skip: SCENARIO !== "s-v060-unblock" }, () => {
    let detectedProfile = null;
    before(async () => {
      detectedProfile = await detectDotnsProfile();
    });

    // Returns true when the test should proceed; false when it skipped.
    // Throws (via failWith) in gate mode when the required profile is absent.
    //
    // THREE distinct outcomes, never collapsed into one another — each has a
    // different remedy:
    //   1. profile === "v0.6.0" -> proceed.
    //   2. noCode -> no contract code at the configured POP_RULES address
    //      (e.g. a redeploy in flight, or a stale/wrong configured address).
    //      This is explicitly NOT "wrong profile" and must never be reported
    //      as such — the message says "no contract code", full stop.
    //   3. a different, real profile answered -> "not v0.6.0", named.
    function gateOnV060Profile(t) {
      if (detectedProfile.profile === "v0.6.0") return true;

      if (detectedProfile.noCode) {
        if (process.env.E2E_REQUIRE_PROFILE === "v0.6.0") {
          failWith({
            scenario: "S-V060-UNBLOCK",
            message: `E2E_REQUIRE_PROFILE=v0.6.0 was set but there is NO CONTRACT CODE at the configured DotNS address — v0.6.0 validation did not run`,
            context: detectedProfile.error,
            hint: "this is NOT \"the wrong profile\" — environments.json's configured POP_RULES address currently has nothing deployed (e.g. a redeploy in flight). Wait for the redeploy to land and re-run, or fix environments.json/--contract if the configured address is simply stale.",
          });
        }
        console.log("=".repeat(60));
        console.log(`>> S-V060-UNBLOCK: SKIPPING — NO CONTRACT CODE at the configured DotNS address; cannot determine the ABI profile at all.`);
        console.log(`   ${detectedProfile.error}`);
        console.log(`   This is DIFFERENT from "wrong profile" — it usually means a redeploy is in flight. Set`);
        console.log(`   E2E_REQUIRE_PROFILE=v0.6.0 to turn this into a hard failure instead of a skip.`);
        console.log("=".repeat(60));
        t.skip("no contract code at the configured DotNS address — cannot determine ABI profile");
        return false;
      }

      if (process.env.E2E_REQUIRE_PROFILE === "v0.6.0") {
        failWith({
          scenario: "S-V060-UNBLOCK",
          message: `E2E_REQUIRE_PROFILE=v0.6.0 was set but the connected chain detected DotNS ABI profile "${detectedProfile.profile}" — v0.6.0 validation did not run`,
          hint: "this env has not received the v0.6.0 DotNS redeploy yet. Point --env at an env that has the v0.6.0 redeploy, or drop E2E_REQUIRE_PROFILE to let this scenario soft-skip instead.",
        });
      }
      console.log("=".repeat(60));
      console.log(`>> S-V060-UNBLOCK: SKIPPING — detected DotNS ABI profile "${detectedProfile.profile}", not "v0.6.0".`);
      console.log(`   This scenario exercises v0.6.0-only naming semantics (base-8+2-digit / 1-trailing-digit`);
      console.log(`   labels) that do not exist on this chain yet. Set E2E_REQUIRE_PROFILE=v0.6.0 to turn a`);
      console.log(`   missing v0.6.0 chain into a hard failure instead of a skip.`);
      console.log("=".repeat(60));
      t.skip(`detected DotNS ABI profile "${detectedProfile.profile}", not v0.6.0`);
      return false;
    }

    // Asserts the mechanism a successful v0.6.0-unblock deploy must show, and
    // must NOT show, for one label. Shared by both label tests below so the
    // two can't drift apart on what "for the right reason" means.
    async function assertV060UnblockMechanism({ label, tld, combined }) {
      assertStdoutMatches(combined, /DotNS ABI profile v0\.6\.0 detected/, {
        scenario: "S-V060-UNBLOCK",
        what: `${label}: deploy log must report the v0.6.0 ABI profile`,
        hint: "detectProtocolVersion logs 'DotNS ABI profile <profile> detected on <env>' (src/dotns.ts) — missing means the chain served a different profile mid-run, or the log line format moved.",
      });

      assertStdoutMatches(combined, new RegExp(`DotNS: ${label}\\.${tld} requires NoStatus\\b`), {
        scenario: "S-V060-UNBLOCK",
        what: `${label}: preflight must classify NoStatus (v0.6.0 dropped the rule that would otherwise require personhood/reject this shape)`,
        hint: "deploy.ts logs 'DotNS: <label>.<tld> requires <Status>' via popStatusName(classification.status) — a different status here means v0.6.0 semantics did not apply as expected for this label shape.",
      });

      // False-green guard (see this describe's own doc comment): none of
      // the auto-reprove/self-grant log markers may appear. Their presence
      // means the deploy succeeded via a refreshed personhood proof, not via
      // v0.6.0's NoStatus semantics — indistinguishable at the exit-code
      // level, so this is the one place that tells the difference.
      for (const marker of ["Submitting reprove_alias_account", "alias revision stale", "Refresh complete (revision"]) {
        assert.ok(
          !combined.includes(marker),
          `>> FAIL: S-V060-UNBLOCK: ${label}: deploy log contains "${marker}" — the PoP auto-reprove/self-grant path fired. ` +
          `That would make this deploy succeed via an on-chain personhood refresh, not v0.6.0's NoStatus semantics — a false ` +
          `green identical to the failure mode this scenario exists to catch. seen tail: ${combined.slice(-500)}`,
        );
      }

      // Second false-green guard, same shape as the one above but via a
      // DIFFERENT door: RUN_TOKEN is fixed for the whole run (and across a
      // nick-fields/retry re-attempt of this same test file — no
      // run_attempt in its entropy, unlike sibling scenarios), so the label
      // is IDENTICAL on a retry. If attempt 1 registered successfully but
      // the test failed later (e.g. the contenthash read flaked) before
      // reaching this assertion, attempt 2 finds the label already owned by
      // this same signer — the preflight's "already-owned-by-us" branch
      // (src/dotns.ts) returns BEFORE the classification/PoP gate ever
      // runs, so classification/NoStatus still print (deploy.ts's reqSuffix
      // appends this exact marker right after them) even though registration
      // itself was never exercised on THIS run. That is a green result that
      // never actually proved the label registrable.
      assert.ok(
        !combined.includes("already owned, requirement not enforced"),
        `>> FAIL: S-V060-UNBLOCK: ${label}: deploy log contains "already owned, requirement not enforced" — this label was ` +
        `ALREADY OWNED by this signer before this run started (likely a stale name from a prior attempt/retry sharing the ` +
        `same RUN_TOKEN), so this run took the already-owned fast path and never exercised registration. That proves ` +
        `nothing about the label's registrability — rerun with a fresh RUN_TOKEN (a new GITHUB_RUN_ID/sha, or transfer/` +
        `release the stale name) so a real register() attempt runs. seen tail: ${combined.slice(-500)}`,
      );
    }

    // Shared by both label-shape tests below — the deploy/assert/cleanup
    // sequence is identical for both; only the label builder differs.
    async function runV060UnblockCase(t, buildLabel) {
      if (!gateOnV060Profile(t)) return;

      const tld = await resolveE2eTld();
      const label = buildLabel(RUN_TOKEN);
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        assertDeploySucceeded({ code, stdout, stderr }, { scenario: "S-V060-UNBLOCK", step: `deploy ${label}` });
        const combined = `${stdout}\n${stderr}`;
        await assertV060UnblockMechanism({ label, tld, combined });

        const deployedCid = parseDeployedCid(stdout, "S-V060-UNBLOCK");
        const expected = ("0x" + encodeContenthash(deployedCid)).toLowerCase();
        const onChain = await readContenthashWithRetry(label, expected);
        assertOnChainMatches(onChain, expected, { scenario: "S-V060-UNBLOCK", label });
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    }

    test("base-8 + 2 trailing digits unblocked (the production \"dotworld01\" shape)", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async (t) => {
      await runV060UnblockCase(t, buildBase8TwoDigitLabel);
    });

    test("1 trailing digit, base >= 9 as written unblocked (the \"myapp-pr7\" shape)", { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async (t) => {
      await runV060UnblockCase(t, buildOneTrailingDigitLabel);
    });
  });

  // S-RESERVED-INVARIANT — bulletin #1423/#1410. The invariant Deliverable-1
  // does NOT change: base names of 5 chars or fewer stay Reserved
  // (governance-only, never self-registrable) on EVERY DotNS generation, old
  // and v0.6.0 alike. UNGATED — runs on every environment, every night,
  // regardless of which profile is live, because it guards the opposite
  // failure from S-V060-UNBLOCK: that the v0.6.0 naming change did not
  // accidentally make a governance-reserved name self-registrable. "web3" is
  // Reserved on both generations already (test/test.js's S-V060-UNBLOCK
  // label-builder describe block pins the classifyDotnsLabel side of this),
  // but for a DIFFERENT reason per generation: old profiles via the
  // independent 1-trailing-digit rule, v0.6.0 via base length alone (4 <= 5)
  // — this scenario doesn't care WHICH reason fired, only that the refusal
  // happened, non-retryably, before any chain write.
  describe("S-RESERVED-INVARIANT — base names <=5 chars stay Reserved on every DotNS generation (#1410)", { skip: SCENARIO !== "s-reserved-invariant" }, () => {
    test('deploy to a governance-reserved label ("web3") is refused non-retryably, before any registration tx', { timeout: DEPLOY_TIMEOUT_MS + 30_000 }, async () => {
      const tld = await resolveE2eTld();
      const label = "web3";
      const { fixtureDir } = await mutateFixture(RUN_TAG);
      try {
        const { code, stdout, stderr } = await runBulletinDeploy({
          args: buildArgs(fixtureDir, `${label}.${tld}`),
          timeoutMs: DEPLOY_TIMEOUT_MS,
        });
        const combined = `${stdout}\n${stderr}`;

        if (code !== 78) {
          failWith({
            scenario: "S-RESERVED-INVARIANT",
            message: `expected EXIT_CODE_NO_RETRY (78) for governance-reserved label "${label}.${tld}", got ${code}`,
            context: combined,
            keywords: ["Error", "Reserved", "governance", "requires"],
            hint: "base names <=5 chars are reserved for governance on every DotNS generation (classifyRegistrability's reserved-base rule, or the old profiles' trailing-digit rule) — this must never become registrable.",
          });
        }

        assertStdoutMatches(combined, new RegExp(`DotNS: ${label}\\.${tld} requires Reserved\\b`), {
          scenario: "S-RESERVED-INVARIANT",
          what: "preflight must classify the label Reserved on every DotNS generation",
          hint: "deploy.ts logs 'DotNS: <label>.<tld> requires <Status>' via popStatusName(classification.status) — Reserved must hold regardless of which profile is live.",
        });

        assert.match(
          combined,
          /reserves base names of 5 chars or fewer for governance|trailing digit/i,
          `>> FAIL: S-RESERVED-INVARIANT: refusal reason must cite the governance-reserved rule (base length on v0.6.0, or the trailing-digit count on older profiles) — seen tail: ${combined.slice(-500)}`,
        );

        // "Cost nothing": the DotNS preflight abort throws BEFORE the Storage
        // phase begins (deploy.ts), so no chunk upload or registration
        // transaction is ever attempted. Belt-and-suspenders check on the
        // observable output, in case that ordering ever regresses silently.
        for (const marker of ["Status: Registering", "Commitment", "Storage\n" + "=".repeat(60)]) {
          assert.ok(
            !combined.includes(marker),
            `>> FAIL: S-RESERVED-INVARIANT: output contains "${marker}" — a registration/storage step must never run for a governance-reserved label (this scenario must cost nothing).`,
          );
        }
      } finally {
        fs.rmSync(fixtureDir, { recursive: true, force: true });
      }
    });
  });
});
