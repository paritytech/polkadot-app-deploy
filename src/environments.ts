// Environment selection for bulletin-deploy.
//
// Sources environments from the bundled assets/environments.json snapshot.
// The JSON is also imported so compiled consumers that cannot read package
// assets from disk still carry the same environment catalog.

import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NonRetryableError } from "./errors.js";
import embeddedEnvironments from "../assets/environments.json" with { type: "json" };

export const DEFAULT_ENV_ID = "paseo-next-v2";

export interface PopSelfServeConfig {
  /** The label users select in the personhood self-serve env dropdown — e.g. "Next V2". */
  sudoEnvLabel: string;
  /** Faucet URL for funding the service account on this env. Omit on envs with no public faucet (accounts funded by ops). */
  faucetUrl?: string;
  /** Personhood recognition flow URL on the sudo app. */
  personhoodFaucetUrl: string;
  /** Asset-Hub alias-binding flow URL on the sudo app. */
  dotnsBootstrapUrl: string;
  /**
   * Whether state-aware remediation messages (not-bound / bound-likely-stale / wrong-context)
   * can be offered for this env. Requires the reprove tooling to know the env and the user
   * to have access to the dotns-bootstrap UI. Defaults to false; opt in per-env.
   */
  stateAwareGuidance?: boolean;
}

export interface Environment {
  id: string;
  name: string;
  network: "testnet" | "mainnet";
  description?: string;
  badge?: string;
  backend?: string;
  ipfs?: string;
  uptimeUrl?: string;
  autoAccountMapping?: boolean;
  nativeToEthRatio?: number;
  registerStorageDeposit?: number;
  contracts?: Record<string, string>;
  popSelfServe?: PopSelfServeConfig;
}

export interface ChainEndpoint {
  wss: string | string[];
  parachainId?: number;
  uptimeUrl?: string;
}

export interface Chain {
  id: string;
  name: string;
  endpoints: Record<string, ChainEndpoint>;
}

export interface EnvironmentsDoc {
  environments: Environment[];
  chains: Chain[];
}

export type EnvironmentsSource =
  | "bundled"
  | "hardcoded-fallback"
  | "file";

export interface LoadResult {
  doc: EnvironmentsDoc;
  source: EnvironmentsSource;
}

export interface LoadOptions {
  bundledPath?: string;
  /** Explicit path to a user-supplied environments JSON file (deep-merged over bundled). */
  userFilePath?: string;
  warn?: (msg: string) => void;
  capture?: (err: unknown) => void;
}

export interface ResolvedEndpoints {
  bulletin: string[];
  assetHub: string[];
  network: "testnet" | "mainnet";
  envName: string;
  ipfs?: string;
  autoAccountMapping: boolean;
  contracts: Record<string, string>;
  nativeToEthRatio: bigint;
  registerStorageDeposit?: bigint;
}

// ---- Hardcoded ultimate fallback (matches today's default behavior) ---------

const HARDCODED_FALLBACK: EnvironmentsDoc = {
  environments: [
    {
      id: "paseo-next-v2",
      name: "Paseo Next v2",
      network: "testnet",
      description: "Next iteration of the Paseo Next testnet (hardcoded fallback)",
    },
  ],
  chains: [
    {
      id: "bulletin",
      name: "Bulletin",
      endpoints: {
        "paseo-next-v2": {
          wss: "wss://paseo-bulletin-next-rpc.polkadot.io",
          parachainId: 1501,
        },
      },
    },
    {
      id: "asset-hub",
      name: "Asset Hub",
      endpoints: {
        "paseo-next-v2": {
          wss: "wss://paseo-asset-hub-next-rpc.polkadot.io",
          parachainId: 1500,
        },
      },
    },
  ],
};

// ---- Path helpers -----------------------------------------------------------

export function defaultBundledPath(): string {
  // From dist/environments.js → ../assets/environments.json
  // Also works when running directly from src/ in tests (../assets/...).
  return fileURLToPath(new URL("../assets/environments.json", import.meta.url));
}

// ---- Validation -------------------------------------------------------------

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/i;
const ZERO_ADDRESS = "0x" + "0".repeat(40);

/**
 * Returns true for a well-formed, non-zero EVM address:
 *   - 0x-prefixed, exactly 42 characters (0x + 40 hex digits)
 *   - not the all-zeros address
 *
 * Does NOT require EIP-55 checksum — addresses in environments.json may be
 * stored in any casing and the validation goal is structural correctness.
 */
export function isValidContractAddress(addr: unknown): boolean {
  return (
    typeof addr === "string" &&
    EVM_ADDRESS_RE.test(addr) &&
    addr.toLowerCase() !== ZERO_ADDRESS
  );
}

/**
 * Validates all contract addresses in the given contracts map.
 *
 * Throws a clear error for the first invalid address found.
 * Does NOT throw when the map is empty or a key is absent — the map is sparse
 * by design (not all environments have contracts configured).
 *
 * @param contracts  The `contracts` record from an environment entry.
 * @param envId      The environment ID, used in the error message.
 */
export function validateContractAddresses(
  contracts: Record<string, string>,
  envId: string,
): void {
  for (const [name, addr] of Object.entries(contracts)) {
    if (!isValidContractAddress(addr)) {
      throw new Error(
        `Invalid contract address for ${name} in environment ${envId}: ${addr}. ` +
          `Check assets/environments.json against https://github.com/paritytech/dotns#deployments`,
      );
    }
  }
}

function isValidDoc(value: unknown): value is EnvironmentsDoc {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.environments) && Array.isArray(v.chains);
}

/**
 * Deep-merges a user-supplied partial EnvironmentsDoc over a base doc.
 *
 * - `environments` and `chains` arrays are merged by `id`: a user entry with a
 *   matching id is recursively merged into the base entry; unmatched user entries
 *   are appended.
 * - Within each entry, nested plain objects (e.g. `contracts`, `endpoints`) are
 *   merged key-by-key; scalars and arrays (e.g. `wss`) replace wholesale.
 * - Top-level fields not present in the user doc are kept from base.
 */
export function deepMergeEnvironments(base: EnvironmentsDoc, override: Partial<EnvironmentsDoc>): EnvironmentsDoc {
  const mergedEnvironments = mergeById(base.environments, override.environments ?? []);
  const mergedChains = mergeById(base.chains, override.chains ?? []);
  return { environments: mergedEnvironments, chains: mergedChains };
}

function mergeById<T extends { id: string }>(base: T[], overrides: T[]): T[] {
  const result: T[] = base.map(b => {
    const ov = overrides.find(o => o.id === b.id);
    return ov ? mergeObjects(b, ov) : b;
  });
  // Append override entries whose id is not in base.
  for (const ov of overrides) {
    if (!base.find(b => b.id === ov.id)) result.push(ov);
  }
  return result;
}

function mergeObjects<T>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const ov = override[key];
    const bs = base[key];
    if (
      ov !== null &&
      typeof ov === "object" &&
      !Array.isArray(ov) &&
      bs !== null &&
      typeof bs === "object" &&
      !Array.isArray(bs)
    ) {
      // Both are plain objects: merge key-by-key.
      result[key] = { ...(bs as object), ...(ov as object) } as T[keyof T];
    } else {
      // Scalar, array, or null: replace wholesale.
      result[key] = ov as T[keyof T];
    }
  }
  return result;
}

async function readBundled(
  bundledPath: string,
  capture: (err: unknown) => void,
): Promise<EnvironmentsDoc | null> {
  try {
    const raw = await fs.readFile(bundledPath, "utf8");
    const parsed = JSON.parse(raw);
    return isValidDoc(parsed) ? parsed : null;
  } catch (err) {
    capture(err);
    return null;
  }
}

// ---- Public: loadEnvironments ----------------------------------------------

export async function loadEnvironments(opts: LoadOptions = {}): Promise<LoadResult> {
  const bundledPath = opts.bundledPath ?? defaultBundledPath();
  const warn = opts.warn ?? ((msg: string) => console.error(msg));
  const capture = opts.capture ?? (() => {});

  // ---- User-supplied file (--environment-file / PAD_ENV_FILE) ----
  const userFilePath = opts.userFilePath ?? process.env.PAD_ENV_FILE;
  if (userFilePath) {
    let raw: string;
    try {
      raw = await fs.readFile(userFilePath, "utf8");
    } catch (err) {
      // Missing/unreadable explicit file = hard error. The user pointed at a
      // specific file; silently falling back to bundled would deploy on stale
      // data — the opposite of what this escape hatch is for.
      throw new NonRetryableError(
        `--environment-file: cannot read "${userFilePath}": ${(err as Error)?.message ?? err}`,
      );
    }
    let userDoc: unknown;
    try {
      userDoc = JSON.parse(raw);
    } catch (err) {
      throw new NonRetryableError(
        `--environment-file: "${userFilePath}" is not valid JSON: ${(err as Error)?.message ?? err}`,
      );
    }

    // Resolve base (bundled → embedded → hardcoded-fallback) silently.
    const base = await readBundled(bundledPath, capture);
    const baseDoc: EnvironmentsDoc = base ??
      (isValidDoc(embeddedEnvironments) ? embeddedEnvironments : HARDCODED_FALLBACK);

    const partial = (userDoc && typeof userDoc === "object" && !Array.isArray(userDoc))
      ? userDoc as Partial<EnvironmentsDoc>
      : {};
    const merged = deepMergeEnvironments(baseDoc, partial);
    warn(
      `polkadot-app-deploy: Using user-supplied environment file "${userFilePath}" — ` +
        `values are NOT validated against chain; you own correctness.`,
    );
    // Non-fatal contract address validation: surface typos without blocking.
    for (const env of merged.environments) {
      if (env.contracts && Object.keys(env.contracts).length > 0) {
        try {
          validateContractAddresses(env.contracts, env.id);
        } catch (err) {
          warn(`polkadot-app-deploy: Warning: ${(err as Error)?.message ?? err}`);
        }
      }
    }
    return { doc: merged, source: "file" };
  }

  // ---- Standard bundled path -----------------------------------------------
  const bundled = await readBundled(bundledPath, capture);
  if (bundled) return { doc: bundled, source: "bundled" };
  if (isValidDoc(embeddedEnvironments)) {
    return { doc: embeddedEnvironments, source: "bundled" };
  }
  warn("polkadot-app-deploy: bundled environments.json unavailable; using hardcoded paseo-next-v2 fallback");
  return { doc: HARDCODED_FALLBACK, source: "hardcoded-fallback" };
}

// ---- Public: resolveEndpoints ----------------------------------------------

function normalizeWss(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value.slice() : [value];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function suggestEnv(envId: string, doc: EnvironmentsDoc): string | null {
  let best: { id: string; dist: number } | null = null;
  for (const env of doc.environments) {
    const d = levenshtein(envId.toLowerCase(), env.id.toLowerCase());
    if (best === null || d < best.dist) best = { id: env.id, dist: d };
  }
  if (best && best.dist <= Math.max(2, Math.floor(envId.length / 3))) {
    return best.id;
  }
  return null;
}

export function resolveEndpoints(
  doc: EnvironmentsDoc,
  envId: string,
): ResolvedEndpoints {
  const env = doc.environments.find(e => e.id === envId);
  if (!env) {
    const valid = doc.environments.map(e => e.id).join(", ");
    const hint = suggestEnv(envId, doc);
    const suffix = hint ? ` Did you mean '${hint}'?` : "";
    throw new NonRetryableError(
      `Unknown environment '${envId}'. Valid: ${valid}.${suffix}`,
    );
  }

  const bulletinChain = doc.chains.find(c => c.id === "bulletin");
  const assetHubChain = doc.chains.find(c => c.id === "asset-hub");

  const bulletin = normalizeWss(bulletinChain?.endpoints?.[envId]?.wss);
  const assetHub = normalizeWss(assetHubChain?.endpoints?.[envId]?.wss);

  if (bulletin.length === 0) {
    throw new NonRetryableError(
      `Bulletin chain not yet available on environment '${envId}'. ` +
        `The selected environment has no bulletin endpoint in its environments.json entry. ` +
        `Pick an environment that defines a bulletin endpoint (e.g. paseo-next-v2 or devnet).`,
    );
  }

  if (assetHub.length === 0) {
    throw new NonRetryableError(
      `Asset Hub endpoint missing for environment '${envId}'. ` +
        `Check the environment's entry in environments.json.`,
    );
  }

  return {
    bulletin,
    assetHub,
    network: env.network,
    envName: env.name,
    ipfs: env.ipfs,
    autoAccountMapping: env.autoAccountMapping ?? false,
    contracts: env.contracts ?? {},
    nativeToEthRatio: BigInt(env.nativeToEthRatio ?? 1_000_000),
    ...(env.registerStorageDeposit !== undefined ? { registerStorageDeposit: BigInt(env.registerStorageDeposit) } : {}),
  };
}

// ---- Public: getPopSelfServeConfig ----------------------------------------

export function getPopSelfServeConfig(doc: EnvironmentsDoc, envId: string): PopSelfServeConfig | null {
  return doc.environments.find(e => e.id === envId)?.popSelfServe ?? null;
}

// ---- Public: listEnvironments ---------------------------------------------

export interface EnvironmentListing {
  id: string;
  name: string;
  network: string;
  hasBulletin: boolean;
  description: string;
}

export function listEnvironments(doc: EnvironmentsDoc): EnvironmentListing[] {
  const bulletinChain = doc.chains.find(c => c.id === "bulletin");
  return doc.environments.map(env => {
    const ep = bulletinChain?.endpoints?.[env.id];
    const hasBulletin = !!ep && normalizeWss(ep.wss).length > 0;
    return {
      id: env.id,
      name: env.name,
      network: env.network,
      hasBulletin,
      description: env.description ?? "",
    };
  });
}

export function formatEnvironmentTable(rows: EnvironmentListing[]): string {
  const headers = ["ID", "Name", "Network", "Bulletin?", "Description"];
  const data = rows.map(r => [
    r.id,
    r.name,
    r.network,
    r.hasBulletin ? "yes" : "no",
    r.description,
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...data.map(row => row[i].length)),
  );
  const fmtRow = (row: string[]) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  const sep = widths.map(w => "-".repeat(w)).join("  ");
  return [fmtRow(headers), sep, ...data.map(fmtRow)].join("\n");
}
