#!/usr/bin/env node
/**
 * tools/check-balances.mjs
 *
 * Diagnostic: dump per-signer status for every signer the E2E pipeline uses,
 * on whichever environment you target with --env (default: paseo-next-v2).
 * Both chains are inspected in one run:
 *
 *   - The env's Asset Hub: free / reserved / usable PAS + nonce. PAS funds the
 *     DotNS contract fees that pool/S5/S6 legs sign with Alice ROOT and that
 *     direct legs sign with their //e2e-* sub-accounts.
 *
 *   - The env's Bulletin chain: authorization state (txs left, renew MB left)
 *     + nonce. Bulletin has no fee model; chunk uploads need an unexpired
 *     authorization, not a balance.
 *
 * Both endpoints are resolved from environments.json via --env; nothing is
 * hardcoded. Read-only and idempotent — safe to re-run anytime.
 *
 * Default signer set (substrate URIs):
 *   - Alice ROOT          — dev phrase, no derivation
 *                           (this is what polkadot-app-deploy actually uses for
 *                           DotNS by default; NOT the standard //Alice)
 *   - Bob                 — //Bob from dev phrase
 *   - //e2e-direct        — s1 direct shard
 *   - //e2e-fresh-pool    — s2 pool shard
 *   - //e2e-fresh-direct  — s2 direct shard
 *   - //deploy/0 .. //deploy/13 — the chunk-upload pool, gated by Bulletin
 *                                authorization quota. Asset Hub balance is
 *                                shown but doesn't matter operationally.
 *
 * Usage:
 *   node tools/check-balances.mjs
 *   node tools/check-balances.mjs --env preview
 *   node tools/check-balances.mjs --mnemonic "<custom seed>"
 *
 * The //e2e-* signers are funded out of band (upstream's
 * tools/setup-e2e-derivation-signers.mjs); this tool inspects the result.
 *
 * Importable: SIGNERS, deriveSigners and readAccounts are exported (no side
 * effects on import) so tools/funding-check.mjs (bulletin #1628) can run the verdict
 * layer over the same signer set. Each signer carries a role for that layer.
 */

import { pathToFileURL } from "node:url";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { loadEnvironments, resolveEndpoints, DEFAULT_ENV_ID } from "../dist/environments.js";
import { DEFAULT_MNEMONIC } from "../dist/dotns.js";
import { readAccountAuthorization, remainingRenewBytes, remainingTransactions } from "../dist/pool.js";

const PAS_DECIMALS = 10n;
const ONE_PAS = 10n ** PAS_DECIMALS;

// role feeds tools/funding-verdict.mjs: root = Alice ROOT, dotns = signs DotNS,
// pool = Bulletin-only chunk-upload account. //deploy/10..13 are the pool
// indexes e2e.yml pins beyond the original 0..9.
export const SIGNERS = [
  { label: "Alice ROOT",        path: "",                   role: "root"  },
  { label: "Bob",               path: "//Bob",              role: "dotns" },
  { label: "//e2e-direct",      path: "//e2e-direct",       role: "dotns" },
  { label: "//e2e-fresh-pool",  path: "//e2e-fresh-pool",   role: "dotns" },
  { label: "//e2e-fresh-direct", path: "//e2e-fresh-direct", role: "dotns" },
  ...Array.from({ length: 14 }, (_, i) => ({
    label: `//deploy/${i}`,
    path: `//deploy/${i}`,
    role: "pool",
  })),
];

/** Returns fresh signer objects with `address` filled in (never mutates SIGNERS). */
export async function deriveSigners(signers = SIGNERS, mnemonic = DEFAULT_MNEMONIC) {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  return signers.map((s) => ({ ...s, address: keyring.addFromUri(`${mnemonic}${s.path}`).address }));
}

/**
 * Read System.Account for each signer. Returns one entry per signer:
 * { ...signer, free, reserved, frozen, nonce } (bigints) or { ...signer, error }.
 */
export async function readAccounts(ws, signers) {
  const client = createClient(getWsProvider(ws));
  try {
    const api = client.getUnsafeApi();
    return await Promise.all(signers.map(async (s) => {
      try {
        const acc = await api.query.System.Account.getValue(s.address);
        return {
          ...s,
          free: BigInt(acc.data.free),
          reserved: BigInt(acc.data.reserved),
          frozen: BigInt(acc.data.frozen),
          nonce: acc.nonce,
        };
      } catch (e) {
        return { ...s, error: (e?.message ?? String(e)).slice(0, 60) };
      }
    }));
  } finally {
    client.destroy();
  }
}

function fmtPas(raw) {
  return (Number(raw) / Number(ONE_PAS)).toFixed(4).padStart(10);
}

function fmtMb(raw) {
  return (Number(raw) / 1_000_000).toFixed(1).padStart(10);
}

async function dumpFees(label, ws, signers) {
  console.log(`\n=== ${label} (${ws}) ===`);
  console.log(`${"signer".padEnd(20)}  ${"address".padEnd(48)}  ${"free".padStart(10)}  ${"reserved".padStart(10)}  ${"usable".padStart(10)}  ${"nonce".padStart(6)}`);
  console.log("-".repeat(116));
  for (const s of await readAccounts(ws, signers)) {
    if (s.error) {
      console.log(`${s.label.padEnd(20)}  ${s.address.padEnd(48)}  read failed: ${s.error}`);
      continue;
    }
    console.log(`${s.label.padEnd(20)}  ${s.address.padEnd(48)}  ${fmtPas(s.free)}  ${fmtPas(s.reserved)}  ${fmtPas(s.free - s.frozen)}  ${String(s.nonce).padStart(6)}`);
  }
}

// Bulletin has no fee model — `store` is gated only by an unexpired authorization
// (never by a byte count), read via BulletinTransactionStorageApi. So the columns
// are advisory: "txs left" is the priority-boost headroom and "renew MB" is the one
// hard byte cap (renew). Dumped with the nonce so an operator can see at a glance
// which pool accounts are still usable.
async function dumpBulletinAuth(label, ws, signers) {
  console.log(`\n=== ${label} (${ws}) ===`);
  const client = createClient(getWsProvider(ws));
  const api = client.getUnsafeApi();
  console.log(`${"signer".padEnd(20)}  ${"address".padEnd(48)}  ${"txs left".padStart(10)}  ${"renew MB".padStart(10)}  ${"nonce".padStart(6)}`);
  console.log("-".repeat(104));
  for (const s of signers) {
    try {
      const [auth, acc] = await Promise.all([
        readAccountAuthorization(api, s.address),
        api.query.System.Account.getValue(s.address),
      ]);
      const txs = auth ? remainingTransactions(auth) : 0n;
      const renewBytes = auth ? remainingRenewBytes(auth) : 0n;
      console.log(`${s.label.padEnd(20)}  ${s.address.padEnd(48)}  ${String(txs).padStart(10)}  ${fmtMb(renewBytes)}  ${String(acc.nonce).padStart(6)}`);
    } catch (e) {
      console.log(`${s.label.padEnd(20)}  ${s.address.padEnd(48)}  read failed: ${(e?.message ?? String(e)).slice(0, 60)}`);
    }
  }
  client.destroy();
}

async function main() {
  const args = process.argv.slice(2);
  let envId = DEFAULT_ENV_ID;
  let mnemonic = DEFAULT_MNEMONIC;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env") envId = args[++i];
    else if (args[i] === "--mnemonic") mnemonic = args[++i];
    else if (args[i] === "-h" || args[i] === "--help") {
      console.log('Usage: node tools/check-balances.mjs [--env <id>] [--mnemonic "<seed>"]');
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${args[i]}`);
      process.exit(2);
    }
  }

  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, envId);
  const rpc = resolved.assetHub[0];
  const bulletinRpc = resolved.bulletin[0];

  console.log(`Environment:   ${envId}`);
  console.log(`Asset Hub RPC: ${rpc}`);
  console.log(`Bulletin RPC:  ${bulletinRpc}`);

  const signers = await deriveSigners(SIGNERS, mnemonic);
  await dumpFees("DotNS / fee chain", rpc, signers);
  await dumpBulletinAuth("Bulletin chain (authorization state)", bulletinRpc, signers);

  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
