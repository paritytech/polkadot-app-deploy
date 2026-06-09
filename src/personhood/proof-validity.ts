// Proof-validity helpers for AliasAccounts (individuality#955, May 2026).
//
// Background: The AliasAccounts pallet rewrite added a `proof_valid_at: u64`
// parameter to both `set_alias_account` and `reprove_alias_account`. The chain
// enforces:
//
//   proof_valid_at <= now_secs  AND  now_secs <= proof_valid_at + ProofValidityWindow
//
// where ProofValidityWindow = 300 seconds on Asset Hub (nextv2-ah runtime).
//
// IMPORTANT: Submit the transaction promptly after calling getProofValidAtSec().
// If you build the proof and sit on it for more than 5 minutes (300s), the chain
// will reject with TimeOutOfRange. Do not cache the return value across retries —
// call getProofValidAtSec() fresh on every attempt so the timestamp stays current.

import { ALIAS_PROOF_TAG } from "./constants.js";
import { blake2_256, concatBytes } from "./encoding.js";

// ---------------------------------------------------------------------------
// u64 little-endian encoding
// ---------------------------------------------------------------------------

/**
 * Encode a bigint as 8 bytes, little-endian (u64).
 * This is the wire format used in the AliasAccounts proof message.
 */
export const u64LeBytes = (v: bigint): Uint8Array => {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, v, true /* little-endian */);
  return buf;
};

// ---------------------------------------------------------------------------
// Proof message builder (§3.4 of the handover doc)
// ---------------------------------------------------------------------------

/**
 * Build the 32-byte blake2_256 message that the ring-VRF proof must be built
 * against, as required by AliasAccounts after individuality#955.
 *
 * Wire layout of the pre-image (54 bytes):
 *   ALIAS_PROOF_TAG    — 14 raw bytes ("alias-accounts", no length prefix)
 *   accountPub         — 32 raw bytes (AccountId32 / SS58 public key)
 *   u64LE(proofValidAt) — 8 little-endian bytes
 *
 * Throws if accountPub is not exactly 32 bytes (wrong key or truncation would
 * silently misalign the u64 at the end, producing an undetectable BadProof).
 */
export const buildAliasProofMessage = (
  accountPub: Uint8Array,
  proofValidAt: bigint,
): Uint8Array => {
  if (accountPub.length !== 32) {
    throw new Error(
      `buildAliasProofMessage: accountPub must be 32 bytes, got ${accountPub.length}`,
    );
  }
  return blake2_256(
    concatBytes(ALIAS_PROOF_TAG, accountPub, u64LeBytes(proofValidAt)),
  );
};

// ---------------------------------------------------------------------------
// proof_valid_at sourcing (§3.3 of the handover doc)
// ---------------------------------------------------------------------------

type TimestampNowQuery = {
  query: {
    Timestamp: {
      Now: {
        getValue: (opts?: { at: string }) => Promise<bigint>;
      };
    };
  };
};

/**
 * Read the current chain timestamp from Asset Hub and return it in seconds
 * (as a bigint) suitable for passing as `proof_valid_at`.
 *
 * `Timestamp.Now` returns milliseconds; dividing by 1000n converts to seconds.
 *
 * Do NOT cache this value across retries — the ProofValidityWindow is 300s.
 * Re-call on every tx attempt so the timestamp stays within the window.
 */
export const getProofValidAtSec = async (ahApi: TimestampNowQuery): Promise<bigint> => {
  const nowMs = await ahApi.query.Timestamp.Now.getValue({ at: "best" });
  return nowMs / 1000n;
};
