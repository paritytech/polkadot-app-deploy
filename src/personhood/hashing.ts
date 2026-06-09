// Blake2b hashing helpers used across the personhood binding flow.
// Ported from the citizenship monorepo (hashing.ts).

import { blake2b } from "@noble/hashes/blake2b";
import { Binary } from "polkadot-api";

const hexToBytes = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export function blake2b256(data: Uint8Array | string): Uint8Array {
  let payload: Uint8Array;
  if (typeof data === "string") {
    if (data.startsWith("0x")) {
      payload = hexToBytes(data);
    } else {
      payload = Binary.fromText(data);
    }
  } else {
    // If Uint8Array encodes a hex string (starts with "0x" in ASCII)
    // 0x30 = '0', 0x78 = 'x'
    if (data[0] === 0x30 && data[1] === 0x78) {
      const hexString = new TextDecoder().decode(data);
      payload = hexToBytes(hexString);
    } else {
      payload = data;
    }
  }
  return blake2b(payload, { dkLen: 32 });
}

export function blake2b256Keyed(
  data: Uint8Array,
  key: Uint8Array,
): Uint8Array {
  return blake2b(data, { key, dkLen: 32 });
}
