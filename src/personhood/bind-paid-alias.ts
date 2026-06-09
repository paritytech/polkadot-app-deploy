// Step 4: AliasAccounts.set_paid_alias_account (sr25519 signed, PGAS fee).
// Ported from the citizenship monorepo (bindPaidAliasToAccount.ts).

import { getSs58AddressInfo, Binary } from "polkadot-api";
import type { PolkadotSigner, SS58String } from "polkadot-api";
import { bytesToHex, encodeMembers, hexToBytes } from "./encoding.js";
import {
  PGAS_ASSET_ID,
  PGAS_ASSET_LOCATION,
  PEOPLE_MEMBER_IDENTIFIER_HEX,
  PROOF_BYTES,
} from "./constants.js";
import { buildAliasProofMessage, getProofValidAtSec } from "./proof-validity.js";

// ---------------------------------------------------------------------------
// Loose type shapes
// ---------------------------------------------------------------------------

type AhApi = {
  constants: {
    AliasAccounts: {
      PeopleCollectionIdentifier: () => Promise<string>;
      PeopleRingExponent: () => Promise<{ type: "R2e9" | "R2e10" | "R2e14" }>;
    };
  };
  query: {
    AliasAccounts: {
      // §3.1: Storage renamed from PaidAliasFee → AliasFee (individuality#955).
      AliasFee: { getValue: (opts?: { at: string }) => Promise<bigint | undefined> };
      AccountToAlias: {
        getValue: (
          who: SS58String,
          opts?: { at: string },
        ) => Promise<unknown>;
      };
    };
    Assets: {
      Account: {
        getValue: (
          id: number,
          who: SS58String,
          opts?: { at: string },
        ) => Promise<{ balance: bigint } | undefined>;
      };
    };
    MembersSubscriber: {
      RingRoots: {
        getValue: (
          ident: string,
          ringIndex: number,
          opts?: { at: string },
        ) => Promise<
          | Array<{ revision: number; root: Uint8Array }>
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
      // §3.2: Extrinsic renamed from set_paid_alias_account → set_alias_account,
      // with new proof_valid_at: u64 parameter added (individuality#955).
      set_alias_account: (args: {
        proof: Uint8Array; // BoundedVec<u8>: pass Binary.fromHex(...) (papi Binary ⊆ Uint8Array); a hex string fails isCompat → "Incompatible runtime entry"
        collection: string;
        ring_index: number;
        ring_revision: number;
        context: string;
        proof_valid_at: bigint;
      }) => PaidAliasTx;
    };
  };
};

interface SubmitOptions {
  customSignedExtensions?: {
    ChargeAssetTxPayment?: {
      value: {
        tip: bigint;
        asset_id: typeof PGAS_ASSET_LOCATION;
      };
    };
  };
}

interface PaidAliasTx {
  signSubmitAndWatch: (
    signer: PolkadotSigner,
    options?: SubmitOptions,
  ) => {
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

export type PaidAliasBindingErrorKind =
  | "NotARecognizedPerson"
  | "RingRootNotFound"
  // §3.5: Error renamed from PaidAliasFeeUnset → AliasFeeUnset (individuality#955).
  | "AliasFeeUnset"
  | "InsufficientPgas"
  | "BadProof"
  | "DispatchError"
  | "RpcError"
  | "ClientError"
  | "Unknown";

export class PaidAliasBindingError extends Error {
  public readonly kind: PaidAliasBindingErrorKind;
  public readonly dispatchError?: unknown;

  constructor(
    message: string,
    options: ErrorOptions & {
      kind?: PaidAliasBindingErrorKind;
      dispatchError?: unknown;
    } = {},
  ) {
    super(message, options);
    this.name = "PaidAliasBindingError";
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

export interface PaidAliasBindingProgress {
  onBroadcasted?: () => void;
  onBestBlock?: (blockHash: string) => void;
}

export interface BindPaidAliasParams {
  peopleUnsafeApi: unknown;
  ahUnsafeApi: unknown;
  account: SS58String;
  memberKey: Uint8Array;
  contextBytes: Uint8Array;
  signCall: PolkadotSigner;
  buildRingProof: BuildRingProof;
  progress?: PaidAliasBindingProgress;
}

export interface BindPaidAliasResult {
  blockHash: string;
  alias: Uint8Array;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// PEOPLE_MEMBER_IDENTIFIER_HEX is already a hex string — used directly for papi 2.x storage/tx args.

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const bindPaidAliasToAccount = async ({
  peopleUnsafeApi,
  ahUnsafeApi,
  account,
  memberKey,
  contextBytes,
  signCall,
  buildRingProof,
  progress,
}: BindPaidAliasParams): Promise<BindPaidAliasResult> => {
  const people = peopleUnsafeApi as unknown as PeopleApi;
  const ah = ahUnsafeApi as unknown as AhApi;

  if (memberKey.length !== 32) {
    throw new PaidAliasBindingError("memberKey must be 32 bytes", {
      kind: "ClientError",
    });
  }
  if (contextBytes.length !== 32) {
    throw new PaidAliasBindingError("contextBytes must be 32 bytes", {
      kind: "ClientError",
    });
  }

  // 1. AliasFee must be set (§3.1: storage renamed from PaidAliasFee → AliasFee).
  const fee = await ah.query.AliasAccounts.AliasFee.getValue({ at: "best" });
  if (fee === undefined) {
    throw new PaidAliasBindingError(
      "AliasAccounts.AliasFee is unset — needs sudo `set_alias_fee`",
      { kind: "AliasFeeUnset" },
    );
  }

  // 2. Signer must have enough PGAS to cover the fee.
  const pgas = await ah.query.Assets.Account.getValue(
    PGAS_ASSET_ID,
    account,
    { at: "best" },
  );
  const pgasBalance = pgas?.balance ?? 0n;
  if (pgasBalance < fee) {
    throw new PaidAliasBindingError(
      `signer has ${pgasBalance.toString()} PGAS but PaidAliasFee is ${fee.toString()} — claim PGAS first`,
      { kind: "InsufficientPgas" },
    );
  }

  // 3. Look up ring position on People.
  const position = await people.query.Members.Members.getValue(
    PEOPLE_MEMBER_IDENTIFIER_HEX,
    bytesToHex(memberKey),
    { at: "best" },
  );
  if (!position || position.type !== "Included") {
    throw new PaidAliasBindingError(
      `member position is '${position?.type ?? "absent"}', expected 'Included'`,
      { kind: "NotARecognizedPerson" },
    );
  }
  const ringIndex = position.value.ring_index;

  // 4. Fetch ring members across all pages.
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
    throw new PaidAliasBindingError("ring has no members on People", {
      kind: "ClientError",
    });
  }
  const membersBytes = encodeMembers(ringKeys.map((k) => hexToBytes(k)));

  // 5. AH constants + latest ring root.
  const collectionId = await ah.constants.AliasAccounts.PeopleCollectionIdentifier();
  const ringExp = await ah.constants.AliasAccounts.PeopleRingExponent();
  const ringExponent: RingExponent =
    ringExp.type === "R2e9" ? 9 : ringExp.type === "R2e10" ? 10 : 14;

  const ringRoots = await ah.query.MembersSubscriber.RingRoots.getValue(
    collectionId,
    ringIndex,
    { at: "best" },
  );
  if (!ringRoots || ringRoots.length === 0) {
    throw new PaidAliasBindingError(
      "AH has no RingRoots for this (collection, ring_index)",
      { kind: "RingRootNotFound" },
    );
  }
  const latest = ringRoots[ringRoots.length - 1];
  const revision = latest.revision;

  // 6. Read proof_valid_at from Timestamp.Now (§3.3).
  // IMPORTANT: Submit the tx promptly — ProofValidityWindow = 300s on chain.
  // Do not cache this value across retries; re-call on every attempt.
  const proofValidAt = await getProofValidAtSec(ah);

  // 7. Build the proof message (§3.4): blake2_256(ALIAS_PROOF_TAG || account_pubkey || u64LE(proofValidAt)).
  const ss58Info = getSs58AddressInfo(account);
  if (!ss58Info.isValid) {
    throw new PaidAliasBindingError(`invalid SS58: ${account}`, {
      kind: "ClientError",
    });
  }
  const aliasMsg = buildAliasProofMessage(ss58Info.publicKey, proofValidAt);

  // 8. Caller builds the ring proof.
  const { proof, alias } = await buildRingProof({
    ringExponent,
    members: membersBytes,
    context: contextBytes,
    msg: aliasMsg,
  });
  if (proof.length !== PROOF_BYTES) {
    throw new PaidAliasBindingError(
      `ring proof must be ${PROOF_BYTES} bytes, got ${proof.length}`,
      { kind: "ClientError" },
    );
  }

  // 9. Build the signed extrinsic (§3.2: renamed set_paid_alias_account → set_alias_account,
  // new proof_valid_at arg).
  const tx = ah.tx.AliasAccounts.set_alias_account({
    // `proof` is a BoundedVec<u8> → papi needs a Binary, not a hex string (hex string
    // fails isCompat → "Incompatible runtime entry"). collection/context are [u8;32]
    // FixedSizeBinary and correctly stay hex strings. See e2e-chain-calls.test.js.
    proof: Binary.fromHex(bytesToHex(proof)),
    collection: collectionId,
    ring_index: ringIndex,
    ring_revision: revision,
    context: bytesToHex(contextBytes),
    proof_valid_at: proofValidAt,
  });

  // 9. Submit and watch. Route fees through ChargeAssetTxPayment → PGAS.
  const submitOptions: SubmitOptions = {
    customSignedExtensions: {
      ChargeAssetTxPayment: {
        value: { tip: 0n, asset_id: PGAS_ASSET_LOCATION },
      },
    },
  };

  const blockHash = await new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (err: PaidAliasBindingError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (h: string) => {
      if (settled) return;
      settled = true;
      resolve(h);
    };

    tx.signSubmitAndWatch(signCall, submitOptions).subscribe({
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
              new PaidAliasBindingError(
                "set_alias_account dispatched but failed in-block",
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
              new PaidAliasBindingError(
                "set_alias_account failed at finalization",
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
          err instanceof PaidAliasBindingError
            ? err
            : new PaidAliasBindingError(
                err instanceof Error
                  ? `RPC rejected extrinsic: ${err.message}`
                  : "RPC error during submitAndWatch",
                { cause: err, kind: "RpcError" },
              ),
        );
      },
    });
  });

  return { blockHash, alias };
};

const narrowDispatchError = (
  dispatchError: unknown,
): PaidAliasBindingErrorKind => {
  if (
    typeof dispatchError === "object" &&
    dispatchError !== null &&
    "type" in (dispatchError as Record<string, unknown>)
  ) {
    const d = dispatchError as { type?: string; value?: unknown };
    if (d.type === "Module" && typeof d.value === "object" && d.value !== null) {
      const v = d.value as { type?: string; value?: { type?: string } };
      if (v.type === "AliasAccounts" && v.value?.type === "BadProof") {
        return "BadProof";
      }
      // §3.5: Error renamed from PaidAliasFeeUnset → AliasFeeUnset (individuality#955).
      if (
        v.type === "AliasAccounts" &&
        v.value?.type === "AliasFeeUnset"
      ) {
        return "AliasFeeUnset";
      }
    }
  }
  return "DispatchError";
};
