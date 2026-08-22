/**
 * Manifest publish orchestrator for RFC paritytech/triangle-js-sdks #0001 Steps 4 through 7.
 *
 * Wires [`storeFile`](../deploy.ts) and [`storeDirectory`](../deploy.ts) for
 * Bulletin uploads with [`DotNS`](../dotns.ts) for the on-chain text-record
 * writes. Phase 4/5 atomicity work (`Utility.batchAll`, snapshot/rollback,
 * Step 8 round-trip verify) is deliberately deferred. Sequential
 * best-effort writes keep this module small while the broader plan in
 * `docs-internal/superpowers/plans/2026-05-20-product-manifest-support.md`
 * tracks the follow-ups.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  BLAKE2B_256_MULTIHASH_CODE,
  encodeContenthash,
  storeDirectory,
  storeFile,
  resolveDotnsConnectOptions,
  resolveBulletinEndpoints,
  setBulletinEndpoints,
  type DeployOptions,
} from "../deploy.js";
import { DotNS, type OwnershipResult } from "../dotns.js";
import { NonRetryableError } from "../errors.js";
import {
  loadEnvironments,
  resolveEndpoints,
  getPopSelfServeConfig,
  DEFAULT_ENV_ID,
  type ResolvedEndpoints,
  type PopSelfServeConfig,
} from "../environments.js";
import { pessimisticSizePreflight } from "./byte-budget.js";
import type { LoadedProductConfig } from "./config-load.js";
import type {
  AppManifest,
  ExecutableConfig,
  ExecutableManifest,
  ProductConfig,
  RootManifest,
  WidgetManifest,
  WorkerManifest,
} from "./types.js";

export interface PublishManifestOptions {
  /** Loaded + validated product config (call loadProductConfig first). */
  loaded: LoadedProductConfig;
  /** Domain the legacy deploy targeted. Must match config.domain. */
  domain: string;
  /**
   * Build-dir argument passed to the CLI plus the CID it produced. When the
   * resolved path of an executable in the config matches buildDir, we reuse
   * this CID instead of re-uploading the same bytes.
   */
  buildDirCid?: { absPath: string; cid: string };
  /**
   * Env id (e.g. "paseo-next-v2"). Drives DotNS RPC + contract resolution
   * AND the Bulletin endpoint the icon/executable uploads target — both use
   * the same resolved env, matching the legacy deploy.
   */
  env?: string;
  /** Optional bulletin RPC override — same precedence as the legacy deploy's `--rpc`. */
  rpc?: string;
  /** Required: signer mnemonic. */
  mnemonic?: string;
  /** Optional Substrate-style derivation path. */
  derivationPath?: string;
}

export interface PublishManifestResult {
  iconCid: string;
  executableCids: Record<string, string>;
  textRecordsWritten: number;
}

/**
 * Publish a product manifest on top of an already-completed legacy deploy.
 *
 * Uploads the icon and any executables that aren't covered by `buildDirCid`,
 * then writes the root + per-executable text records on dotNS. Subnames
 * (`app|widget|worker.<domain>`) are created on demand and pointed at the
 * content resolver before any `setText`.
 */
export async function publishManifest(opts: PublishManifestOptions): Promise<PublishManifestResult> {
  const { config, sourcePath } = opts.loaded;
  if (config.domain !== opts.domain) {
    throw new NonRetryableError(
      `Config domain '${config.domain}' (in ${sourcePath}) does not match deploy domain '${opts.domain}'. ` +
        `Either update the config or pass the matching <domain> argument.`,
    );
  }

  const sizeReport = pessimisticSizePreflight(config);
  if (!sizeReport.ok) {
    const failing = sizeReport.checks.filter(c => !c.ok).map(c => `${c.key}: ${c.bytes}/${c.budget} B`).join(", ");
    throw new NonRetryableError(
      `Manifest size preflight failed: ${failing}. Shrink displayName / description / paths or override BULLETIN_TEXT_BUDGET.`,
    );
  }

  const configDir = path.dirname(sourcePath);

  // Resolve the env's Bulletin endpoint(s) up front — same env/--rpc
  // precedence deploy() uses (resolveBulletinEndpoints is the exact function
  // deploy() itself calls) — and point the module-level storage endpoint at
  // it BEFORE any storeFile/storeDirectory call below. Without this,
  // storeFile/storeDirectory connect with no client of their own, falling
  // back to getProvider()'s module-default endpoint (DEFAULT_BULLETIN_RPC)
  // regardless of opts.env/opts.rpc, while the DotNS text-record writes
  // further down correctly use the resolved env — so the manifest content
  // could land on the wrong Bulletin chain. Resolve once here and reuse the
  // result in connectDotNS below (no second load).
  const envId = opts.env ?? DEFAULT_ENV_ID;
  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, envId);
  const popSelfServe = getPopSelfServeConfig(doc, envId);
  setBulletinEndpoints(resolveBulletinEndpoints(resolved.bulletin, opts.rpc));

  const iconAbs = path.resolve(configDir, config.icon.path);
  const iconBytes = await readFileOrThrow(iconAbs, "icon");
  console.log(`\nManifest publish — ${config.domain}`);
  console.log(`  Loaded config: ${sourcePath}`);
  console.log(`  Uploading icon (${iconBytes.length} B)…`);
  const iconCid = await storeFile(iconBytes, { hashCode: BLAKE2B_256_MULTIHASH_CODE });
  console.log(`  Icon CID: ${iconCid}`);

  const executableCids: Record<string, string> = {};
  for (const exec of config.executables) {
    const execAbs = path.resolve(configDir, exec.path);
    if (opts.buildDirCid && path.resolve(opts.buildDirCid.absPath) === execAbs) {
      console.log(`  Executable [${exec.kind}] reused build-dir CID: ${opts.buildDirCid.cid}`);
      executableCids[exec.kind] = opts.buildDirCid.cid;
      continue;
    }
    console.log(`  Uploading executable [${exec.kind}] from ${execAbs}…`);
    const { storageCid } = await storeDirectory(execAbs, {}, undefined, true);
    console.log(`  Executable [${exec.kind}] CID: ${storageCid}`);
    executableCids[exec.kind] = storageCid;
  }

  const dotns = await connectDotNS(opts, resolved, popSelfServe, envId);

  try {
    // DotNS helpers append `.dot` internally, so pass the bare label.
    const baseLabel = stripDotSuffix(config.domain);

    await dotns.ensureContentResolver(baseLabel);

    const rootManifest = composeRoot(config, iconCid);
    const rootJson = JSON.stringify(rootManifest);
    console.log(`  Writing root manifest text record on ${config.domain} (${Buffer.byteLength(rootJson, "utf8")} B)…`);
    await dotns.setTextRecord(baseLabel, "manifest", rootJson);

    let textRecordsWritten = 1;
    for (const exec of config.executables) {
      const cid = executableCids[exec.kind];
      if (!cid) throw new NonRetryableError(`Internal: missing CID for executable kind '${exec.kind}'`);

      const ownership = await dotns.checkSubdomainOwnership(exec.kind, baseLabel);
      await registerOrEnsureResolver(dotns, ownership, exec.kind, baseLabel, config.domain);

      const subContenthash = `0x${encodeContenthash(cid)}`;
      console.log(`  Setting contenthash on ${exec.kind}.${config.domain} → ${cid}…`);
      await dotns.setContenthash(`${exec.kind}.${baseLabel}`, subContenthash);

      const execManifest = composeExecutable(exec);
      const execJson = JSON.stringify(execManifest);
      console.log(`  Writing executable manifest on ${exec.kind}.${config.domain} (${Buffer.byteLength(execJson, "utf8")} B)…`);
      await dotns.setTextRecord(`${exec.kind}.${baseLabel}`, "executable", execJson);
      textRecordsWritten++;
    }

    console.log(`  ✓ ${textRecordsWritten} text record${textRecordsWritten === 1 ? "" : "s"} written.`);
    return { iconCid, executableCids, textRecordsWritten };
  } finally {
    dotns.disconnect();
  }
}

/**
 * Perf win: `registerSubdomain` already sets the fresh subname's resolver
 * to the content resolver atomically (`setSubnodeOwner` + `setResolver`,
 * batched via `Utility.batch_all` — see dotns.ts `registerSubdomain`).
 * Calling `ensureContentResolver` again right after a fresh register was
 * therefore a wasted chain read on every executable of every fresh deploy.
 * Only the already-owned path still needs it — a pre-existing subname can
 * have a stale or unset resolver.
 *
 * Takes a minimal injectable `dotns`-like interface (rather than the
 * concrete `DotNS` class) purely so this branch can be unit-tested without a
 * live chain connection; `publishManifest` always calls it with a real
 * `DotNS` instance.
 */
export interface RegisterOrEnsureResolverDeps {
  registerSubdomain(sublabel: string, parentLabel: string): Promise<unknown>;
  ensureContentResolver(domainName: string): Promise<{ changed: boolean }>;
}

export async function registerOrEnsureResolver(
  dotns: RegisterOrEnsureResolverDeps,
  ownership: OwnershipResult,
  execKind: string,
  baseLabel: string,
  domain: string,
): Promise<{ registered: boolean }> {
  if (!ownership.owned) {
    if (ownership.owner) {
      throw new NonRetryableError(
        `Subname ${execKind}.${domain} is owned by ${ownership.owner}, not the publisher. Aborting.`,
      );
    }
    console.log(`  Registering subname ${execKind}.${domain}…`);
    await dotns.registerSubdomain(execKind, baseLabel);
    return { registered: true };
  }
  await dotns.ensureContentResolver(`${execKind}.${baseLabel}`);
  return { registered: false };
}

async function readFileOrThrow(p: string, label: string): Promise<Uint8Array> {
  try {
    return await fs.readFile(p);
  } catch (err) {
    throw new NonRetryableError(`Cannot read ${label} at ${p}: ${(err as Error).message}`);
  }
}

async function connectDotNS(
  opts: PublishManifestOptions,
  resolved: ResolvedEndpoints,
  popSelfServe: PopSelfServeConfig | null,
  envId: string,
): Promise<DotNS> {
  const deployOptsShim: Pick<DeployOptions, "mnemonic" | "derivationPath" | "signer" | "signerAddress"> = {
    mnemonic: opts.mnemonic,
    derivationPath: opts.derivationPath,
  };
  const connectOpts = resolveDotnsConnectOptions(
    deployOptsShim,
    resolved.assetHub,
    resolved.autoAccountMapping,
    resolved.contracts,
    resolved.nativeToEthRatio,
    envId,
    popSelfServe,
    resolved.registerStorageDeposit,
  );

  const dotns = new DotNS();
  await dotns.connect(connectOpts);
  return dotns;
}

function composeRoot(config: ProductConfig, iconCid: string): RootManifest {
  return {
    $v: 1,
    displayName: config.displayName,
    description: config.description,
    icon: { cid: iconCid, format: config.icon.format },
  };
}

function composeExecutable(exec: ExecutableConfig): ExecutableManifest {
  if (exec.kind === "app") {
    return { $v: 1, kind: "app", appVersion: exec.appVersion } as AppManifest;
  }
  if (exec.kind === "widget") {
    return {
      $v: 1,
      kind: "widget",
      appVersion: exec.appVersion,
      dimensions: exec.dimensions,
      ...(exec.description !== undefined ? { description: exec.description } : {}),
    } as WidgetManifest;
  }
  return {
    $v: 1,
    kind: "worker",
    appVersion: exec.appVersion,
    entrypoint: exec.entrypoint,
    includes: exec.includes,
  } as WorkerManifest;
}

function stripDotSuffix(domain: string): string {
  return domain.replace(/\.dot$/i, "");
}
