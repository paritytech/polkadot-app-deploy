#!/usr/bin/env node
// provision-e2e-direct-signers.mjs [--env paseo-next-v2]
//
// One-time provisioning for the twin's per-scenario ISOLATED_DIRECT_SIGNERS
// (//e2e-s9, //e2e-sgrandpa) — a twin-only concurrency isolation that bulletin
// doesn't have, so bulletin's provisioning never covered them. Each needs:
//   (1) Bulletin TransactionStorage authorization (storage quota), signed by //Alice
//   (2) Asset Hub PAS >= register floor (~200 PAS) to register its fresh DotNS label,
//       topped up from Alice ROOT (dev phrase, no derivation).
// Idempotent + read-first: skips whatever is already authorized/funded.
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { createClient, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { getPolkadotSigner } from "polkadot-api/signer";
import { loadEnvironments, resolveEndpoints } from "@parity/polkadot-app-deploy";
const mkSigner = (kp) => getPolkadotSigner(kp.publicKey, "Sr25519", (d) => kp.sign(d));

const DEV = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";
const PATHS = ["//e2e-s9", "//e2e-sgrandpa", "//e2e-direct"];
const TXS = 1000, BYTES = 100_000_000n;
const ONE_PAS = 10_000_000_000n;               // 10 decimals
const FLOOR = 200n * ONE_PAS, TARGET = 220n * ONE_PAS;

const args = process.argv.slice(2);
let envId = "paseo-next-v2";
for (let i = 0; i < args.length; i++) if (args[i] === "--env") envId = args[++i];

await cryptoWaitReady();
const kr = new Keyring({ type: "sr25519" });
const alice = kr.addFromUri("//Alice");                 // Bulletin authorizer (testnet)
const funder = kr.addFromUri(DEV);                       // Asset Hub funder = dev root (5DfhGyQ…)
const signers = PATHS.map(p => ({ path: p, kp: kr.addFromUri(DEV + p) }));

const { doc } = await loadEnvironments();
const resolved = resolveEndpoints(doc, envId);
const bulletinRpc = Array.isArray(resolved.bulletin) ? resolved.bulletin[0] : resolved.bulletin;
const ahRpc = Array.isArray(resolved.assetHub) ? resolved.assetHub[0] : resolved.assetHub;
console.log(`env=${envId}\n  Bulletin=${bulletinRpc}\n  AssetHub=${ahRpc}`);
for (const s of signers) console.log(`  ${s.path} => ${s.kp.address}`);

// --- 1. Bulletin authorization ---
console.log("\n== Bulletin authorization ==");
{
  const c = createClient(getWsProvider(bulletinRpc, { heartbeatTimeout: 300000 }));
  const api = c.getUnsafeApi();
  const now = Number(await api.query.System.Number.getValue());
  for (const s of signers) {
    const auth = await api.query.TransactionStorage.Authorizations.getValue(Enum("Account", s.kp.address));
    if (auth && Number(auth.expiration ?? 0) > now) { console.log(`  [ok]   ${s.path} already authorized (exp @${auth.expiration})`); continue; }
    try {
      const r = await api.tx.TransactionStorage.authorize_account({ who: s.kp.address, transactions: TXS, bytes: BYTES })
        .signAndSubmit(mkSigner(alice));
      console.log(`  [auth] ${s.path} authorized ok=${r?.ok}`);
    } catch (e) { console.log(`  [FAIL] ${s.path} authorize: ${(e?.message ?? e).toString().slice(0, 140)}`); }
  }
  c.destroy();
}

// --- 2. Asset Hub funding ---
console.log("\n== Asset Hub funding (from Alice ROOT) ==");
{
  const c = createClient(getWsProvider(ahRpc, { heartbeatTimeout: 300000 }));
  const api = c.getUnsafeApi();
  for (const s of signers) {
    const info = await api.query.System.Account.getValue(s.kp.address);
    const free = BigInt(info?.data?.free ?? 0n);
    if (free >= FLOOR) { console.log(`  [ok]   ${s.path} ${(Number(free)/1e10).toFixed(1)} PAS (>= floor)`); continue; }
    const topUp = TARGET - free;
    try {
      const r = await api.tx.Balances.transfer_allow_death({ dest: Enum("Id", s.kp.address), value: topUp })
        .signAndSubmit(mkSigner(funder));
      console.log(`  [fund] ${s.path} +${(Number(topUp)/1e10).toFixed(1)} PAS ok=${r?.ok}`);
    } catch (e) { console.log(`  [FAIL] ${s.path} fund: ${(e?.message ?? e).toString().slice(0, 140)}`); }
  }
  c.destroy();
}
console.log("\ndone.");
