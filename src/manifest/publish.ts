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
  type DeployOptions,
} from "../deploy.js";
import { DotNS } from "../dotns.js";
import { NonRetryableError } from "../errors.js";
import { loadEnvironments, resolveEndpoints, getPopSelfServeConfig } from "../environments.js";
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
  /** Env id (e.g. "paseo-next-v2"). Drives RPC + contract resolution. */
  env?: string;
  /** Optional bulletin RPC override. */
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

  const dotns = await connectDotNS(opts);

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
      if (!ownership.owned) {
        if (ownership.owner) {
          throw new NonRetryableError(
            `Subname ${exec.kind}.${config.domain} is owned by ${ownership.owner}, not the publisher. Aborting.`,
          );
        }
        console.log(`  Registering subname ${exec.kind}.${config.domain}…`);
        await dotns.registerSubdomain(exec.kind, baseLabel);
      }

      await dotns.ensureContentResolver(`${exec.kind}.${baseLabel}`);

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

async function readFileOrThrow(p: string, label: string): Promise<Uint8Array> {
  try {
    return await fs.readFile(p);
  } catch (err) {
    throw new NonRetryableError(`Cannot read ${label} at ${p}: ${(err as Error).message}`);
  }
}

async function connectDotNS(opts: PublishManifestOptions): Promise<DotNS> {
  const envId = opts.env ?? "paseo-next-v2";
  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, envId);
  const popSelfServe = getPopSelfServeConfig(doc, envId);

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
