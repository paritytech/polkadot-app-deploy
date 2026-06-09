// Shared constants for the personhood binding / bootstrap flow.

import { Binary } from "polkadot-api";

// The 32-byte context used for DotNS alias bindings ("dotns" zero-padded).
export const DOTNS_CONTEXT_HEX =
  "0x646f746e73000000000000000000000000000000000000000000000000000000";

export const DOTNS_CONTEXT_BYTES: Uint8Array = Binary.fromHex(DOTNS_CONTEXT_HEX);

// PGAS fungible asset ID on Asset Hub.
export const PGAS_ASSET_ID = 2_000_000_000;

// XCM location for PGAS — used as `asset_id` in ChargeAssetTxPayment.
export const PGAS_ASSET_LOCATION = {
  parents: 0 as const,
  interior: {
    type: "X2" as const,
    value: [
      { type: "PalletInstance" as const, value: 50 },
      { type: "GeneralIndex" as const, value: BigInt(PGAS_ASSET_ID) },
    ] as const,
  },
};

// Ring-VRF proof size in bytes (verifiablejs 1.3.0-beta.4, small-ring, exponent 9).
// beta.2 was 788 (SCALE-prefixed); beta.4 is 785 (raw canonical bytes, no prefix).
export const PROOF_BYTES = 785;

// Bandersnatch signature size in bytes (returned by verifiablejs.sign).
// beta.2 was 96; beta.4 uses ThinVRF which is 64 bytes.
export const BANDERSNATCH_SIGNATURE_BYTES = 64;

// 32-byte member identifier for the "people" collection on People chain.
// "pop:polkadot.network/people" (27 bytes) + 5 spaces (0x20) = 32 bytes.
// Updated May 2026: old value was "people" + 26 spaces, which is broken on current runtimes.
export const PEOPLE_MEMBER_IDENTIFIER_HEX =
  "0x706f703a706f6c6b61646f742e6e6574776f726b2f70656f706c652020202020";

// HMAC key for deriving the bandersnatch member entropy from BIP39 entropy.
export const MEMBER_ENTROPY_KEY = new TextEncoder().encode("candidate");

// Tag prepended to the proof message for AliasAccounts proofs (alias-accounts pallet, individuality#955).
// 14 raw bytes, no length prefix — fixed-size array in the on-chain SCALE layout.
// Old name was PAID_PROOF_TAG ("alias-accounts:paid", 19 bytes) — renamed as part of the
// AliasAccounts pallet rewrite that replaced PaidAliasFee + set_paid_alias_account with
// a single AliasFee + set_alias_account (§3 of the dotns-bootstrap handover doc).
export const ALIAS_PROOF_TAG = new TextEncoder().encode("alias-accounts"); // 14 bytes
