// Chain prerequisite probes for the personhood bootstrap flow.
//
// These read-only probes check for chain-state requirements that CANNOT be
// satisfied by user code — they require operator/sudo intervention. Run them
// BEFORE any chain submission so errors surface with actionable messages rather
// than opaque BadProof or Payment rejections.
//
// See docs-internal/dotns-bootstrap-handover.md §6 for the full rationale and
// remediation steps for each probe.

import { PGAS_ASSET_ID } from "./constants.js";

// ---------------------------------------------------------------------------
// Loose API shapes
// ---------------------------------------------------------------------------

type AhApi = {
  query: {
    MembersSubscriber: {
      RingCollectionExponents: {
        getValue: (
          ident: string,
          opts?: { at: string },
        ) => Promise<unknown>;
      };
    };
    Assets: {
      Asset: {
        getValue: (
          id: number,
          opts?: { at: string },
        ) => Promise<unknown>;
      };
    };
    AssetConversion: {
      Pools: {
        getValue: (
          pair: [unknown, unknown],
          opts?: { at: string },
        ) => Promise<unknown>;
      };
    };
  };
};

// ---------------------------------------------------------------------------
// XCM location constants for the PGAS↔native pool probe (§6.2)
// ---------------------------------------------------------------------------

/**
 * XCM location for the relay native asset (DOT/PAS) — "here from relay".
 * See docs-internal/dotns-bootstrap-handover.md §6.2.
 */
export const NATIVE_LOC = {
  parents: 1 as const,
  interior: { type: "Here" as const, value: undefined },
};

/**
 * XCM location for the PGAS fungible asset on Asset Hub.
 * PalletInstance(50) = the Assets pallet; GeneralIndex = PGAS asset id.
 * See docs-internal/dotns-bootstrap-handover.md §6.2.
 */
export const PGAS_LOC = {
  parents: 0 as const,
  interior: {
    type: "X2" as const,
    value: [
      { type: "PalletInstance" as const, value: 50 },
      { type: "GeneralIndex" as const, value: BigInt(PGAS_ASSET_ID) },
    ] as const,
  },
};

// ---------------------------------------------------------------------------
// Probe functions
// ---------------------------------------------------------------------------

/**
 * Probe §6.1 — `MembersSubscriber.RingCollectionExponents[peopleIdent]`.
 *
 * The chain's `verify_membership_at_rev` reads this map to look up the ring
 * exponent for the collection. If it is None (populated only when
 * `initialize_ring_roots` was never run before `process_ring_updates`), every
 * ring-VRF flow returns `Error::CollectionNotFound` which maps to
 * `InvalidTransaction::BadProof`.
 *
 * Fix: chain operator must run `sudo-fix-preview-people-exponent.ts` (or
 * equivalent) to populate the storage entry. This is an operator-only fix.
 * See docs-internal/dotns-bootstrap-handover.md §6.1.
 */
export async function probeRingCollectionExponents(
  ahUnsafeApi: unknown,
  peopleIdent: string,
): Promise<void> {
  const ah = ahUnsafeApi as unknown as AhApi;
  let exp: unknown;
  try {
    exp = await ah.query.MembersSubscriber.RingCollectionExponents.getValue(
      peopleIdent,
      { at: "best" },
    );
  } catch (err) {
    throw new Error(
      `chain prerequisite check failed: MembersSubscriber.RingCollectionExponents.getValue threw — ` +
      `RPC error or storage not available. Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (exp === undefined || exp === null) {
    throw new Error(
      `chain prerequisite missing: MembersSubscriber.RingCollectionExponents[${peopleIdent}] is not set. ` +
      `Every ring-VRF proof will be rejected with InvalidTransaction::BadProof (CollectionNotFound). ` +
      `Chain operator must populate this entry (run sudo-fix-preview-people-exponent.ts or equivalent). ` +
      `See docs-internal/dotns-bootstrap-handover.md §6.1.`,
    );
  }
}

/**
 * Probe §6.3 — `Assets.Asset[PGAS_ASSET_ID]`.
 *
 * The PGAS fungible asset (id 2_000_000_000) must exist on Asset Hub before
 * `Pgas.claim_pgas` can succeed. If missing, the call rejects with
 * `InvalidTransaction::Custom(233) = PgasAssetNotCreated`.
 *
 * Fix: chain operator must run `Pgas.create_pgas_asset` (authorized origin
 * only) or apply a migration. This is an operator-only fix.
 * See docs-internal/dotns-bootstrap-handover.md §6.3.
 */
export async function probePgasAsset(ahUnsafeApi: unknown): Promise<void> {
  const ah = ahUnsafeApi as unknown as AhApi;
  let pgas: unknown;
  try {
    pgas = await ah.query.Assets.Asset.getValue(PGAS_ASSET_ID, { at: "best" });
  } catch (err) {
    throw new Error(
      `chain prerequisite check failed: Assets.Asset.getValue(${PGAS_ASSET_ID}) threw — ` +
      `RPC error or storage not available. Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (pgas === undefined || pgas === null) {
    throw new Error(
      `chain prerequisite missing: Assets.Asset[${PGAS_ASSET_ID}] (PGAS) is not created on this chain. ` +
      `Pgas.claim_pgas will reject with InvalidTransaction::Custom(233) = PgasAssetNotCreated. ` +
      `Chain operator must create the PGAS asset via Pgas.create_pgas_asset (authorized origin). ` +
      `See docs-internal/dotns-bootstrap-handover.md §6.3.`,
    );
  }
}

/**
 * Probe §6.2 — `AssetConversion.Pools[[NATIVE_LOC, PGAS_LOC]]`.
 *
 * Required when routing transaction weight fees through PGAS via
 * ChargeAssetTxPayment (so PAS-zero accounts can pay entirely in PGAS).
 * Without the swap pool, the chain returns `InvalidTransaction::Payment`.
 *
 * Fix: chain operator must create the pool via `sudo-create-pgas-pool.ts` or
 * the equivalent `dot` CLI sequence. This is an operator-only fix.
 * See docs-internal/dotns-bootstrap-handover.md §6.2.
 */
export async function probePgasNativePool(
  ahUnsafeApi: unknown,
  nativeLoc: typeof NATIVE_LOC = NATIVE_LOC,
  pgasLoc: typeof PGAS_LOC = PGAS_LOC,
): Promise<void> {
  const ah = ahUnsafeApi as unknown as AhApi;
  let pool: unknown;
  try {
    pool = await ah.query.AssetConversion.Pools.getValue(
      [nativeLoc, pgasLoc],
      { at: "best" },
    );
  } catch (err) {
    throw new Error(
      `chain prerequisite check failed: AssetConversion.Pools.getValue threw — ` +
      `RPC error or storage not available. Cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (pool === undefined || pool === null) {
    throw new Error(
      `chain prerequisite missing: AssetConversion.Pools[NATIVE↔PGAS] does not exist on this chain. ` +
      `PGAS-fee routing via ChargeAssetTxPayment will fail with InvalidTransaction::Payment. ` +
      `Chain operator must create the pool (sudo-create-pgas-pool.ts or equivalent). ` +
      `See docs-internal/dotns-bootstrap-handover.md §6.2.`,
    );
  }
}

/**
 * Run all three chain prerequisite probes in order. Fails fast on the first
 * missing prerequisite so the user gets the most actionable error.
 *
 * Wire this into the bootstrap entry point BEFORE any chain submission.
 */
export async function runChainPrereqProbes(
  ahUnsafeApi: unknown,
  peopleIdent: string,
): Promise<void> {
  await probeRingCollectionExponents(ahUnsafeApi, peopleIdent);
  await probePgasAsset(ahUnsafeApi);
  await probePgasNativePool(ahUnsafeApi);
}
