// Chain probe for chunk presence via TransactionStorage.TransactionByContentHash.
//
// Phase 0 verified: pallet exists, Blake2128Concat hasher confirmed, manual u32 LE decode
// (getDynamicBuilder value decoder fails on this runtime — value.asBytes is not a function).
//
// Spec: docs-internal/superpowers/specs/2026-05-09-chain-probe-design.md

import { Twox128, Blake2128Concat, decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { getLookupFn, getDynamicBuilder } from "@polkadot-api/metadata-builders";
import { CID } from "multiformats/cid";
import { captureWarning } from "./telemetry.js";

export type ChunkProbeFailureReason = "rpc_error" | "decode_error" | "metadata_error";

export type ChunkProbeResult =
  | { cid: string; present: false }
  | { cid: string; present: true; block: number; index: number }
  | { cid: string; present: null; failureReason: ChunkProbeFailureReason };

export interface ChainProbeOptions {
  client: any;
  batchSize?: number;
  atFinalized?: boolean;
}

export class ChainProbeMetadataError extends Error {
  constructor(msg: string) { super(msg); this.name = "ChainProbeMetadataError"; }
}

export class ChainProbeCrossValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = "ChainProbeCrossValidationError"; }
}

const _enc = new TextEncoder();
const MAX_BLOCK = 2 ** 30;
const MAX_TX_INDEX = 512;
const DEFAULT_BATCH_SIZE = 500;

// Session-level caches — reset between tests via _resetProbeSession().
let _metadataChecked = false;
let _crossValidated = false;
let _sentryBatchCount = 0;

function buildStorageKey(contentHashBytes: Uint8Array): string {
  const parts: Uint8Array[] = [
    Twox128(_enc.encode("TransactionStorage")),
    Twox128(_enc.encode("TransactionByContentHash")),
    Blake2128Concat(contentHashBytes),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const key = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { key.set(p, offset); offset += p.length; }
  return "0x" + Buffer.from(key).toString("hex");
}

function cidToContentHash(cidStr: string): Uint8Array {
  return CID.parse(cidStr).multihash.digest;
}

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/** Exported for unit testing. */
export function _decodeStorageValue(hex: string | null | undefined): { block: number; index: number } | null {
  if (!hex || hex === "0x" || hex === "0x00") return null;
  const bytes = hexToBytes(hex);
  if (bytes.length < 8) return null;
  const block = bytes.readUInt32LE(0);
  const index = bytes.readUInt32LE(4);
  // Defence #2: range assertions.
  if (block <= 0 || block >= MAX_BLOCK || index >= MAX_TX_INDEX) return null;
  return { block, index };
}

async function ensureMetadataChecked(client: any): Promise<void> {
  if (_metadataChecked) return;

  const metaHex: string = await client._request("state_getMetadata", []);
  const decoded = decAnyMetadata(hexToBytes(metaHex));
  const unified = unifyMetadata(decoded);

  const pallet = (unified as any).pallets?.find((p: any) => p.name === "TransactionStorage");
  if (!pallet) throw new ChainProbeMetadataError("TransactionStorage pallet not found in runtime metadata");

  const item = pallet.storage?.items?.find((e: any) => e.name === "TransactionByContentHash");
  if (!item) throw new ChainProbeMetadataError("TransactionByContentHash entry not found in TransactionStorage");

  if (item.type?.tag !== "map") {
    throw new ChainProbeMetadataError(
      `TransactionByContentHash storage type is '${item.type?.tag}', expected 'map'`
    );
  }

  const hasher = item.type.value?.hashers?.[0]?.tag;
  if (hasher !== "Blake2128Concat") {
    throw new ChainProbeMetadataError(
      `TransactionByContentHash key hasher is '${hasher}', expected 'Blake2128Concat'. ` +
      `Update key construction in chunk-probe.ts.`
    );
  }

  _metadataChecked = true;
}

async function crossValidateFirstHit(
  client: any,
  cid: string,
  block: number,
  index: number,
  contentHashBytes: Uint8Array
): Promise<void> {
  if (_crossValidated) return;
  _crossValidated = true;

  try {
    // Build key for Transactions[block_number].
    // Transactions uses Blake2128Concat on BlockNumber (u32 LE).
    const blockBuf = Buffer.alloc(4);
    blockBuf.writeUInt32LE(block, 0);
    const txKey = "0x" + Buffer.from([
      ...Twox128(_enc.encode("TransactionStorage")),
      ...Twox128(_enc.encode("Transactions")),
      ...Blake2128Concat(blockBuf),
    ]).toString("hex");

    const result = await client._request("state_queryStorageAt", [[txKey]]);
    const hex: string | null = result[0]?.changes?.[0]?.[1];
    if (!hex) {
      // Can't validate — Transactions map may have a different key encoding.
      captureWarning("chunk-probe cross-validate: Transactions[block] absent (non-fatal)", { cid, block, index });
      return;
    }
    // Check the raw bytes contain our content hash as a subsequence.
    const haystack = hexToBytes(hex);
    const needle = Buffer.from(contentHashBytes);
    if (!haystack.includes(needle)) {
      throw new ChainProbeCrossValidationError(
        `Cross-validation failed: content hash for CID ${cid} not found in Transactions[${block}]. ` +
        `Key construction may be wrong. Run tools/chain-probe-key-probe.mjs to diagnose.`
      );
    }
  } catch (e) {
    if (e instanceof ChainProbeCrossValidationError) throw e;
    captureWarning("chunk-probe cross-validate RPC error (non-fatal)", { cid, error: String(e).slice(0, 200) });
  }
}

export async function probeChunks(cids: string[], options: ChainProbeOptions): Promise<ChunkProbeResult[]> {
  if (cids.length === 0) return [];

  const { client, batchSize = DEFAULT_BATCH_SIZE, atFinalized } = options;

  try {
    await ensureMetadataChecked(client);
  } catch (e) {
    if (e instanceof ChainProbeMetadataError) throw e;
    return cids.map((cid) => ({ cid, present: null as null, failureReason: "metadata_error" as const }));
  }

  let atHash: string | undefined;
  if (atFinalized) {
    try {
      atHash = await client._request("chain_getFinalizedHead", []);
    } catch (e) {
      captureWarning("chunk-probe: chain_getFinalizedHead failed, probing best-chain", { error: String(e).slice(0, 200) });
    }
  }

  const results: ChunkProbeResult[] = new Array(cids.length);

  for (let start = 0; start < cids.length; start += batchSize) {
    const batchCids = cids.slice(start, start + batchSize);
    const batchDigests = batchCids.map(cidToContentHash);
    const batchKeys = batchDigests.map(buildStorageKey);

    let changes: [string, string | null][];
    try {
      const rpcResult = await client._request("state_queryStorageAt", atHash ? [batchKeys, atHash] : [batchKeys]);
      changes = rpcResult[0]?.changes ?? [];
    } catch {
      for (let i = 0; i < batchCids.length; i++) {
        results[start + i] = { cid: batchCids[i], present: null, failureReason: "rpc_error" };
      }
      continue;
    }

    const keyToValue = new Map<string, string | null>(changes);

    for (let i = 0; i < batchCids.length; i++) {
      const cid = batchCids[i];
      const key = batchKeys[i];
      const rawValue = keyToValue.get(key) ?? null;

      if (!rawValue) {
        results[start + i] = { cid, present: false };
        continue;
      }

      const decoded = _decodeStorageValue(rawValue);
      if (!decoded) {
        if (_sentryBatchCount < 3) {
          captureWarning("chunk-probe decode failed (out-of-range or short value)", {
            cid,
            raw_hex: rawValue.slice(0, 64),
          });
        }
        results[start + i] = { cid, present: null, failureReason: "decode_error" };
        continue;
      }

      results[start + i] = { cid, present: true, block: decoded.block, index: decoded.index };

      if (!_crossValidated) {
        await crossValidateFirstHit(client, cid, decoded.block, decoded.index, batchDigests[i]);
      }
    }

    if (_sentryBatchCount < 3) _sentryBatchCount++;
  }

  return results;
}

/** Reset session-level caches. Used in tests only. */
export function _resetProbeSession(): void {
  _metadataChecked = false;
  _crossValidated = false;
  _sentryBatchCount = 0;
}

/** Pre-set metadataChecked so tests don't need a real metadata RPC mock. Used in tests only. */
export function _bypassMetadataCheckForTest(): void {
  _metadataChecked = true;
}
