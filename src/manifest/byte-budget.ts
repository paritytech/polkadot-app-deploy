/**
 * Byte-budget guards for dotNS text-record writes.
 *
 * This module ships a conservative default with a `BULLETIN_TEXT_BUDGET` env override so
 * publishers can probe larger payloads when the on-chain cap is raised.
 */

import type {
  ExecutableManifest,
  ProductConfig,
  RootManifest,
} from "./types.js";

export const DEFAULT_TEXT_RECORD_BUDGET_BYTES = 1024;

/**
 * Fixed-length stand-in for a Bulletin CID in the pre-upload size preflight.
 *
 * The encoded length depends on the multihash code's varint width:
 *   sha-256     (0x12,   1-byte varint) → CIDv1(raw, …) base32 = 59 chars
 *   blake2b-256 (0xb220, 3-byte varint) → CIDv1(raw, …) base32 = 62 chars
 */
export const PLACEHOLDER_CID =
  "bafk2bzacecjiwibwnfb6fl6rd26a5lrokoutx4lxut6pgw6mmtkqg4comxrae";

/** Resolved text-record byte budget, from `BULLETIN_TEXT_BUDGET` or the default. */
export function getTextRecordBudgetBytes(): number {
  const raw = process.env.BULLETIN_TEXT_BUDGET;
  if (raw === undefined || raw === "") return DEFAULT_TEXT_RECORD_BUDGET_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_TEXT_RECORD_BUDGET_BYTES;
  return parsed;
}

export interface BudgetCheck {
  ok: boolean;
  key: string;
  bytes: number;
  budget: number;
}

/** Check a single serialised value against the budget, in UTF-8 bytes. */
export function assertWithinBudget(
  key: string,
  serialized: string,
  budget: number,
): BudgetCheck {
  const bytes = Buffer.byteLength(serialized, "utf8");
  return { ok: bytes <= budget, key, bytes, budget };
}

export interface PessimisticSizeReport {
  ok: boolean;
  budget: number;
  checks: BudgetCheck[];
}

/**
 * Pre-upload size check for every text record the publish flow will write.
 *
 * Composes each manifest with `PLACEHOLDER_CID` substituted for the real
 * Bulletin CIDs (which aren't known until Step 4 of the publish flow) and
 * verifies the serialised JSON fits within `budget`. Lets the publisher
 * abort cleanly before any chain writes when a config would otherwise
 * trip the dotNS wire-level cap.
 */
export function pessimisticSizePreflight(
  config: ProductConfig,
  budget = getTextRecordBudgetBytes(),
): PessimisticSizeReport {
  const checks: BudgetCheck[] = [];

  const placeholderRoot: RootManifest = {
    $v: 1,
    displayName: config.displayName,
    description: config.description,
    icon: { cid: PLACEHOLDER_CID, format: config.icon.format },
  };
  checks.push(
    assertWithinBudget(
      `${config.domain}#manifest`,
      JSON.stringify(placeholderRoot),
      budget,
    ),
  );

  for (const exec of config.executables) {
    const placeholder = composePlaceholderExecutable(exec);
    checks.push(
      assertWithinBudget(
        `${exec.kind}.${config.domain}#executable`,
        JSON.stringify(placeholder),
        budget,
      ),
    );
  }

  return { ok: checks.every((c) => c.ok), budget, checks };
}

function composePlaceholderExecutable(
  exec: ProductConfig["executables"][number],
): ExecutableManifest {
  if (exec.kind === "app") {
    return { $v: 1, kind: "app", appVersion: exec.appVersion };
  }
  if (exec.kind === "widget") {
    return {
      $v: 1,
      kind: "widget",
      appVersion: exec.appVersion,
      dimensions: exec.dimensions,
      ...(exec.description !== undefined
        ? { description: exec.description }
        : {}),
    };
  }
  return {
    $v: 1,
    kind: "worker",
    appVersion: exec.appVersion,
    entrypoint: exec.entrypoint,
    includes: exec.includes,
  };
}
