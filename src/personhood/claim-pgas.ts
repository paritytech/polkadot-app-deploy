// Step 3: Pgas.claim_pgas (V5 General, unsigned-with-proof via AsPgas).
// Ported from the citizenship monorepo (claimPgas.ts).

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — verifiablejs/nodejs DTS path differs from the types field
import * as verifiable from "verifiablejs/nodejs";
import { Enum } from "polkadot-api";
import type { PolkadotClient, PolkadotSigner, SS58String } from "polkadot-api";
import {
  buildImplicationMessage,
  buildV5GeneralExtrinsic,
  bytesToHex,
  encodeMembers,
  hexToBytes,
  readExtensionOrder,
  toHex,
  type ExtensionValues,
} from "./encoding.js";
import {
  PEOPLE_MEMBER_IDENTIFIER_HEX,
  PGAS_ASSET_ID,
  PROOF_BYTES,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Loose type shapes
// ---------------------------------------------------------------------------

type AhApi = {
  constants: {
    AliasAccounts: {
      PeopleCollectionIdentifier: () => Promise<string>;
      PeopleRingExponent: () => Promise<{ type: "R2e9" | "R2e10" | "R2e14" }>;
    };
    Pgas: {
      PgasClaimAmount: () => Promise<bigint>;
    };
  };
  query: {
    Timestamp: {
      Now: { getValue: (opts?: { at: string }) => Promise<bigint> };
    };
    Assets: {
      Asset: {
        getValue: (
          id: number,
          opts?: { at: string },
        ) => Promise<unknown>;
      };
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
  };
  tx: {
    Pgas: {
      claim_pgas: (args: { slot_index: number; target: SS58String }) => ClaimPgasTx;
    };
  };
};

interface ClaimPgasTx {
  getEncodedData: () => Promise<Uint8Array>;
  sign: (signer: PolkadotSigner, options: unknown) => Promise<string>;
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

export type PgasClaimErrorKind =
  | "PgasAssetNotCreated"
  | "AlreadyClaimedToday"
  | "InvalidClaimSlot"
  | "InvalidClaimDay"
  | "BadProof"
  | "RingRootNotFound"
  | "NotARecognizedPerson"
  | "DispatchError"
  | "RpcError"
  | "ClientError"
  | "Unknown";

export class PgasClaimError extends Error {
  public readonly kind: PgasClaimErrorKind;
  public readonly dispatchError?: unknown;

  constructor(
    message: string,
    options: ErrorOptions & {
      kind?: PgasClaimErrorKind;
      dispatchError?: unknown;
    } = {},
  ) {
    super(message, options);
    this.name = "PgasClaimError";
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

export interface PgasClaimProgress {
  onBroadcasted?: () => void;
  onBestBlock?: (blockHash: string) => void;
}

/**
 * Injection seam for `validate_with_commitment` (verifiablejs/nodejs ≥ beta.4).
 * Signature: (ringExponent, proof, commitment, context, message) → alias bytes.
 * Throws if the proof does not verify against the given commitment.
 *
 * Tests supply a mock; production callers get the real function from verifiablejs.
 * When the installed verifiablejs < 1.3.0-beta.4 lacks the export, the default
 * implementation throws a clear error rather than silently skipping the check.
 */
export type ValidateWithCommitment = (
  ringExponent: number,
  proof: Uint8Array,
  commitment: Uint8Array,
  context: Uint8Array,
  message: Uint8Array,
) => Uint8Array;

export interface ClaimPgasParams {
  peopleUnsafeApi: unknown;
  ahUnsafeApi: unknown;
  ahClient: PolkadotClient;
  target: SS58String;
  memberKey: Uint8Array;
  buildRingProof: BuildRingProof;
  slotIndex?: number;
  progress?: PgasClaimProgress;
  /**
   * Injectable `validate_with_commitment` for testing. Defaults to the real
   * verifiablejs export when available. See docs-internal/dotns-bootstrap-handover.md §5.
   */
  validateWithCommitment?: ValidateWithCommitment;
}

export interface ClaimPgasResult {
  blockHash: string;
  amount: bigint;
  alias: Uint8Array;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECS_PER_DAY = 86_400n;

const PGAS_CONTEXT_PREFIX = new TextEncoder().encode("pop:gas:");

function buildGasContext(day: number, slotIndex: number): Uint8Array {
  const out = new Uint8Array(32);
  out.set(PGAS_CONTEXT_PREFIX, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, day, true);
  dv.setUint32(12, slotIndex, true);
  return out;
}

// PEOPLE_MEMBER_IDENTIFIER_HEX is already a hex string — used directly for papi 2.x storage/tx args.

// ---------------------------------------------------------------------------
// Exported helpers (test-seam)
// ---------------------------------------------------------------------------

/**
 * Compute the AsPgas inherited-implication exclude set DYNAMICALLY from the
 * live AH chain's signed-extension pipeline order.
 *
 * See docs-internal/dotns-bootstrap-handover.md §4.3 for the full rationale.
 * Hardcoding this set is exactly how BadProof'd in past runtime upgrades:
 * whenever the runtime adds a new origin-modifier extension before AsPgas,
 * a static exclude silently includes its bytes in the implication hash.
 *
 * Recipe: everything ≤ AsPgas in the pipeline is excluded (those extensions
 * run before AsPgas and their bytes are NOT part of the inherited implication).
 * Additionally, "AuthorizeCall" (empty value+implicit, no-op) and
 * "StorageWeightReclaim" (outer wrapper, no contribution) are always excluded
 * even if they appear after AsPgas in a future runtime layout.
 */
// See docs-internal/dotns-bootstrap-handover.md §4.3 — the implication exclude
// must be computed dynamically from the live pipeline. Hardcoding silently
// drifts every time the runtime adds a new origin-modifier extension.
export function buildImplicationExclude(pipelineOrder: string[]): Set<string> {
  // Spec: docs-internal/dotns-bootstrap-handover.md §4.3.
  const asPgasIdx = pipelineOrder.indexOf("AsPgas");
  if (asPgasIdx < 0) {
    throw new Error("AsPgas not in AH pipeline — wrong chain?");
  }
  return new Set([
    ...pipelineOrder.slice(0, asPgasIdx + 1), // everything ≤ AsPgas
    "AuthorizeCall",        // empty value+implicit, no-op
    "StorageWeightReclaim", // outer wrapper, no contribution
  ]);
}

/**
 * Build the AsPgas::Claim extension value for a `claim_pgas` General extrinsic.
 * Exported so unit tests can assert that the ring-VRF proof is encoded as a hex
 * string (papi 2.x `FixedSizeBinary<788>` / SizedBytes contract).
 *
 * @test-only — production callers use `claimPgas` directly.
 */
export function buildAsPgasClaimExtensionValue(
  proof: Uint8Array,
  ringIndex: number,
  revision: number,
  day: number,
): { type: string; value: { proof: string; ring_index: number; revision: number; collection: unknown; day: number } } {
  return Enum("Claim", {
    proof: bytesToHex(proof),
    ring_index: ringIndex,
    revision,
    collection: Enum("People"),
    day,
  }) as unknown as { type: string; value: { proof: string; ring_index: number; revision: number; collection: unknown; day: number } };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const claimPgas = async ({
  peopleUnsafeApi,
  ahUnsafeApi,
  ahClient,
  target,
  memberKey,
  buildRingProof,
  slotIndex = 0,
  progress,
  validateWithCommitment = defaultValidateWithCommitment,
}: ClaimPgasParams): Promise<ClaimPgasResult> => {
  const people = peopleUnsafeApi as unknown as PeopleApi;
  const ah = ahUnsafeApi as unknown as AhApi;

  if (memberKey.length !== 32) {
    throw new PgasClaimError("memberKey must be 32 bytes", { kind: "ClientError" });
  }

  // 1. Confirm the PGAS asset exists on AH.
  const asset = await ah.query.Assets.Asset.getValue(PGAS_ASSET_ID, { at: "best" });
  if (!asset) {
    throw new PgasClaimError(
      "PGAS asset (id 2_000_000_000) does not exist on AH",
      { kind: "PgasAssetNotCreated" },
    );
  }

  // 2. Look up the member's ring position on People.
  const position = await people.query.Members.Members.getValue(
    PEOPLE_MEMBER_IDENTIFIER_HEX,
    bytesToHex(memberKey),
    { at: "best" },
  );
  if (!position) {
    throw new PgasClaimError(
      "member key not present on People — recognize first",
      { kind: "NotARecognizedPerson" },
    );
  }
  if (position.type !== "Included") {
    throw new PgasClaimError(
      `member position is '${position.type}', expected 'Included'`,
      { kind: "NotARecognizedPerson" },
    );
  }
  const ringIndex = position.value.ring_index;

  // 3. Fetch all ring members across pages.
  const allEntries = await people.query.Members.RingKeys.getEntries({ at: "best" });
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
    throw new PgasClaimError("ring has no members on People", {
      kind: "ClientError",
    });
  }
  const membersBytes = encodeMembers(ringKeys.map((k) => hexToBytes(k)));

  // 4. AH ring exponent + latest revision.
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
    throw new PgasClaimError(
      "AH has no RingRoots for this (collection, ring_index)",
      { kind: "RingRootNotFound" },
    );
  }
  const latest = ringRoots[ringRoots.length - 1];
  const revision = latest.revision;

  // 5. Day index — floor(Timestamp.Now / 86400).
  const nowRaw = await ah.query.Timestamp.Now.getValue({ at: "best" });
  const nowSec = nowRaw > 10_000_000_000n ? nowRaw / 1000n : nowRaw;
  const day = Number(nowSec / SECS_PER_DAY);

  const contextBytes = buildGasContext(day, slotIndex);

  // 6. Build inner call.
  const innerTx = ah.tx.Pgas.claim_pgas({ slot_index: slotIndex, target });
  const callBytes = await innerTx.getEncodedData();

  // 7. Capture pass 1 — AsPgas value = None (undefined).
  // Two passes are necessary because the proof depends on the implication hash,
  // and the implication hash depends on the extension bytes captured with empty
  // AsPgas. See docs-internal/dotns-bootstrap-handover.md §4.4 for the full
  // explanation of this two-pass dummy-signer capture pattern.
  const passEmpty = await capturePass(innerTx, undefined);

  // 8. Build the exclude set DYNAMICALLY from the live pipeline order.
  // Do NOT hardcode this — see docs-internal/dotns-bootstrap-handover.md §4.3.
  // The pipeline order is captured from the live chain metadata in capturePass.
  const implicationExclude = buildImplicationExclude(passEmpty.extensions.order);

  // 9. Implication hash.
  const msg = buildImplicationMessage(
    callBytes,
    passEmpty.extensions,
    implicationExclude,
  );

  // 10. Build the ring proof.
  const { proof, alias } = await buildRingProof({
    ringExponent,
    members: membersBytes,
    context: contextBytes,
    msg,
  });
  if (proof.length !== PROOF_BYTES) {
    throw new PgasClaimError(
      `ring proof must be ${PROOF_BYTES} bytes, got ${proof.length}`,
      { kind: "ClientError" },
    );
  }

  // 10a. Pre-flight: validate proof locally against the chain's ring root before
  // submitting. If this throws, the chain will reject too — and the local failure
  // gives a concrete diagnostic before paying for a tx.
  // See docs-internal/dotns-bootstrap-handover.md §5.
  const rootBytes = latest.root instanceof Uint8Array
    ? latest.root
    : (latest.root as { asBytes: () => Uint8Array }).asBytes();
  try {
    validateWithCommitment(ringExponent, proof, rootBytes, contextBytes, msg);
  } catch (err) {
    throw new PgasClaimError(
      `validate_with_commitment failed locally — proof will be rejected by chain. ` +
      `proof=${proof.length}B context=${contextBytes.length}B commitment=${rootBytes.length}B. ` +
      `Cause: ${err instanceof Error ? err.message : String(err)}`,
      { kind: "BadProof", cause: err },
    );
  }

  // 11. Capture pass 2 — AsPgas::Claim with the real proof.
  // FixedSizeBinary<N> fields need hex strings in papi 2.x.
  const asPgasValue = Enum("Claim", {
    proof: bytesToHex(proof),
    ring_index: ringIndex,
    revision,
    collection: Enum("People"),
    day,
  });
  const passProof = await capturePass(innerTx, asPgasValue);

  // 12. Assemble V5 General extrinsic and submit.
  const extrinsicBytes = buildV5GeneralExtrinsic(callBytes, passProof.extensions);
  const extrinsicHex = toHex(extrinsicBytes);
  const blockHash = await submitExtrinsic(ahClient, extrinsicHex, progress);

  const amount = await ah.constants.Pgas.PgasClaimAmount();
  return { blockHash, amount, alias };
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Default implementation of validateWithCommitment. Calls the real
 * verifiablejs export if available (requires verifiablejs ≥ 1.3.0-beta.4).
 * Throws a clear error when the installed version doesn't have the export,
 * rather than silently skipping the pre-flight check.
 */
const defaultValidateWithCommitment: ValidateWithCommitment = (
  ringExponent,
  proof,
  commitment,
  context,
  message,
): Uint8Array => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (verifiable as unknown as Record<string, unknown>)["validate_with_commitment"] as ((...args: unknown[]) => Uint8Array) | undefined;
  if (typeof fn !== "function") {
    throw new Error(
      "validate_with_commitment is not exported by the installed verifiablejs. " +
      "Upgrade to verifiablejs@1.3.0-beta.4 or newer to enable local proof pre-flight. " +
      "See docs-internal/dotns-bootstrap-handover.md §5.",
    );
  }
  return fn(ringExponent, proof, commitment, context, message);
};

interface CapturePass {
  callData: Uint8Array;
  extensions: ExtensionValues;
}

const capturePass = async (
  innerTx: ClaimPgasTx,
  asPgasValue: unknown,
): Promise<CapturePass> => {
  let captured: CapturePass | null = null;
  const sentinel = new Error("__pgas_capture_sentinel__");
  const signer: PolkadotSigner = {
    publicKey: new Uint8Array(32),
    signTx: async (callData, signedExtensions, metadata) => {
      const order = await readExtensionOrder(metadata);
      const byIdentifier: ExtensionValues["byIdentifier"] = {};
      for (const id of order) {
        const ext = signedExtensions[id];
        byIdentifier[id] = {
          value: ext.value,
          additionalSigned: ext.additionalSigned,
        };
      }
      captured = { callData, extensions: { order, byIdentifier } };
      throw sentinel;
    },
    signBytes: async () => new Uint8Array(64),
  };
  try {
    await innerTx.sign(signer, {
      mortality: { mortal: false },
      customSignedExtensions: {
        AsPgas: {
          value: asPgasValue,
          additionalSigned: new Uint8Array(),
        },
      },
    });
  } catch (err) {
    if (err !== sentinel) throw err;
  }
  if (captured === null) {
    throw new PgasClaimError("extension capture failed", { kind: "ClientError" });
  }
  return captured;
};

const narrowDispatchError = (dispatchError: unknown): PgasClaimErrorKind => {
  if (
    typeof dispatchError === "object" &&
    dispatchError !== null &&
    "type" in (dispatchError as Record<string, unknown>)
  ) {
    const d = dispatchError as { type?: string; value?: unknown };
    if (d.type === "Invalid" && typeof d.value === "object" && d.value !== null) {
      const v = d.value as { type?: string; value?: unknown };
      if (v.type === "BadProof") return "BadProof";
      if (v.type === "Custom") {
        switch (v.value) {
          case 230: return "InvalidClaimSlot";
          case 231: return "InvalidClaimDay";
          case 232: return "AlreadyClaimedToday";
          case 233: return "PgasAssetNotCreated";
        }
      }
    }
  }
  return "DispatchError";
};

const submitExtrinsic = (
  client: PolkadotClient,
  extrinsicHex: `0x${string}`,
  progress?: PgasClaimProgress,
): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (err: PgasClaimError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (h: string) => {
      if (settled) return;
      settled = true;
      resolve(h);
    };
    client.submitAndWatch(hexToBytes(extrinsicHex)).subscribe({
      next: (event) => {
        if (settled) return;
        if (event.type === "broadcasted") {
          progress?.onBroadcasted?.();
          return;
        }
        if (event.type === "txBestBlocksState" && event.found) {
          if (event.ok === false) {
            fail(
              new PgasClaimError("claim_pgas dispatched but failed in-block", {
                kind: narrowDispatchError(event.dispatchError),
                dispatchError: event.dispatchError,
              }),
            );
            return;
          }
          progress?.onBestBlock?.(event.block.hash);
          return;
        }
        if (event.type === "finalized") {
          if (event.ok === false) {
            fail(
              new PgasClaimError("claim_pgas failed at finalization", {
                kind: narrowDispatchError(event.dispatchError),
                dispatchError: event.dispatchError,
              }),
            );
            return;
          }
          succeed(event.block.hash);
        }
      },
      error: (err) => {
        fail(
          err instanceof PgasClaimError
            ? err
            : new PgasClaimError(
                err instanceof Error
                  ? `RPC rejected extrinsic: ${err.message}`
                  : "RPC error during submitAndWatch",
                { cause: err, kind: "RpcError" },
              ),
        );
      },
    });
  });
};
