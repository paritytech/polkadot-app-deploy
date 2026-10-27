// Step 2: People.set_personal_id_account (V5 General, unsigned-with-proof via AsPerson).
// Ported from the citizenship monorepo (bindPersonalIdToAccount.ts).

import { Enum } from "polkadot-api";
import type { PolkadotClient, SS58String } from "polkadot-api";
import {
  buildImplicationMessage,
  buildV5GeneralExtrinsic,
  bytesToHex,
  hexToBytes,
  toHex,
} from "./encoding.js";
import { captureExtensions, type CapturedExtensions } from "./capture.js";
import { BANDERSNATCH_SIGNATURE_BYTES } from "./constants.js";

// ---------------------------------------------------------------------------
// Loose type shapes
// ---------------------------------------------------------------------------

type PeopleApi = {
  tx: {
    People: {
      set_personal_id_account: (args: {
        account: SS58String;
        call_valid_at: number;
      }) => SetPersonalIdAccountTx;
    };
  };
  query: {
    System: {
      Number: { getValue: () => Promise<number> };
    };
  };
};

interface SetPersonalIdAccountTx {
  getEncodedData: () => Promise<Uint8Array>;
  create: (creator: unknown, options: SignOptions) => Promise<Uint8Array>;
}

interface SignOptions {
  customSignedExtensions?: Record<
    string,
    { value: unknown; additionalSigned?: unknown }
  >;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AS_PERSON_IDENTIFIER = "AsPerson" as const;
const VERIFY_MULTI_SIGNATURE_IDENTIFIER = "VerifyMultiSignature" as const;

// Extensions excluded from the inherited implication for set_personal_id_account.
// Matches `build_set_personal_id_account_ext` in the runtime integration tests.
const IMPLICATION_EXCLUDE = new Set([
  "VerifyMultiSignature",
  AS_PERSON_IDENTIFIER,
  "AuthorizeCall",
  "StorageWeightReclaim",
]);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type BindingErrorKind =
  | "dispatch_error"
  | "rpc_error"
  | "client_error"
  | "unknown";

export class PersonalIdBindingError extends Error {
  public readonly dispatchError?: unknown;
  public readonly kind: BindingErrorKind;

  constructor(
    message: string,
    options: ErrorOptions & {
      kind?: BindingErrorKind;
      dispatchError?: unknown;
    } = {},
  ) {
    super(message, options);
    this.name = "PersonalIdBindingError";
    this.kind = options.kind ?? "unknown";
    this.dispatchError = options.dispatchError;
  }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SignMember = (message: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface BindPersonalIdToAccountParams {
  /** Untyped papi API for the People chain. */
  typedApi: unknown;
  /** Polkadot client used to submit the unsigned extrinsic. */
  client: PolkadotClient;
  /** Numeric PersonalId of the personhood being bound. */
  personalId: bigint;
  /** SS58 address to bind to the PersonalId. */
  account: SS58String;
  /**
   * Signs `blake2_256(implication)` with the personhood bandersnatch member
   * key. Must return a 96-byte signature.
   */
  signMember: SignMember;
  /**
   * Override the `call_valid_at` block number. Defaults to the current best
   * block number queried from the chain.
   */
  callValidAt?: number;
  progress?: BindingProgress;
}

export interface BindPersonalIdToAccountResult {
  extrinsicHex: `0x${string}`;
  blockHash: string;
}

export interface BindingProgress {
  onBestBlock?: (blockHash: string) => void;
  onBroadcasted?: () => void;
}

// ---------------------------------------------------------------------------
// Exported helpers (test-seam)
// ---------------------------------------------------------------------------

/**
 * Build the AsPerson extension value for a `set_personal_id_account` General
 * extrinsic. Exported so unit tests can assert that the Bandersnatch signature
 * is encoded as a hex string (papi 2.x `SizedBytes(96)` contract).
 *
 * @test-only — production callers use `bindPersonalIdToAccount` directly.
 */
export function buildAsPersonExtensionValue(
  signature: Uint8Array,
  personalId: bigint,
): { type: string; value: [string, bigint] } {
  return Enum("AsPersonalIdentityWithProof", [bytesToHex(signature), personalId]) as unknown as { type: string; value: [string, bigint] };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export const bindPersonalIdToAccount = async ({
  typedApi,
  client,
  personalId,
  account,
  signMember,
  callValidAt,
  progress,
}: BindPersonalIdToAccountParams): Promise<BindPersonalIdToAccountResult> => {
  const api = typedApi as unknown as PeopleApi;
  if (typeof api.tx?.People?.set_personal_id_account !== "function") {
    throw new PersonalIdBindingError(
      "typedApi does not expose People.set_personal_id_account — wrong chain or stale descriptors",
      { kind: "client_error" },
    );
  }

  const block =
    callValidAt ?? (await api.query.System.Number.getValue());

  const innerTx = api.tx.People.set_personal_id_account({
    account,
    call_valid_at: block,
  });
  const callBytes = await innerTx.getEncodedData();

  // Pass 1: capture extension bytes with AsPerson = None (to compute implication).
  // `undefined` is the None variant; raw bytes do not encode through the codec.
  const passEmpty = await capturePass({
    innerTx,
    asPersonValue: undefined,
  });

  const msgHash = buildImplicationMessage(
    callBytes,
    passEmpty.extensions,
    IMPLICATION_EXCLUDE,
  );
  const signature = await Promise.resolve(signMember(msgHash));
  if (signature.length !== BANDERSNATCH_SIGNATURE_BYTES) {
    throw new PersonalIdBindingError(
      `Bandersnatch signature must be ${BANDERSNATCH_SIGNATURE_BYTES} bytes, got ${signature.length}`,
      { kind: "client_error" },
    );
  }

  // Pass 2: re-encode AsPerson with the real proof.
  // SizedBytes codec (SCALE [u8;96]) expects a hex string in papi 2.x, not Uint8Array.
  const asPersonProof = Enum("AsPersonalIdentityWithProof", [bytesToHex(signature), personalId]);
  const passProof = await capturePass({
    innerTx,
    asPersonValue: asPersonProof,
  });

  const extrinsicBytes = buildV5GeneralExtrinsic(callBytes, passProof.extensions);
  const extrinsicHex = toHex(extrinsicBytes);

  const blockHash = await submitExtrinsic(client, extrinsicHex, progress);
  return { extrinsicHex, blockHash };
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const capturePass = async ({
  innerTx,
  asPersonValue,
}: {
  innerTx: SetPersonalIdAccountTx;
  asPersonValue: unknown;
}): Promise<CapturedExtensions> => {
  // Anything papi's enhancers throw (an extension this cannot fill, malformed
  // metadata) arrives here untyped, so callers would lose `kind`.
  let captured: CapturedExtensions | null;
  try {
    captured = await captureExtensions(innerTx, {
      // Immortal, as claim-pgas is. CheckMortality sits after AsPerson in the
      // People pipeline, so its bytes are inside the implication the proof signs.
      // A mortal era moves with the finalized head, so pass 1 and pass 2 could
      // capture different bytes and the signature would not match the wire.
      mortality: { mortal: false },
      customSignedExtensions: {
        [AS_PERSON_IDENTIFIER]: {
          value: asPersonValue,
          additionalSigned: new Uint8Array(),
        },
        [VERIFY_MULTI_SIGNATURE_IDENTIFIER]: {
          value: Enum("Disabled"),
        },
        RestrictOrigins: {
          value: new Uint8Array([0x01]),
          additionalSigned: new Uint8Array(),
        },
      },
    });
  } catch (err: any) {
    throw new PersonalIdBindingError(`extension capture failed: ${err?.message ?? String(err)}`, {
      kind: "client_error",
    });
  }
  if (!captured) {
    throw new PersonalIdBindingError("extension capture failed", {
      kind: "client_error",
    });
  }
  return captured;
};

const submitExtrinsic = (
  client: PolkadotClient,
  extrinsicHex: `0x${string}`,
  progress?: BindingProgress,
): Promise<string> => {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (err: PersonalIdBindingError) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const succeed = (blockHash: string) => {
      if (settled) return;
      settled = true;
      resolve(blockHash);
    };

    client.submitAndWatch(hexToBytes(extrinsicHex)).subscribe({
      next: (event) => {
        if (settled) return;
        if (event.type === "broadcasted") {
          progress?.onBroadcasted?.();
          return;
        }
        if (event.type === "inBestBlock") {
          if (event.ok === false) {
            fail(
              new PersonalIdBindingError(
                "set_personal_id_account dispatched but failed in-block",
                {
                  kind: "dispatch_error",
                  dispatchError: event.dispatchError,
                },
              ),
            );
            return;
          }
          progress?.onBestBlock?.(event.block.hash);
          return;
        }
        if (event.type === "finalized") {
          if (event.ok === false) {
            fail(
              new PersonalIdBindingError(
                "set_personal_id_account dispatch failed at finalization",
                {
                  kind: "dispatch_error",
                  dispatchError: event.dispatchError,
                },
              ),
            );
            return;
          }
          succeed(event.block.hash);
        }
      },
      error: (err) => {
        fail(
          err instanceof PersonalIdBindingError
            ? err
            : new PersonalIdBindingError(
                err instanceof Error
                  ? `RPC rejected extrinsic: ${err.message}`
                  : "RPC error during submitAndWatch",
                { cause: err, kind: "rpc_error" },
              ),
        );
      },
    });
  });
};
