#!/usr/bin/env node
/**
 * tools/check-env-readiness.mjs
 *
 * Readiness check for ONE e2eEligible environment (#1624), run by the select-env
 * job after probe-env-health.mjs says the env is live. Live is not the same as
 * testable: a DotNS redeploy that drifts the ABI, an unfunded signer, or a wiped
 * S3 fixture each turn 10-45 legs red at once while the code is fine.
 *
 * Why a separate tool: probe-env-health.mjs is zero-dependency and build-free by
 * design (see its header, #1535). This needs dist/ (DotNS.connect() profile
 * detection, feeFloorFor, the balance readers), so select-env builds first.
 *
 * Read-only, every reader bounded by a timeout. Each check is one of
 *   ok | not-ready (with a reason carrying the values read) | unknown (RPC error).
 * unknown never marks an env not-ready: a probe glitch must not skip a night.
 *
 * Checks:
 *   profile  DotNS.connect()'s own live probe resolves to a profile this build knows.
 *   funding  tools/funding-verdict.mjs over the balances tools/funding-check.mjs gathers
 *            (check-balances SIGNERS). FAIL on a gating signer = not-ready. Bob is not
 *            gating: he owns the S3 fixture (no balance needed) and is only the second
 *            top-up source after Alice ROOT; no scenario signs a registration as Bob.
 *            His balance stays in the daily funding alarm.
 *   s3       ownerOf(S3_OWNED_LABEL.<tld>) equals Bob's H160 (the scenario's own precheck).
 * ipfs/kubo is deliberately absent: tooling is not an env property and the kubo
 * install steps already hard-fail.
 *
 * Usage: node tools/check-env-readiness.mjs --env <id> [--timeout-ms 120000]
 * Output: human lines, then ONE line `ENV_READINESS {json}`. Exit 0 whatever the
 * verdict (the caller reads the line); exit 2 only on bad usage.
 */

import { pathToFileURL } from "node:url";
import { evaluateEnv, DEFAULTS } from "./funding-verdict.mjs";
import { withTimeout } from "./funding-check.mjs";
import { S3_OWNED_LABEL, BOB_H160 } from "./lib/e2e-fixtures.mjs";

const REGISTRAR_OWNER_OF_ABI = [
  { inputs: [{ name: "tokenId", type: "uint256" }], name: "ownerOf", outputs: [{ name: "", type: "address" }], stateMutability: "view", type: "function" },
];

// Bob is read (so the daily alarm table is the same) but never gates readiness.
export const NON_GATING_LABELS = new Set(["Bob"]);
const SEVERITY = { PASS: 0, WARN: 1, ERROR: 2, FAIL: 3 };
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const fmtPas = (planck, f) => (planck === null || planck === undefined ? "n/a" : f(planck));

const ok = (detail) => ({ status: "ok", ...(detail ? { detail } : {}) });
const notReady = (reason) => ({ status: "not-ready", reason });
const unknown = (reason) => ({ status: "unknown", reason });
const msgOf = (e) => (e?.message ?? String(e)).slice(0, 200);

/** profile: { profile } from a successful connect, or { error } from a failed one. */
export function verdictProfile({ profile, error }, knownProfiles) {
  if (error) {
    const msg = msgOf(error);
    // The two throws of detectProtocolVersion: no code at POP_RULES (chain reset),
    // or neither ABI discriminator answered (a redeploy drifted the ABI).
    if (/Could not determine the DotNS ABI profile|No contract deployed at /i.test(msg)) return notReady(msg);
    return unknown(`DotNS connect failed: ${msg}`);
  }
  if (!knownProfiles.includes(profile)) return notReady(`ABI profile "${profile}" is not one this build knows (${knownProfiles.join(", ")})`);
  return ok(profile);
}

/**
 * funding: the output of funding-verdict's evaluateEnv. `fmt` formats plancks for the reason
 * (the deploy's own fmtPas). Gating = every row except NON_GATING_LABELS.
 */
export function verdictFunding(envResult, fmt = (n) => (Number(n) / 1e10).toFixed(4)) {
  const gating = envResult.results.filter((r) => !NON_GATING_LABELS.has(r.label));
  const failed = gating.filter((r) => r.verdict === "FAIL");
  if (failed.length > 0) {
    return notReady(failed.map((r) => `${r.label} has ${fmtPas(r.free, fmt)} PAS, below the ${fmtPas(r.floor, fmt)} PAS floor`).join("; "));
  }
  const unread = gating.filter((r) => r.verdict === "ERROR");
  if (unread.length > 0) return unknown(unread.map((r) => `${r.label}: ${r.note}`).join("; "));
  return ok();
}

/** s3: { owner } of the fixture token (null if unset), or { error } from the read. */
export function verdictS3({ owner, error, label, tld, expectedOwner }) {
  const name = `${label}.${tld}`;
  if (error) {
    const msg = msgOf(error);
    // ERC-721 ownerOf reverts for a token that was never minted: a wiped registry.
    if (/would revert/i.test(msg)) return notReady(`${name} is not registered (ownerOf reverted); expected owner ${expectedOwner}`);
    return unknown(`ownerOf read failed: ${msg}`);
  }
  if (owner === null || owner === undefined || owner.toLowerCase() === ZERO_ADDRESS) {
    return notReady(`${name} is not registered (no owner); expected owner ${expectedOwner}`);
  }
  if (owner.toLowerCase() !== expectedOwner.toLowerCase()) {
    return notReady(`${name} is owned by ${owner}, expected Bob ${expectedOwner}`);
  }
  return ok(`${name} owned by Bob`);
}

export function summarize(envId, checks) {
  const entries = Object.entries(checks);
  return {
    env: envId,
    ready: !entries.some(([, c]) => c.status === "not-ready"),
    checks,
    reasons: entries.filter(([, c]) => c.status === "not-ready").map(([check, c]) => ({ check, reason: c.reason })),
    unknown: entries.filter(([, c]) => c.status === "unknown").map(([check]) => check),
  };
}

export const formatSummaryLine = (summary) => `ENV_READINESS ${JSON.stringify(summary)}`;

/**
 * Run the three checks with injected readers:
 *   readers.profile() -> { profile } | { error }       (never needs to throw)
 *   readers.funding() -> evaluateEnv() result
 *   readers.s3owner() -> owner address | null          (throws on revert / transport error)
 * A reader that throws or hangs makes only that check unknown.
 */
export async function checkReadiness({ envId, tld, knownProfiles, readers, timeoutMs = 120_000, fmt }) {
  const run = async (name, fn, toVerdict, onError = (e) => unknown(`${name} read failed: ${msgOf(e)}`)) => {
    try { return toVerdict(await withTimeout(fn(), timeoutMs, `${name} read`)); } catch (e) { return onError(e); }
  };
  const s3Base = { label: S3_OWNED_LABEL, tld, expectedOwner: BOB_H160 };
  const [profile, funding, s3] = await Promise.all([
    run("profile", readers.profile, (r) => verdictProfile(r, knownProfiles)),
    run("funding", readers.funding, (r) => verdictFunding(r, fmt)),
    // A revert is a meaningful answer for ownerOf; a timeout or transport error is not (verdictS3 tells them apart).
    run("s3 owner", readers.s3owner, (owner) => verdictS3({ ...s3Base, owner }), (error) => verdictS3({ ...s3Base, error })),
  ]);
  return summarize(envId, { profile, funding, s3 });
}

function renderHuman(summary) {
  const lines = [`env ${summary.env}: ${summary.ready ? "READY" : "NOT READY"}`];
  for (const [name, c] of Object.entries(summary.checks)) {
    lines.push(`  ${name.padEnd(8)} ${c.status}${c.reason ? `: ${c.reason}` : c.detail ? ` (${c.detail})` : ""}`);
  }
  if (summary.unknown.length) lines.push(`  unknown (not gating): ${summary.unknown.join(", ")}`);
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  let envId = null;
  let timeoutMs = 120_000;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") envId = argv[++i];
    else if (argv[i] === "--timeout-ms") timeoutMs = parseInt(argv[++i], 10);
    else { console.error(`Unknown arg: ${argv[i]}`); process.exit(2); }
  }
  if (!envId) { console.error("usage: check-env-readiness.mjs --env <id> [--timeout-ms N]"); process.exit(2); }

  const { loadEnvironments, resolveEndpoints } = await import("../dist/environments.js");
  const { DotNS, DEFAULT_MNEMONIC, fmtPas: fmt, computeDomainTokenId } = await import("../dist/dotns.js");
  const { DOTNS_ABI_PROFILES } = await import("../dist/dotns-protocol.js");
  const { SIGNERS, deriveSigners } = await import("./check-balances.mjs");
  const { gatherEnv } = await import("./funding-check.mjs");

  const { doc } = await loadEnvironments();
  if (!doc.environments.some((e) => e.id === envId)) {
    console.error(`Unknown env "${envId}"`);
    process.exit(2);
  }
  const resolved = resolveEndpoints(doc, envId);

  // One DotNS connection serves the profile probe and the S3 read; a failed
  // connect is the profile verdict and leaves the S3 read unknown.
  let dotns = null;
  let connectError = null;
  const connected = (async () => {
    try {
      const d = new DotNS();
      await d.connect({
        mnemonic: DEFAULT_MNEMONIC,
        rpc: resolved.assetHub[0],
        assetHubEndpoints: resolved.assetHub,
        autoAccountMapping: resolved.autoAccountMapping,
        contracts: Object.keys(resolved.contracts).length > 0 ? resolved.contracts : undefined,
        nativeToEthRatio: resolved.nativeToEthRatio,
        tld: resolved.tld,
        environmentId: envId,
      });
      dotns = d;
    } catch (e) {
      connectError = e;
    }
  })();

  const readers = {
    profile: async () => {
      await connected;
      return connectError ? { error: connectError } : { profile: dotns.protocolVersion };
    },
    funding: async () => {
      const signers = await deriveSigners(SIGNERS, DEFAULT_MNEMONIC);
      return evaluateEnv(await gatherEnv(doc, envId, signers), DEFAULTS);
    },
    s3owner: async () => {
      await connected;
      if (connectError) throw new Error(`DotNS connect failed: ${msgOf(connectError)}`);
      return dotns.contractCallNullable(resolved.contracts.DOTNS_REGISTRAR, REGISTRAR_OWNER_OF_ABI, "ownerOf", [computeDomainTokenId(S3_OWNED_LABEL, resolved.tld)]);
    },
  };

  const summary = await checkReadiness({
    envId,
    tld: resolved.tld,
    knownProfiles: Object.keys(DOTNS_ABI_PROFILES),
    readers,
    timeoutMs,
    fmt,
  });
  try { dotns?.disconnect(); } catch { /* best effort */ }
  console.log(renderHuman(summary));
  console.log(formatSummaryLine(summary));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    // A crash is a probe glitch, never a verdict: say so and exit clean so select-env treats the env as ready.
    console.error(`readiness tool crashed (treated as unknown, env stays ready): ${msgOf(e)}`);
    process.exit(0);
  });
}
