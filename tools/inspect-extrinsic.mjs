#!/usr/bin/env node
// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0
//
// inspect-extrinsic — look up a SUBSTRATE extrinsic on Asset Hub (paseo-next-v2)
// by hash (or block number), confirm it's finalized, and decode its events to
// show the value moved (Balances transfers, Revive contract activity, fees).
//
// Why this exists: DotNS register/commit/setContenthash are substrate-origin
// Revive.call extrinsics — INVISIBLE to the EVM indexers (eth-rpc, Blockscout)
// and to EVM block scans. paseo-next has no Subscan. The deploy's "Tx: 0x…"
// lines are substrate extrinsic hashes = blake2_256 of the full extrinsic
// INCLUDING its compact length prefix (calibrated against a known register).
// papi's chainHead helpers only serve PINNED blocks, so they can't read a
// block from minutes ago — but the legacy/archive RPC can, and papi's
// `query.System.Events.getValue({ at })` decodes events at any recent finalized block.
//
// Usage (sandbox OFF — touches the Asset Hub RPC):
//   node tools/inspect-extrinsic.mjs --hash 0x<extrinsicHash> [--block N] [--scan 1500]
//   node tools/inspect-extrinsic.mjs --block 736884            (dump a whole block)
//
// --block pins the search to one block (instant). --hash without --block scans
// back from the finalized head (default 1500 ≈ ~75 min) until it matches.
import { createClient as createRaw } from "@polkadot-api/substrate-client";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { blake2b } from "@noble/hashes/blake2b";
import { decodeAddress } from "@polkadot/util-crypto";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const TX = (flag("--hash") || "").toLowerCase();
const BLOCK = flag("--block") ? parseInt(flag("--block"), 10) : undefined;
const SCAN = parseInt(flag("--scan") || "1500", 10);
const URL = flag("--rpc") || "wss://paseo-asset-hub-next-rpc.polkadot.io";
if (!TX && BLOCK === undefined) { console.error("usage: node tools/inspect-extrinsic.mjs --hash 0x<64hex> [--block N] [--scan 1500]  |  --block N"); process.exit(1); }

const h2 = (u) => "0x" + Buffer.from(blake2b(u, { dkLen: 32 })).toString("hex");
const toU8 = (hex) => Uint8Array.from(hex.slice(2).match(/../g).map((b) => parseInt(b, 16)));
const extHash = (hex) => h2(toU8(hex)); // raw: blake2_256 of full extrinsic incl. length prefix
const addrHex = (a) => { try { return "0x" + Buffer.from(decodeAddress(a)).toString("hex"); } catch { return String(a); } };
const PAS = (a) => `${(Number(a) / 1e10).toFixed(4)} PAS`;

const raw = createRaw(getWsProvider(URL));
const client = createClient(getWsProvider(URL));
const api = client.getUnsafeApi();
const rpc = (m, p = []) => raw.request(m, p);

const finNum = parseInt((await rpc("chain_getHeader", [await rpc("chain_getFinalizedHead")])).number, 16);

let blockNum = BLOCK, blockHash, idx = -1;
if (BLOCK !== undefined) {
  blockHash = await rpc("chain_getBlockHash", [BLOCK]);
  if (TX) idx = (await rpc("chain_getBlock", [blockHash])).block.extrinsics.findIndex((e) => extHash(e) === TX);
} else {
  for (let n = finNum; n > finNum - SCAN && n >= 0; n--) {
    const h = await rpc("chain_getBlockHash", [n]);
    const exts = (await rpc("chain_getBlock", [h])).block.extrinsics;
    const i = exts.findIndex((e) => extHash(e) === TX);
    if (i >= 0) { blockNum = n; blockHash = h; idx = i; break; }
  }
  if (idx < 0) { console.log(`extrinsic ${TX} not found in last ${SCAN} finalized blocks (head #${finNum}).`); raw.destroy(); client.destroy(); process.exit(0); }
}

console.log(`block #${blockNum}  ${blockHash}`);
console.log(`finalized: ${blockNum <= finNum ? `yes (#${blockNum} <= finalized #${finNum})` : "NO — best-chain only"}`);
if (TX) console.log(`extrinsic ${TX}: index ${idx}${idx < 0 ? " (NOT FOUND in this block)" : ""}`);

const evs = await api.query.System.Events.getValue({ at: blockHash });
const sel = TX ? evs.filter((e) => e.phase?.type === "ApplyExtrinsic" && e.phase?.value === idx) : evs;
console.log(`\nevents (${sel.length}${TX ? ` for extrinsic #${idx}` : " in block"}):`);
for (const e of sel) {
  const pal = e.event.type, name = e.event.value.type, v = e.event.value.value;
  let extra = "";
  if (pal === "Balances" && v && typeof v === "object") {
    const amt = v.amount ?? v.value;
    if (amt !== undefined) extra = `  ${amt} = ${PAS(amt)}` + (v.from ? `  from=${addrHex(v.from).slice(0, 42)}` : "") + (v.who ? `  who=${addrHex(v.who).slice(0, 42)}` : "") + (v.to ? `  to=${addrHex(v.to).slice(0, 42)}` : "");
  }
  console.log(`  ${pal}.${name}${extra}`);
}
raw.destroy(); client.destroy();
