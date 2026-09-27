import { test } from "node:test";
import assert from "node:assert/strict";
import { entropyToMnemonic, ss58Address } from "@polkadot-labs/hdkd-helpers";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/keyring";
import {
  deriveProductSigner,
  normalizeProductName,
  productChainCode,
  productIndexBytes,
} from "../dist/product-account.js";

// Ground truth is host-rust-core, the implementation every host runs. The
// vectors below are copied verbatim from its pinned tests, so a drift in our
// derivation fails here rather than at deploy time:
//   index_bytes(0) — host_logic/product_account.rs (index_bytes_matches_ios_vector)
//   entropy [0xAB;16] + "myapp.dot" + index 0 -> derived public key —
//   tests/wasm_crypto_vectors.rs (product_account_and_entropy_vectors_match_mobile)
const VECTOR_ENTROPY = new Uint8Array(16).fill(0xab);
const VECTOR_MNEMONIC = entropyToMnemonic(VECTOR_ENTROPY);
const VECTOR_PRODUCT = "myapp.dot";
const VECTOR_PUBLIC_KEY = "1c1ae478b564572f806ffa6352b4273d612beb01610b19f4e5bf444521cd5b5c";
const VECTOR_INDEX_BYTES = "0000000012e86013736c5498f050b03cdc16957dff0e422fb92ca77ec3ab168f";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

test("productIndexBytes(0) matches the host's pinned iOS vector", () => {
  assert.equal(hex(productIndexBytes(0)), VECTOR_INDEX_BYTES);
});

test("deriveProductSigner matches the host's pinned end-to-end vector", () => {
  const { publicKey, ss58 } = deriveProductSigner(VECTOR_MNEMONIC, VECTOR_PRODUCT, 0);
  assert.equal(hex(publicKey), VECTOR_PUBLIC_KEY);
  assert.equal(ss58, ss58Address(publicKey));
});

test("normalization matches the host: trim, NFC, lowercase", () => {
  assert.equal(normalizeProductName("  MyApp.DOT "), "myapp.dot");
  const upper = deriveProductSigner(VECTOR_MNEMONIC, "MyApp.DOT", 0);
  assert.equal(hex(upper.publicKey), VECTOR_PUBLIC_KEY);
});

test("string junction chain code is padded SCALE, not hashed, under 32 bytes", () => {
  const code = productChainCode("product");
  assert.equal(code.length, 32);
  // SCALE str: compact length (7 << 2 = 0x1c) then UTF-8, zero-padded.
  assert.equal(hex(code.slice(0, 8)), "1c70726f64756374");
  assert.equal(code.slice(8).every((b) => b === 0), true);
});

// The pjs keyring URI `//product//<name>/0x<index32>` must reach the same
// account: DotNS.connect derives through Keyring.addFromUri, and the
// host-api-test-sdk mock host accepts product accounts as keyring URIs, so
// this equivalence is what lets one MNEMONIC line up the deployer, the DotNS
// owner, and the in-product signer in an e2e.
test("keyring URI form derives the same account", async () => {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519" });
  const uri = `${VECTOR_MNEMONIC}//product//${VECTOR_PRODUCT}/0x${VECTOR_INDEX_BYTES}`;
  const account = keyring.addFromUri(uri);
  assert.equal(hex(account.publicKey), VECTOR_PUBLIC_KEY);
});
