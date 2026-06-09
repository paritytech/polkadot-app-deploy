// Reproves a stale DotNS alias binding on Asset Hub.
// Ported from the citizenship monorepo (reproveAliasToAccount.ts).
//
// Call when AliasAccounts.AccountToAlias.revision < latest ring root revision
// on the same ring — i.e. the ring was updated after the alias was bound and
// the proof window has advanced.

import { getSs58AddressInfo, Binary } from "polkadot-api";
import type { PolkadotSigner, SS58String } from "polkadot-api";
import { bytesToHex, encodeMembers, hexToBytes } from "./encoding.js";
import { PEOPLE_MEMBER_IDENTIFIER_HEX, PROOF_BYTES } from "./constants.js";
import { buildAliasProofMessage, getProofValidAtSec } from "./proof-validity.js";

// ---------------------------------------------------------------------------
// Loose type shapes for the untyped papi APIs
// ---------------------------------------------------------------------------

type AhApi = {
  constants: {
    AliasAccounts: {
      PeopleRingExponent: () => Promise<{ type: "R2e9" | "R2e10" | "R2e14" }>;
    };
  };
  query: {
    AliasAccounts: {
      AccountToAlias: {
        getValue: (
          who: SS58String,
          opts?: { at: string },
        ) => Promise<
          | {
              collection: string;
              revision: number;
              ring: number;
              ca: {
                alias: string;
                context: string;
              };
              // NOTE: `paid` field removed in individuality#955 — the pallet collapsed
              // its paid/free split; there is now one path (AliasFee applies to all).
            }
          | undefined
        >;
      };
    };
    MembersSubscriber: {
      RingRoots: {
        getValue: (
          ident: string,
          ringIndex: number,
          opts?: { at: string },
        ) => Promise<
          | Array<{
              revision: number;
              root: Uint8Array;
            }>
          | undefined
        >;
      };
    };
    Timestamp: {
      Now: { getValue: (opts?: { at: string }) => Promise<bigint> };
    };
  };
  tx: {
    AliasAccounts: {
      // §3.2: reprove_alias_account keeps its name but takes new proof_valid_at: u64 arg.
      reprove_alias_account: (args: {
        proof: Uint8Array; // BoundedVec<u8>: pass Binary.fromHex(...) (papi Binary ⊆ Uint8Array); a hex string fails isCompat → "Incompatible runtime entry"
        ring_index: number;
        ring_revision: number;
        proof_valid_at: bigint;
      }) => ReproveTx;
    };
  };
};

interface ReproveTx {
  signSubmitAndWatch: (signer: PolkadotSigner) => {
    subscribe: (observer: {
      next: (ev: unknown) => void;
      error: (err: unknown) => void;
    }) => unknown;
  };
}

type PeopleApi = {
  query: {
    Members: {
      Members: {
        getValue: (
          ident: string,
          memberKey: string,
          opts?: { at: string },
        ) => Promise<
          | {
              type: "Included" | string;
              value: { ring_index: number; ring_page: number };
            }
          | undefined
        >;
      };
      RingKeys: {
        getEntries: (opts?: { at: string }) => Promise<
          Array<{
            keyArgs: [string, number, number];
            value: Iterable<string>;
          }>
        >;
      };
    };
  };
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ReproveAliasErrorKind =
  | "NoStoredAlias"
  // NOTE: "NotPaid" removed — individuality#955 collapsed the paid/free split; AliasFee now
  // applies to everyone. reprove_alias_account no longer has a paid-only gate.
  | "RingRootNotFound"
  | "RevisionNotAdvanced"
  | "AliasMismatch"
  | "NotARecognizedPerson"
  | "BadProof"
  | "DispatchError"
  | "RpcError"
  | "ClientError"
  | "Unknown";

export class ReproveAliasError extends Error {
  public readonly kind: ReproveAliasErrorKind;
  public readonly dispatchError?: unknown;

  constructor(
    message: string,
    options: ErrorOptions & {
      kind?: ReproveAliasErrorKind;
      dispatchError?: unknown;
    } = {},
  ) {
    super(message, options);
    this.name = "ReproveAliasError";
    this.kind = options.kind ?? "Unknown";
    this.dispatchError = options.dispatchError;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RingExponent = 9 | 10 | 14;

export interface BuildRingProofInput {
  ringExponent: RingExponent;
  members: Uint8Array;
  context: Uint8Array;
  msg: Uint8Array;
}

export type BuildRingProof = (
  input: BuildRingProofInput,
) => Promise<{ proof: Uint8Array; alias: Uint8Array }>;

export interface ReproveAliasProgress {
  onBroadcasted?: () => void;
  onBestBlock?: (blockHash: string) => void;
}

export interface ReproveAliasParams {
  // Untyped papi objects — cast internally as AhApi / PeopleApi
  peopleUnsafeApi: unknown;
  ahUnsafeApi: unknown;
  account: SS58String;
  memberKey: Uint8Array;
  signCall: PolkadotSigner;
  buildRingProof: BuildRingProof;
  progress?: ReproveAliasProgress;
}

export interface ReproveAliasResult {
  blockHash: string;
  oldRevision: number;
  newRevision: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------


export const reproveAliasToAccount = async ({
  peopleUnsafeApi,
  ahUnsafeApi,
  account,
  memberKey,
  signCall,
  buildRingProof,
  progress,
}: ReproveAliasParams): Promise<ReproveAliasResult> => {
  const people = peopleUnsafeApi as unknown as PeopleApi;
  const ah = ahUnsafeApi as unknown as AhApi;

  if (memberKey.length !== 32) {
    throw new ReproveAliasError("memberKey must be 32 bytes", {
      kind: "ClientError",
    });
  }

  // 1. Read stored AccountToAlias row.
  const stored = await ah.query.AliasAccounts.AccountToAlias.getValue(
    account,
    { at: "best" },
  );
  if (!stored) {
    throw new ReproveAliasError(
      "no AccountToAlias row for this account — bind first",
      { kind: "NoStoredAlias" },
    );
  }
  // NOTE: The paid/free split was removed in individuality#955; no `paid` guard needed.
  const contextBytes = hexToBytes(stored.ca.context);
  const storedRevision = stored.revision;
  const storedRing = stored.ring;
  const storedAliasHex = stored.ca.alias.toLowerCase();

  // 2. Look up ring position on People.
  const position = await people.query.Members.Members.getValue(
    PEOPLE_MEMBER_IDENTIFIER_HEX,
    bytesToHex(memberKey),
    { at: "best" },
  );
  if (!position || position.type !== "Included") {
    throw new ReproveAliasError(
      `member position is '${position?.type ?? "absent"}', expected 'Included'`,
      { kind: "NotARecognizedPerson" },
    );
  }
  const ringIndex = position.value.ring_index;

  // 3. Fetch ring members across all pages.
  const allEntries = await people.query.Members.RingKeys.getEntries({
    at: "best",
  });
  const pages: Array<[number, string[]]> = [];
  const identHex = PEOPLE_MEMBER_IDENTIFIER_HEX.toLowerCase();
  for (const entry of allEntries) {
    if (entry.keyArgs[0].toLowerCase() !== identHex) continue;
    if (Number(entry.keyArgs[1]) !== ringIndex) continue;
    pages.push([Number(entry.keyArgs[2]), [...entry.value]]);
  }
  pages.sort((a, b) => a[0] - b[0]);
  const ringKeys = pages.flatMap(([, ks]) => ks);
  if (ringKeys.length === 0) {
    throw new ReproveAliasError("ring has no members on People", {
      kind: "ClientError",
    });
  }
  const membersBytes = encodeMembers(ringKeys.map((k) => hexToBytes(k)));

  // 4. Get ring exponent and latest revision for the stored collection.
  const ringExp = await ah.constants.AliasAccounts.PeopleRingExponent();
  const ringExponent: RingExponent =
    ringExp.type === "R2e9" ? 9 : ringExp.type === "R2e10" ? 10 : 14;

  const ringRoots = await ah.query.MembersSubscriber.RingRoots.getValue(
    stored.collection,
    ringIndex,
    { at: "best" },
  );
  if (!ringRoots || ringRoots.length === 0) {
    throw new ReproveAliasError(
      "AH has no RingRoots for this (collection, ring_index)",
      { kind: "RingRootNotFound" },
    );
  }
  const latest = ringRoots[ringRoots.length - 1];
  const newRevision = latest.revision;

  // 5. Refuse if the latest in-window revision is not strictly newer.
  if (newRevision <= storedRevision && ringIndex === storedRing) {
    throw new ReproveAliasError(
      `latest revision ${newRevision} is not strictly greater than stored ${storedRevision} on the same ring`,
      { kind: "RevisionNotAdvanced" },
    );
  }

  // 6. Read proof_valid_at from Timestamp.Now (§3.3).
  // IMPORTANT: Submit the tx promptly — ProofValidityWindow = 300s on chain.
  // Do not cache this value across retries; re-call on every attempt.
  const proofValidAt = await getProofValidAtSec(ah);

  // 7. Build the proof message (§3.4): blake2_256(ALIAS_PROOF_TAG || account_pubkey || u64LE(proofValidAt)).
  const ss58Info = getSs58AddressInfo(account);
  if (!ss58Info.isValid) {
    throw new ReproveAliasError(`invalid SS58: ${account}`, {
      kind: "ClientError",
    });
  }
  const aliasMsg = buildAliasProofMessage(ss58Info.publicKey, proofValidAt);

  // 8. Build the ring proof.
  const { proof, alias } = await buildRingProof({
    ringExponent,
    members: membersBytes,
    context: contextBytes,
    msg: aliasMsg,
  });
  if (proof.length !== PROOF_BYTES) {
    throw new ReproveAliasError(
      `ring proof must be ${PROOF_BYTES} bytes, got ${proof.length}`,
      { kind: "ClientError" },
    );
  }

  // 9. Refuse if the regenerated alias differs from the stored alias.
  if (bytesToHex(alias).toLowerCase() !== storedAliasHex) {
    throw new ReproveAliasError(
      `regenerated alias ${bytesToHex(alias)} differs from stored ${storedAliasHex} — would fail ReproveMismatch`,
      { kind: "AliasMismatch" },
    );
  }

  // 10. Submit signed reprove_alias_account (§3.2: new proof_valid_at arg).
  const tx = ah.tx.AliasAccounts.reprove_alias_account({
    // papi encodes the BoundedVec<u8> `proof` from a Binary, NOT a hex string;
    // passing a hex string fails isCompat → "Incompatible runtime entry". (FixedSizeBinary
    // [u8;N] args like collection/context stay hex strings — see e2e-chain-calls.test.js.)
    proof: Binary.fromHex(bytesToHex(proof)),
    ring_index: ringIndex,
    ring_revision: newRevision,
    proof_valid_at: proofValidAt,
  });

  const blockHash = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (err: ReproveAliasError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (h: string) => {
      if (settled) return;
      settled = true;
      resolve(h);
    };

    tx.signSubmitAndWatch(signCall).subscribe({
      next: (event) => {
        if (settled) return;
        const ev = event as {
          type?: string;
          found?: boolean;
          ok?: boolean;
          block?: { hash: string };
          dispatchError?: unknown;
        };
        if (ev.type === "broadcasted") {
          progress?.onBroadcasted?.();
          return;
        }
        if (ev.type === "txBestBlocksState" && ev.found) {
          if (ev.ok === false) {
            fail(
              new ReproveAliasError(
                "reprove_alias_account dispatched but failed in-block",
                {
                  kind: narrowDispatchError(ev.dispatchError),
                  dispatchError: ev.dispatchError,
                },
              ),
            );
            return;
          }
          if (ev.block) progress?.onBestBlock?.(ev.block.hash);
          return;
        }
        if (ev.type === "finalized") {
          if (ev.ok === false) {
            fail(
              new ReproveAliasError(
                "reprove_alias_account failed at finalization",
                {
                  kind: narrowDispatchError(ev.dispatchError),
                  dispatchError: ev.dispatchError,
                },
              ),
            );
            return;
          }
          if (ev.block) succeed(ev.block.hash);
        }
      },
      error: (err) => {
        fail(
          err instanceof ReproveAliasError
            ? err
            : new ReproveAliasError(
                err instanceof Error
                  ? `RPC rejected extrinsic: ${err.message}`
                  : "RPC error during submitAndWatch",
                { cause: err, kind: "RpcError" },
              ),
        );
      },
    });
  });

  return { blockHash, oldRevision: storedRevision, newRevision };
};

// Narrow an AliasAccounts dispatch error to a kind string.
const narrowDispatchError = (
  dispatchError: unknown,
): ReproveAliasErrorKind => {
  if (
    typeof dispatchError === "object" &&
    dispatchError !== null &&
    "type" in (dispatchError as Record<string, unknown>)
  ) {
    const d = dispatchError as { type?: string; value?: unknown };
    if (d.type === "Module" && typeof d.value === "object" && d.value !== null) {
      const v = d.value as { type?: string; value?: { type?: string } };
      if (v.type === "AliasAccounts") {
        if (v.value?.type === "BadProof") return "BadProof";
        if (v.value?.type === "ReproveMismatch") return "AliasMismatch";
        if (v.value?.type === "AliasAccountAlreadySet")
          return "RevisionNotAdvanced";
      }
    }
  }
  return "DispatchError";
};
