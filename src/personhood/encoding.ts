// Encoding utilities for V5 General extrinsics and ring-VRF proofs.
// Ported from the citizenship monorepo (pb-encoding.ts). Self-contained:
// only deps are @noble/hashes, @polkadot-api/substrate-bindings, polkadot-api.

import { blake2b } from "@noble/hashes/blake2b";

export type ExtensionValues = {
  /** Pipeline-ordered identifiers from `metadata.extrinsic.signedExtensions`. */
  order: string[];
  /** Per-identifier explicit + implicit bytes as papi computed them. */
  byIdentifier: Record<
    string,
    { value: Uint8Array; additionalSigned: Uint8Array }
  >;
};

export const concatBytes = (...arrays: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

/** SCALE compact-encode a non-negative integer (length-prefix use only). */
export const compactEncode = (n: number): Uint8Array => {
  if (n < 0) throw new Error("compactEncode: negative");
  if (n < 64) return new Uint8Array([n << 2]);
  if (n < 16384) {
    const v = (n << 2) | 0b01;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  }
  if (n < 1073741824) {
    const v = (n << 2) | 0b10;
    return new Uint8Array([
      v & 0xff,
      (v >> 8) & 0xff,
      (v >> 16) & 0xff,
      (v >>> 24) & 0xff,
    ]);
  }
  throw new Error("compactEncode: value too large for inline path");
};

export const blake2_256 = (data: Uint8Array): Uint8Array =>
  blake2b(data, { dkLen: 32 });

/**
 * Build the bytes the runtime hashes for `AsPersonalIdentityWithProof`.
 *
 * msg = blake2_256( encode((0u8, &call), &rest_ext, &rest_ext.implicit()) )
 *
 * The leading `0u8` is the extension-version byte that prefixes V5 General
 * transactions (always `0` for the current extension scheme).
 */
export const buildImplicationMessage = (
  callBytes: Uint8Array,
  extensions: ExtensionValues,
  excludeIdentifiers: string | Set<string>,
): Uint8Array => {
  const exclude =
    typeof excludeIdentifiers === "string"
      ? new Set([excludeIdentifiers])
      : excludeIdentifiers;
  const restExplicit: Uint8Array[] = [];
  const restImplicit: Uint8Array[] = [];
  for (const id of extensions.order) {
    if (exclude.has(id)) continue;
    const ext = extensions.byIdentifier[id];
    if (!ext) throw new Error(`buildImplication: missing extension '${id}'`);
    restExplicit.push(ext.value);
    restImplicit.push(ext.additionalSigned);
  }
  const implication = concatBytes(
    new Uint8Array([0]),
    callBytes,
    ...restExplicit,
    ...restImplicit,
  );
  return blake2_256(implication);
};

/**
 * Build the V5 General extrinsic wire bytes:
 *
 *   compactLen( 0x45 || 0x00 (ext_version) || concat(all_explicit) || callBytes )
 *
 * `0x45` = version 5 + type General (`5 + (1 << 6)`).
 */
export const buildV5GeneralExtrinsic = (
  callBytes: Uint8Array,
  extensions: ExtensionValues,
): Uint8Array => {
  const explicit = extensions.order.map((id) => {
    const ext = extensions.byIdentifier[id];
    if (!ext) throw new Error(`buildV5General: missing extension '${id}'`);
    return ext.value;
  });
  const body = concatBytes(
    new Uint8Array([0x45]),
    new Uint8Array([0x00]),
    ...explicit,
    callBytes,
  );
  return concatBytes(compactEncode(body.length), body);
};

export const toHex = (bytes: Uint8Array): `0x${string}` => {
  let hex = "0x";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
};

/**
 * Convert a hex string (with or without 0x prefix) to Uint8Array. Buffer.from
 * stops at the first non-hex character and drops an odd trailing nibble, so
 * validate first: a silently shortened proof context reaches the chain as a bad
 * proof instead of failing here.
 */
export const hexToBytes = (hex: string): Uint8Array => {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
    throw new Error(`not a hex string: ${hex.length > 48 ? hex.slice(0, 48) + "..." : hex}`);
  }
  return new Uint8Array(Buffer.from(body, "hex"));
};

/** Convert Uint8Array to a lowercase 0x-prefixed hex string. */
export const bytesToHex = (b: Uint8Array): string =>
  "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Parse the chain metadata (passed to `signer.signTx`) and return the
 * pipeline-ordered list of signed-extension identifiers. Handles V14/V15
 * (flat array) and V16 (nested under `[0]`).
 */
export const readExtensionOrder = async (
  metadata: Uint8Array,
): Promise<string[]> => {
  const { decAnyMetadata, unifyMetadata } = await import(
    "@polkadot-api/substrate-bindings"
  );
  const meta = unifyMetadata(decAnyMetadata(metadata));
  const raw = meta.extrinsic.signedExtensions as unknown;
  let list: Array<{ identifier: string }> | null = null;
  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
    list = raw[0] as Array<{ identifier: string }>;
  } else if (Array.isArray(raw)) {
    list = raw as Array<{ identifier: string }>;
  } else if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { 0?: unknown })[0])
  ) {
    list = (raw as { 0: Array<{ identifier: string }> })[0];
  }
  if (!list || list.length === 0) {
    throw new Error("metadata has no signed extensions");
  }
  return list.map((entry) => entry.identifier);
};

/**
 * SCALE-encode `Vec<[u8; 32]>` — the shape that `verifiablejs.one_shot(...)`
 * decodes as the ring members list. Each input must be exactly 32 bytes.
 * Encoded as: compact(len) || member[0] || member[1] || ...
 */
export const encodeMembers = (members: Uint8Array[]): Uint8Array => {
  for (const m of members) {
    if (m.length !== 32) throw new Error("member key must be 32 bytes");
  }
  return concatBytes(compactEncode(members.length), ...members);
};

type PayloadExtension = { id: string; extra: string; additionalSigned: string };

/**
 * Index a papi v3 payload's extension array against the pipeline order. A
 * duplicate id keeps the first entry, which is what papi's own reader does
 * (raw-tx-creator's getExtensionData uses `find`), so the extrinsic body and the
 * signed payload stay in agreement.
 */
export const indexExtensions = (
  order: string[],
  extensions: PayloadExtension[],
): ExtensionValues => {
  const byIdentifier: ExtensionValues["byIdentifier"] = {};
  for (const ext of extensions) {
    if (ext.id in byIdentifier) continue;
    byIdentifier[ext.id] = {
      value: hexToBytes(ext.extra),
      additionalSigned: hexToBytes(ext.additionalSigned),
    };
  }
  const missing = order.filter((id) => !(id in byIdentifier));
  if (missing.length > 0) {
    throw new Error(`papi did not produce signed extension(s): ${missing.join(", ")}`);
  }
  return { order, byIdentifier };
};

/**
 * Resolved extension bytes from a papi v3 `TxPayloadV1`. The payload's own array
 * order is undefined, so the pipeline order still comes from metadata.
 */
let orderCache: { key: string; order: string[] } | null = null;

export const extensionValuesFromPayload = async (payload: {
  context: { metadata: string };
  extensions: PayloadExtension[];
}): Promise<ExtensionValues> => {
  // Decoding the runtime metadata is the expensive part and each flow captures
  // twice against the same chain, so keep the last decode.
  // Key on a digest, not the hex itself: the metadata runs to megabytes and the
  // cache would otherwise hold it for the life of the process.
  const key = toHex(blake2b(new TextEncoder().encode(payload.context.metadata), { dkLen: 16 }));
  if (orderCache?.key !== key) {
    orderCache = { key, order: await readExtensionOrder(hexToBytes(payload.context.metadata)) };
  }
  return indexExtensions(orderCache.order, payload.extensions);
};
