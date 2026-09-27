/**
 * Product-account derivation, byte-matching the Polkadot Host.
 *
 * A host derives one account per product from the user's root key so a product
 * never sees a key that controls anything but its own subtree. Deploying with
 * `--product-name` makes the DEPLOYER that same account: the DotNS name ends up
 * owned by the account the product will later sign with inside a host, so
 * in-product writes (publishing, record edits) pass the registry's ownership
 * checks without a transfer step.
 *
 * The algorithm mirrors host-rust-core
 * `rust/crates/truapi-server/src/host_logic/product_account.rs` (RFC-0022):
 * path `//product//{productId}/{index32}` — two hard string junctions and one
 * soft junction whose 32-byte chain code is the little-endian u32 index
 * followed by a 28-byte magic. Junction chain codes SCALE-encode the string
 * (all-digit strings as u64), zero-padded to 32 bytes, blake2b-256-hashed only
 * when longer.
 *
 * The host also normalizes the product name (trim, NFC, lowercase) before
 * deriving. Its current TLD allowlist (`dot`, `paseo`, localhost) is NOT
 * enforced here: previewnet is mid-migration to a `.test` TLD and this CLI
 * must be able to deploy for products the allowlist will accept next; syntax
 * beyond normalization is the host's call, not the deployer's.
 */

import { blake2b } from "@noble/hashes/blake2b";
import {
  entropyToMiniSecret,
  mnemonicToEntropy,
  sr25519,
  sr25519Derive,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import type { PolkadotSigner } from "polkadot-api";

const PRODUCT_JUNCTION = "product";

// blake2b256("product-account-index")[..28], per product_account.rs INDEX_MAGIC.
const INDEX_MAGIC = blake2b(new TextEncoder().encode("product-account-index"), {
  dkLen: 32,
}).slice(0, 28);

/** SCALE compact length prefix for the string lengths a dotNS name can have. */
function scaleCompactLength(length: number): Uint8Array {
  if (length < 64) return Uint8Array.of(length << 2);
  if (length < 16384) {
    const value = (length << 2) | 0b01;
    return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
  }
  throw new Error(`Junction too long to SCALE-encode: ${length} bytes`);
}

/** SCALE-encode a junction string: all-digit strings as u64, others as str. */
function scaleEncodeJunction(code: string): Uint8Array {
  if (/^\d+$/.test(code)) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(code), true);
    return bytes;
  }
  const utf8 = new TextEncoder().encode(code);
  const prefix = scaleCompactLength(utf8.length);
  const encoded = new Uint8Array(prefix.length + utf8.length);
  encoded.set(prefix);
  encoded.set(utf8, prefix.length);
  return encoded;
}

/** A junction's 32-byte chain code: padded SCALE encoding, hashed when longer. */
export function productChainCode(code: string): Uint8Array {
  const encoded = scaleEncodeJunction(code);
  if (encoded.length > 32) return blake2b(encoded, { dkLen: 32 });
  const chainCode = new Uint8Array(32);
  chainCode.set(encoded);
  return chainCode;
}

/** The soft-junction chain code of a derivation index: LE u32 ++ INDEX_MAGIC. */
export function productIndexBytes(index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`Derivation index out of u32 range: ${index}`);
  }
  const bytes = new Uint8Array(32);
  new DataView(bytes.buffer).setUint32(0, index, true);
  bytes.set(INDEX_MAGIC, 4);
  return bytes;
}

/** Host-side normalization of a product name: trim, NFC, lowercase. */
export function normalizeProductName(raw: string): string {
  const name = raw.trim().normalize("NFC").toLowerCase();
  if (!name) throw new Error("Product name is empty");
  return name;
}

export interface ProductSigner {
  signer: PolkadotSigner;
  ss58: string;
  publicKey: Uint8Array;
  productName: string;
}

/**
 * The product account a host derives for `productName` under this mnemonic.
 *
 * Index 0 is a product's default account, the one `getProductAccount` hands a
 * product that asks with `DerivationIndex::Index(0)`.
 */
export function deriveProductSigner(
  mnemonic: string,
  productName: string,
  index: number = 0,
): ProductSigner {
  const name = normalizeProductName(productName);
  const miniSecret = entropyToMiniSecret(mnemonicToEntropy(mnemonic));
  const keyPair = sr25519Derive(miniSecret, sr25519, [
    ["hard", productChainCode(PRODUCT_JUNCTION)],
    ["hard", productChainCode(name)],
    ["soft", productIndexBytes(index)],
  ]);
  const signer = getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
  return { signer, ss58: ss58Address(keyPair.publicKey), publicKey: keyPair.publicKey, productName: name };
}
