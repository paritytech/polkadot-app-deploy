/**
 * Manifest publish orchestrator for RFC paritytech/triangle-js-sdks #0001 Steps 4 through 7.
 *
 * Wires [`storeFile`](../deploy.ts) and [`storeDirectory`](../deploy.ts) for
 * Bulletin uploads with [`DotNS`](../dotns.ts) for the on-chain text-record
 * writes. Each executable's contenthash and execution manifest are committed
 * atomically with `Utility.batch_all`, because either record without its
 * matching peer is not a valid launch contract. Root metadata and independent
 * executable kinds remain separate transactions; snapshot/rollback and the
 * Step 8 round-trip verification remain tracked follow-ups.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PolkadotSigner } from "polkadot-api";
import {
  BLAKE2B_256_MULTIHASH_CODE,
  encodeContenthash,
  storeDirectory,
  storeFile,
  resolveDotnsConnectOptions,
  resolveProductSigner,
  resolveBulletinEndpoints,
  setBulletinEndpoints,
  setBulletinNetworkContext,
  selectStorageReconnect,
  type DeployOptions,
} from "../deploy.js";
import { DotNS, DEFAULT_TLD, stripTldSuffix, parseDomainName, type OwnershipResult } from "../dotns.js";
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
import { composeExecutable, composeRoot } from "./compose.js";
import type { LoadedProductConfig } from "./config-load.js";
import { verifyEmbeddedAppManifests } from "./product-preflight.js";

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
  /** Sign as the RFC-0022 product account, the same key deploy() registers the name with. */
  productName?: string;
  /**
   * The Bulletin allowance-slot signer deploy() resolved for the content upload, handed over
   * in-process via DeployResult. Set when the deploy ran on a login session's own slot rather
   * than a mnemonic: without it this step would store the manifest from the shared dev pool
   * while the content it belongs to went to the user's slot, and on a chain whose pool holds
   * no quota the manifest would be the only part that fails.
   */
  storageSigner?: PolkadotSigner;
  /** SS58 address of the slot account. Required when storageSigner is set. */
  storageSignerAddress?: string;
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
 * (`app|widget|funding|worker.<domain>`) are created on demand and pointed at the
 * content resolver before any `setText`.
 */
export async function publishManifest(opts: PublishManifestOptions): Promise<PublishManifestResult> {
  const { config, sourcePath } = opts.loaded;
  // #1156/#1572: domain reconciliation happens below, once envTld is known —
  // see reconcileManifestDomain. The check that used to live here compared
  // opts.domain to a value the CLI itself derived from config.domain, so it
  // always trivially passed; it caught nothing.
  const embeddedErrors = await verifyEmbeddedAppManifests(config, path.dirname(sourcePath));
  if (embeddedErrors.length > 0) {
    throw new NonRetryableError(
      `App v2 embedded manifest verification failed:\n  - ${embeddedErrors.join("\n  - ")}`,
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
  // DotNS helpers append `.<tld>` internally (this env's resolved TLD — see
  // DotNS._tld / connectDotNS below), so callers of those helpers further
  // down pass the bare label, not this full domain.
  const envTld = resolved.tld ?? DEFAULT_TLD;

  // #1156/#1572: reconcile config.domain against the ACTUAL deploy target
  // (opts.domain) — not a config-derived copy of itself. Hoisted here, right
  // after envTld is known and before any upload below: this makes
  // publishManifest() itself block the icon/executable upload on a mismatch.
  reconcileManifestDomain(config.domain, opts.domain, envTld, sourcePath);
  const popSelfServe = getPopSelfServeConfig(doc, envId);
  setBulletinEndpoints(resolveBulletinEndpoints(resolved.bulletin, opts.rpc));
  // Same reasoning as the endpoints above, for the OTHER piece of env state
  // selectStorageReconnect's mainnet pool-fallback gate reads: `bulletinNetwork` is
  // module-level in deploy.ts and is set per-deploy inside deploy(). A library caller
  // invoking publishManifest() on its own (no preceding in-process deploy()) would
  // otherwise leave it undefined — the historical testnet-shaped fallback, not a hard
  // failure on mainnet. Resolve it from the same env this function already resolved.
  setBulletinNetworkContext(resolved.network);

  const iconAbs = path.resolve(configDir, config.icon.path);
  const iconBytes = await readFileOrThrow(iconAbs, "icon");
  // #1011: banner the manifest-publish phase like Storage/DotNS/Preflight, so
  // it reads as a clearly delimited section instead of a single unbannered
  // line. The "Manifest publish — <domain>" text itself is unchanged (still
  // grepped by test/e2e.test.js's icon-CID hint, see below).
  const banner = "=".repeat(60);
  console.log("\n" + banner);
  console.log(`Manifest publish — ${config.domain}`);
  console.log(banner);
  console.log(`  Loaded config: ${sourcePath}`);
  console.log(`  Uploading icon (${iconBytes.length} B)…`);

  // Bulletin storage for the icon and executables must use the SAME identity
  // that signs the DotNS writes below — reuse selectStorageReconnect's
  // storageSigner > signer > mnemonic > pool precedence (deploy() itself uses
  // the same function) instead of an empty options object, which always fell
  // back to the bare pool-mode provider. That fallback happened to look
  // harmless on every existing manifest E2E scenario, because their pinned
  // pool index was small enough to also be deploy()'s own default 10-account
  // pool window — but a pool leg pinned outside that window
  // (BULLETIN_POOL_ACCOUNT_INDEX >= 10) fails here even though the exact
  // account is already authorized and just stored this deploy's own content,
  // since pool mode never even derives it.
  //
  // Resolved ONCE and shared with connectDotNS below: resolveProductSigner
  // logs "Product deployer: …", and resolving twice would print the line
  // twice under --product-name.
  const signerOpts = manifestSignerOptions(opts);
  const reconnect = selectStorageReconnect(signerOpts);
  const storage = await reconnect();
  let iconCid!: string;
  const executableCids: Record<string, string> = {};
  try {
    iconCid = await storeFile(iconBytes, { ...storage, hashCode: BLAKE2B_256_MULTIHASH_CODE });
    console.log(`  Icon CID: ${iconCid}`);

    for (const exec of config.executables) {
      const execAbs = path.resolve(configDir, exec.path);
      if (opts.buildDirCid && path.resolve(opts.buildDirCid.absPath) === execAbs) {
        console.log(`  Executable [${exec.kind}] reused build-dir CID: ${opts.buildDirCid.cid}`);
        executableCids[exec.kind] = opts.buildDirCid.cid;
        continue;
      }
      console.log(`  Uploading executable [${exec.kind}] from ${execAbs}…`);
      const { storageCid } = await storeDirectory(execAbs, storage, undefined, true);
      console.log(`  Executable [${exec.kind}] CID: ${storageCid}`);
      executableCids[exec.kind] = storageCid;
    }
  } finally {
    // Best-effort: a reconnect inside storeDirectory may already have
    // destroyed and replaced this client (same guard every other destroy
    // call site in deploy.ts uses).
    try { storage.client.destroy(); } catch { /* already destroyed */ }
  }

  const dotns = await connectDotNS(signerOpts, resolved, popSelfServe, envId);

  try {
    const baseLabel = stripDotSuffix(config.domain, envTld);

    const rootManifest = composeRoot(config, iconCid);
    const rootJson = JSON.stringify(rootManifest);
    console.log(
      `  Ensuring resolver + writing root manifest text record on ${config.domain} (${Buffer.byteLength(rootJson, "utf8")} B)…`,
    );
    await dotns.ensureResolverAndSetTextRecord(baseLabel, "manifest", rootJson);

    let textRecordsWritten = 1;
    for (const exec of config.executables) {
      const cid = executableCids[exec.kind];
      if (!cid) throw new NonRetryableError(`Internal: missing CID for executable kind '${exec.kind}'`);

      const ownership = await dotns.checkSubdomainOwnership(exec.kind, baseLabel);
      await registerOrEnsureResolver(dotns, ownership, exec.kind, baseLabel, config.domain);

      const subContenthash = `0x${encodeContenthash(cid)}`;
      const execManifest = composeExecutable(exec);
      const execJson = JSON.stringify(execManifest);
      console.log(`  Atomically writing contenthash and executable manifest on ${exec.kind}.${config.domain} → ${cid} (${Buffer.byteLength(execJson, "utf8")} B)…`);
      await dotns.setContenthashAndTextRecord(`${exec.kind}.${baseLabel}`, subContenthash, "executable", execJson);
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

/**
 * The identity this step signs DotNS with AND stores its Bulletin bytes from — one resolution,
 * deliberately, because the two must never diverge: the icon and executables are paid for out of
 * the storage account's quota, and the manifest records are written by the name's owner.
 *
 * Mirrors what deploy() feeds selectStorageReconnect / resolveDotnsConnectOptions, so both
 * halves of a deploy resolve the same account:
 *   - `productName` -> the RFC-0022 product account (see resolveProductSigner), which is what
 *     deploy() stores content from too, since it swaps the signer before selecting storage.
 *   - `storageSigner` -> the login session's Bulletin allowance slot, carried over from the
 *     deploy that just ran. Kept alongside the signer fields rather than replacing them,
 *     exactly as deploy() holds both, so selectStorageReconnect applies its own precedence.
 *   - otherwise the mnemonic passthrough, unchanged.
 *
 * Call this ONCE per publish: resolveProductSigner logs "Product deployer: …" on every call.
 */
export function manifestSignerOptions(
  opts: Pick<PublishManifestOptions, "mnemonic" | "derivationPath" | "productName" | "storageSigner" | "storageSignerAddress">,
): Pick<DeployOptions, "mnemonic" | "derivationPath" | "signer" | "signerAddress" | "localSigner" | "storageSigner" | "storageSignerAddress"> {
  const product = resolveProductSigner({ productName: opts.productName, mnemonic: opts.mnemonic, derivationPath: opts.derivationPath });
  const base = product ?? { mnemonic: opts.mnemonic, derivationPath: opts.derivationPath };
  // Added only when actually set: an always-present `storageSigner: undefined` would make this
  // object no longer deep-equal the plain mnemonic passthrough callers and tests compare against.
  return opts.storageSigner && opts.storageSignerAddress
    ? { ...base, storageSigner: opts.storageSigner, storageSignerAddress: opts.storageSignerAddress }
    : base;
}

// Takes the ALREADY-RESOLVED signer options rather than the raw PublishManifestOptions: the
// storage selection above needs the same resolution, and resolveProductSigner logs a line per
// call, so the single caller resolves once and passes the result to both.
async function connectDotNS(
  deployOptsShim: ReturnType<typeof manifestSignerOptions>,
  resolved: ResolvedEndpoints,
  popSelfServe: PopSelfServeConfig | null,
  envId: string,
): Promise<DotNS> {
  const connectOpts = resolveDotnsConnectOptions(
    deployOptsShim,
    resolved.assetHub,
    resolved.autoAccountMapping,
    resolved.contracts,
    resolved.nativeToEthRatio,
    envId,
    popSelfServe,
    resolved.registerStorageDeposit,
    resolved.tld,
  );

  const dotns = new DotNS();
  await dotns.connect(connectOpts);
  return dotns;
}

// tld is a required param: this function's single caller (below) always
// passes a resolved value (`resolved.tld ?? DEFAULT_TLD`), so a default here
// was dead code.
function stripDotSuffix(domain: string, tld: string): string {
  return stripTldSuffix(domain, tld);
}

// Does `domain` end in `.<tld>`? Exported so the wrong-env-TLD guard above is
// testable without a live DotNS connection. Case-insensitive to match
// stripTldSuffix and DOMAIN_RE, which both use the `i` flag; a domain equal
// to the bare TLD ("paseo" against "paseo") is a mismatch, since it carries
// no label.
export function domainMatchesEnvTld(domain: string, tld: string): boolean {
  return domain.toLowerCase().endsWith(`.${tld.toLowerCase()}`);
}

/**
 * Reconcile a product config's `domain` against the domain the deploy is
 * actually targeting, before any chain or storage work runs.
 *
 * The only prior guard (`config.domain !== opts.domain`, a byte compare) was
 * toothless — the CLI derived `opts.domain` FROM the config, so the
 * comparison was against a copy of itself. A config whose `domain` field
 * doesn't match the CLI's actual deploy target (e.g. a hardcoded
 * polkadot-app-deploy.config.* left over from a different PR/env) slipped
 * through untouched and only surfaced later, mid-manifest-publish, as an
 * opaque `NotAuthorised()` revert from `ensureContentResolver` — the signer
 * doesn't own the OTHER name the config still names.
 *
 * `deployDomainArg` is documented as a BARE label (no TLD), while
 * `configDomain` always carries a TLD (schema requires it), so the two
 * cannot be compared as raw strings even when they name the same target.
 * Both sides are normalized the same way, through `parseDomainName(x,
 * envTld).fullName`, which accepts either a bare label or a `.<tld>`-suffixed
 * one and independently rejects a DIFFERENT known TLD. `domainMatchesEnvTld`
 * (above) still runs first, against `configDomain` only, so a config
 * carrying the wrong environment's own suffix (e.g. "myapp.dot" against a
 * ".paseo" env) still fails — this does not weaken that check.
 *
 * Lowercased BEFORE normalizing, not after: `parseDomainName` delegates to
 * `validateDomainLabel`, whose charset is strictly lowercase-only (unlike the
 * config schema's case-insensitive domain pattern), so a case-insensitive
 * compare means folding case first — comparing post-throw is not an option.
 */
export function reconcileManifestDomain(
  configDomain: string,
  deployDomainArg: string,
  envTld: string,
  sourcePath: string,
): void {
  if (!domainMatchesEnvTld(configDomain, envTld)) {
    throw new NonRetryableError(
      `Domain "${configDomain}" (in ${sourcePath}) does not end in this environment's DotNS TLD ".${envTld}". ` +
        `Set "domain" in your product config to "<name>.${envTld}", or deploy against the environment whose TLD matches.`,
    );
  }

  const normalize = (raw: string, what: string): string => {
    try {
      return parseDomainName(raw.toLowerCase(), envTld).fullName;
    } catch (err) {
      throw new NonRetryableError(
        `${what} "${raw}" is not a valid dotNS name: ${(err as Error).message}`,
      );
    }
  };
  const configFull = normalize(configDomain, "Config domain");
  const deployFull = normalize(deployDomainArg, "Deploy domain");

  if (configFull !== deployFull) {
    throw new NonRetryableError(
      `Config domain '${configDomain}' (in ${sourcePath}) resolves to '${configFull}', which does not match ` +
        `the deploy target '${deployDomainArg}' (resolves to '${deployFull}'). ` +
        `Either update the config's "domain" or pass the matching <domain> argument.`,
    );
  }
}
