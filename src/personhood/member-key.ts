// Derives the bandersnatch member key from a BIP39 mnemonic.
// The derivation: bip39Entropy → blake2b256_keyed(entropy, "candidate") → verifiablejs.member_from_entropy

import { mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — verifiablejs/nodejs DTS path differs from the types field
import * as verifiable from "verifiablejs/nodejs";
import { blake2b256Keyed } from "./hashing.js";
import { MEMBER_ENTROPY_KEY } from "./constants.js";

/**
 * Derive the 32-byte keyed entropy used as input to verifiablejs.
 * Deterministic: same mnemonic always produces the same output.
 */
export function deriveMemberEntropy(mnemonic: string): Uint8Array {
  const normalized = mnemonic.trim().split(/\s+/).join(" ");
  const bip39Entropy = mnemonicToEntropy(normalized);
  return blake2b256Keyed(bip39Entropy, MEMBER_ENTROPY_KEY);
}

/**
 * Derive the 32-byte bandersnatch member public key from a BIP39 mnemonic.
 * This is the key stored in People.Members.Members.
 */
export function deriveMemberKey(mnemonic: string): Uint8Array {
  const entropy = deriveMemberEntropy(mnemonic);
  return verifiable.member_from_entropy(entropy);
}
