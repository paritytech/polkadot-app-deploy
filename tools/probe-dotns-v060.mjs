#!/usr/bin/env node
/**
 * probe-dotns-v060.mjs — REPORTS on three open v0.6.0 questions; asserts nothing.
 *
 * Usage:
 *   node tools/probe-dotns-v060.mjs [--env <id>]
 *
 *   --env    Environment id from assets/environments.json (default: paseo-next-v2)
 *
 * This is a read-only reconnaissance tool, not a test. It exists because three
 * facts about the live v0.6.0 PopRules/DotnsPopController deployment are
 * currently UNKNOWN from source alone (see paritytech/bulletin-deploy#1410 /
 * #1416) and can only be answered by asking a live chain:
 *
 *   1. PopRules.shortNamesEnabled — `_requireShortNamesOpen` (source-confirmed,
 *      see src/dotns.ts's classifyLabelStatus v0.6.0 comment) is
 *      `require(shortNamesEnabled || baseLength >= 9, "Short names are not
 *      for sale")`. bulletin-deploy's classifier models ONLY the personhood-
 *      tier half of the 6-8 band's gate (PopLite/PopFull) — it has no idea
 *      whether the OWNER-SETTABLE shortNamesEnabled flag is even open right
 *      now. A signer holding the right personhood tier is therefore NOT
 *      guaranteed to be able to register a 6-8 char name. This probe reads
 *      the flag directly (if a public accessor exists) so that gap is at
 *      least VISIBLE, even though bulletin-deploy doesn't act on it.
 *
 *   2. DotnsPopController.isSoulbound(uint256) on an UNKNOWN (never-minted)
 *      tokenId — does it revert, or return false? This is the retired half
 *      of the v0.6.0 discriminator decision (#1410): isPopIssued(label) was
 *      chosen over isSoulbound(tokenId) as the profile-detection probe
 *      specifically because a probe that ANSWERS (does not revert) on an
 *      arbitrary/unregistered input is a cleaner "this function exists"
 *      signal than one that might legitimately revert on out-of-range input
 *      for reasons unrelated to the function's mere presence. This probe
 *      answers which behavior isSoulbound actually has, closing that
 *      question empirically instead of leaving it asserted-but-unverified.
 *
 *   3. The detected DotNS ABI profile (via the SAME live-probe path
 *      DotNS.connect() itself runs — see detectProtocolVersion, src/dotns.ts)
 *      and whether the isPopIssued discriminator actually answered on this
 *      env (vs. falling back because DOTNS_POP_CONTROLLER has no configured
 *      address here). THREE distinct outcomes are reported here, never
 *      collapsed into one another: a profile answered; NO CONTRACT CODE at
 *      the configured address (a redeploy-in-flight / stale-address
 *      condition — NOT "wrong profile", and not something this probe or
 *      s-v060-unblock's gate mode may ever describe as "not v0.6.0"); or
 *      code present-or-unverified with neither discriminator answering (a
 *      genuinely unrecognized ABI, or a connection/RPC issue). Each has a
 *      different remedy — see this env's own OUTCOME line below.
 *
 * IMPORTANT — isSoulbound's exact signature is NOT independently confirmed
 * against dotns contract source the way isPopIssued's is (see
 * src/dotns-protocol.ts's POP_CONTROLLER_PROBE_ABI comment); it is assumed
 * from the task description that named it (`isSoulbound(uint256)` -> bool).
 * If this probe reports "ERROR" rather than "REVERTS" or "returns false",
 * the assumed signature itself may be wrong — read the error message.
 *
 * Every query is a read-only dry-run (ReviveApi.call). No transactions, no
 * state writes. Reads contract addresses from assets/environments.json via
 * --env — never a hardcoded address (a testnet redeploy keeps every CREATE3
 * address identical, so a stale hardcoded address would look like "no code"
 * rather than "wrong env").
 */
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { DotNS } from "../dist/dotns.js";
import { POP_CONTROLLER_PROBE_ABI, PROTOCOL_PROBE_LABEL, DOTNS_ABI_PROFILES } from "../dist/dotns-protocol.js";
import { dryRun } from "./_revive-dry-run.mjs";

// Assumed signature (see module doc comment's IMPORTANT note above) — a
// plain view getter, no known public accessor confirmed against source.
const SHORT_NAMES_ENABLED_ABI = [
  { type: "function", name: "shortNamesEnabled", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
];

// Assumed signature (see module doc comment's IMPORTANT note above).
const IS_SOULBOUND_ABI = [
  { type: "function", name: "isSoulbound", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
];

// A tokenId that has (almost) certainly never been minted. 0 is a common
// sentinel/never-issued id in ERC-721-shaped contracts; if the real contract
// starts numbering at 0 this may need adjusting — that's exactly the kind of
// fact this probe is meant to surface, not assume.
const UNKNOWN_TOKEN_ID = 0n;

// Runs one dryRun call and reports exactly one of three outcomes — answered,
// reverted (dryRun's `.reverted` flag — a clean "the call completed but
// rejected this input" signal), or errored (anything else: a connection/RPC
// issue, or a wrong assumed signature). Every probe below (shortNamesEnabled,
// isSoulbound, isPopIssued) shares this exact three-way branch; only the
// outcome-specific message text differs per call site.
async function probeAndReport(fn, { onOk, onRevert, onError }) {
  let lines;
  try {
    lines = onOk(await fn());
  } catch (e) {
    lines = e.reverted ? onRevert(e) : onError(e);
  }
  for (const line of Array.isArray(lines) ? lines : [lines]) console.log(line);
}

const rawArgv = process.argv.slice(2);
let ENV_ID = "paseo-next-v2";
for (let i = 0; i < rawArgv.length; i++) {
  if (rawArgv[i] === "--env") { ENV_ID = rawArgv[++i]; continue; }
  if (["--help", "-h"].includes(rawArgv[i])) {
    console.log("Usage: node tools/probe-dotns-v060.mjs [--env <id>]");
    console.log("");
    console.log("Reports (does not assert) on three open v0.6.0 questions:");
    console.log("  1. PopRules.shortNamesEnabled (is there a public accessor? what does it say?)");
    console.log("  2. DotnsPopController.isSoulbound(uint256) on an unknown tokenId: reverts, or false?");
    console.log("  3. The detected DotNS ABI profile, and whether isPopIssued answered here.");
    process.exit(0);
  }
  console.error(`Unknown flag: ${rawArgv[i]}`);
  process.exit(2);
}

const { loadEnvironments, resolveEndpoints } = await import("../dist/environments.js");
// loadEnvironments() returns { doc, source } — this tool's whole job is
// reporting ground truth about what's live, so which environments.json
// source won (local file vs. a remote prefetch/refresh) belongs in the
// report too, not just the addresses it produced.
const { doc, source } = await loadEnvironments();
const envEntry = doc.environments.find((e) => e.id === ENV_ID);
if (!envEntry) {
  console.error(`Unknown env "${ENV_ID}". Known: ${doc.environments.map((e) => e.id).join(", ")}`);
  process.exit(2);
}
const resolved = resolveEndpoints(doc, ENV_ID);
const RPC = resolved.assetHub[0];
const POP_RULES = envEntry.contracts?.POP_RULES;
const DOTNS_POP_CONTROLLER = envEntry.contracts?.DOTNS_POP_CONTROLLER;
if (!RPC || !POP_RULES) {
  console.error(`env "${ENV_ID}" is missing an asset-hub endpoint or POP_RULES address`);
  process.exit(2);
}

const ALICE_DEV = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
await cryptoWaitReady();
const keyring = new Keyring({ type: "sr25519" });
const alice = keyring.addFromUri(ALICE_DEV);

console.log(`env:                  ${ENV_ID}`);
console.log(`environments.json:    ${source}`);
console.log(`RPC (asset-hub):      ${RPC}`);
console.log(`POP_RULES:            ${POP_RULES}`);
console.log(`DOTNS_POP_CONTROLLER: ${DOTNS_POP_CONTROLLER ?? "(not configured for this env)"}`);
console.log("");

// --- 3. Detected ABI profile (reuses the library's own live-probe path) ---
//
// THREE distinct outcomes here, never collapsed into each other (each has a
// completely different remedy):
//   1. a profile answered — report which, via the public `protocolVersion`
//      getter (not by scraping connect()'s own log line).
//   2. NO CONTRACT CODE at the configured POP_RULES address — this is NOT
//      "wrong profile", it means environments.json's configured address
//      currently has nothing deployed (e.g. a redeploy in flight, or a
//      stale/wrong address). Remedy: wait, or fix environments.json.
//   3. code is present (or its presence could not be verified) but neither
//      known discriminator answered — a genuinely unrecognized ABI, or a
//      transient RPC issue. Remedy: investigate; do NOT assume "not v0.6.0".
console.log("=== 1. Detected DotNS ABI profile (DotNS.connect()'s own probe) ===");
try {
  const dotns = new DotNS();
  await dotns.connect({
    mnemonic: ALICE_DEV,
    rpc: resolved.assetHub[0],
    assetHubEndpoints: resolved.assetHub,
    autoAccountMapping: resolved.autoAccountMapping,
    contracts: Object.keys(resolved.contracts).length > 0 ? resolved.contracts : undefined,
    nativeToEthRatio: resolved.nativeToEthRatio,
    tld: resolved.tld,
    environmentId: ENV_ID,
  });
  const profile = dotns.protocolVersion; // public getter — read directly, never scraped from a log line
  const info = DOTNS_ABI_PROFILES[profile];
  console.log(`OUTCOME: PROFILE DETECTED`);
  console.log(`profile:      ${profile}`);
  console.log(`introducedAt: ${info?.introducedAt ?? "(unknown)"}   discriminator: ${info?.discriminator ?? "(unknown)"}`);
  dotns.disconnect();
} catch (e) {
  const msg = e.message ?? String(e);
  if (/No contract deployed at this address/.test(msg)) {
    console.log(`OUTCOME: NO CONTRACT CODE at ${POP_RULES} — cannot determine the ABI profile at all.`);
    console.log(`   This is NOT "not v0.6.0" — environments.json's configured address currently has nothing`);
    console.log(`   deployed here (e.g. a redeploy in flight). Remedy: wait and re-probe, or fix the configured`);
    console.log(`   address if it is simply stale/wrong.`);
    console.log(`   raw: ${msg}`);
  } else {
    console.log(`OUTCOME: DETECTION FAILED for a DIFFERENT reason (code present-or-unverified, but neither`);
    console.log(`   discriminator answered — or a connection/RPC error). Do not assume this means "not v0.6.0"`);
    console.log(`   either; read the raw message.`);
    console.log(`   raw: ${msg}`);
  }
}

// --- 1. PopRules.shortNamesEnabled ---
console.log("\n=== 2. PopRules.shortNamesEnabled (owner-settable 6-8 band gate, source-confirmed to exist on-chain, NOT confirmed to have a public accessor) ===");
{
  const client = createClient(getWsProvider(RPC, { heartbeatTimeout: 60_000 }));
  try {
    const api = client.getUnsafeApi();
    await probeAndReport(
      () => dryRun(api, alice.address, POP_RULES, SHORT_NAMES_ENABLED_ABI, "shortNamesEnabled", []),
      {
        onOk: (result) => `shortNamesEnabled: ${result} (public accessor exists and answered)`,
        onRevert: () => `REVERTS — no public accessor named "shortNamesEnabled" on this PopRules deployment (or it is not a bare view getter). Determined by: dry-run call reverted (flags=1 or empty data), not a connection/RPC failure.`,
        onError: (e) => `ERROR (not a plain revert — connection/RPC issue, not a signal about the accessor): ${e.message}`,
      },
    );
  } finally {
    client.destroy();
  }
}

// --- 2. DotnsPopController.isSoulbound(unknown tokenId) ---
console.log("\n=== 3. DotnsPopController.isSoulbound(uint256) on an unknown tokenId (retires the isPopIssued-vs-isSoulbound discriminator question, #1416) ===");
if (!DOTNS_POP_CONTROLLER) {
  console.log(`SKIPPED — DOTNS_POP_CONTROLLER has no configured address for env "${ENV_ID}".`);
} else {
  const client = createClient(getWsProvider(RPC, { heartbeatTimeout: 60_000 }));
  try {
    const api = client.getUnsafeApi();
    await probeAndReport(
      () => dryRun(api, alice.address, DOTNS_POP_CONTROLLER, IS_SOULBOUND_ABI, "isSoulbound", [UNKNOWN_TOKEN_ID]),
      {
        onOk: (result) => `isSoulbound(${UNKNOWN_TOKEN_ID}) returns ${result} — does NOT revert on an unknown tokenId.`,
        onRevert: () => `REVERTS on an unknown tokenId (tokenId=${UNKNOWN_TOKEN_ID}). This is why isPopIssued was chosen as the v0.6.0 discriminator instead: a probe that reverts on ordinary unregistered input is a weaker "function exists" signal than one that answers cleanly.`,
        onError: (e) => `ERROR (not a plain revert — connection/RPC issue, or the assumed signature "isSoulbound(uint256)" is wrong; see this file's IMPORTANT note): ${e.message}`,
      },
    );

    // Companion read: does isPopIssued itself answer here? (Same probe the
    // library's own detectProtocolVersion runs — see POP_CONTROLLER_PROBE_ABI.)
    await probeAndReport(
      () => dryRun(api, alice.address, DOTNS_POP_CONTROLLER, POP_CONTROLLER_PROBE_ABI, "isPopIssued", [PROTOCOL_PROBE_LABEL]),
      {
        onOk: (result) => `isPopIssued("${PROTOCOL_PROBE_LABEL}") answers: ${result} — the discriminator DOES answer on this env (this is v0.6.0 or later).`,
        onRevert: () => `isPopIssued REVERTS on this env — the discriminator does NOT answer (this is poprules-startingPrice or v0.5.8-rc1, or DotnsPopController is not the v0.6.0 deployment).`,
        onError: (e) => `ERROR probing isPopIssued: ${e.message}`,
      },
    );
  } finally {
    client.destroy();
  }
}
