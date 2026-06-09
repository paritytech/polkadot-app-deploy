// Sentry telemetry.
//
// Default: OFF. Telemetry is strictly opt-in.
//
// Enabled only when:
//   - PAD_TELEMETRY=1 (explicit opt-in)
// Force-disabled by PAD_TELEMETRY=0 or DO_NOT_TRACK=1 regardless of other signals.

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pkg from "../package.json";
import { maybeWriteMemoryReport, sampleFromBytes, type MemorySampleMb, type DeployContextForReport, type MemoryReport } from "./memory-report.js";
import { writeRunState } from "./run-state.js";
import type { CodePath } from "./code-paths.js";

export const VERSION: string = pkg.version;
const DOTNS_BACKEND = "contract";
const DOTNS_POP_SOURCE = "personhood-precompile";

type SentryModule = typeof import("@sentry/node") | null;

// Injected by tsup at build time from SENTRY_DSN env var. Empty in source builds.
declare const __SENTRY_DSN__: string;

export function extractRepoSlug(url: string): string {
  return url.replace(/.*github\.com[:/]/, "").replace(/\.git$/, "");
}

const FALLBACK_ISSUE_REPO = "paritytech/polkadot-app-deploy";

/**
 * Resolve the `owner/name` slug for the package's own GitHub issue tracker.
 * Accepts the raw `repository` field from package.json (string or `{url}` object)
 * and returns a normalized `owner/name` slug. Falls back to the upstream
 * literal if the field is absent or does not resolve to a valid `owner/name` slug.
 */
export function resolveIssueRepoSlug(repository: unknown): string {
  try {
    const raw = typeof repository === "string" ? repository : (repository as { url?: string } | null)?.url;
    if (!raw || typeof raw !== "string") return FALLBACK_ISSUE_REPO;
    const slug = extractRepoSlug(raw.trim());
    if (/^[^/\s]+\/[^/\s]+$/.test(slug)) return slug;
  } catch {}
  return FALLBACK_ISSUE_REPO;
}

function tryGitRemote(): string | undefined {
  try {
    return extractRepoSlug(execSync("git remote get-url origin", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim());
  } catch { return undefined; }
}

/** @internal kept for memory-report.ts compatibility; always returns false in the public build. */
export function isInternalContext(): boolean {
  return false;
}

const OPT_OUT = process.env.PAD_TELEMETRY === "0" || process.env.PAD_TELEMETRY === "off";
const OPT_IN = process.env.PAD_TELEMETRY === "1";
// DO_NOT_TRACK: honor the https://www.eff.org/issues/do-not-track convention.
// An explicit PAD_TELEMETRY=1 overrides this (the user consciously
// opted into this tool); otherwise a truthy DO_NOT_TRACK forces telemetry off.
const DO_NOT_TRACK = !!process.env.DO_NOT_TRACK && process.env.DO_NOT_TRACK !== "0" && process.env.DO_NOT_TRACK !== "";

/**
 * Pure decision function for whether telemetry is disabled.
 *
 * Precedence (highest to lowest):
 * 1. optOut (PAD_TELEMETRY=0/off) → always disabled
 * 2. optIn (PAD_TELEMETRY=1) → enabled, overrides DO_NOT_TRACK
 * 3. doNotTrack (DO_NOT_TRACK=1) → disabled
 * 4. default → disabled (strictly opt-in)
 */
export function isTelemetryDisabled(s: { optIn: boolean; optOut: boolean; doNotTrack: boolean }): boolean {
  if (s.optOut) return true;
  if (s.optIn) return false;
  if (s.doNotTrack) return true;
  return true;
}

const DISABLED = isTelemetryDisabled({ optIn: OPT_IN, optOut: OPT_OUT, doNotTrack: DO_NOT_TRACK });

// ── PII sanitization ─────────────────────────────────────────────
// Applied even when telemetry is on (e.g. Parity employees on their own Macs):
// employee usernames, home paths, personal hostnames, and account addresses are
// still sensitive regardless of who runs the tool.

const CONVENTIONAL_BRANCH_PREFIXES = new Set([
  "fix", "feat", "chore", "docs", "test", "refactor", "release", "bump",
  "perf", "style", "ci", "build", "revert",
]);

// Replace absolute filesystem paths so macOS usernames (/Users/<name>/...) and
// Linux home dirs (/home/<name>/...) don't surface in error messages or breadcrumbs.
export function scrubPaths(msg: string): string {
  if (!msg) return msg;
  return msg
    .replace(/\/Users\/[^\/\s"'`]+/g, "/Users/<redacted>")
    .replace(/\/home\/[^\/\s"'`]+/g, "/home/<redacted>");
}

// Keep the first 8 chars of an ss58 address — same length the CLI already prints.
// Preserves groupability in dashboards; hides the full address.
export function truncateAddress(ss58: string | undefined): string | undefined {
  if (!ss58) return ss58;
  return ss58.length > 8 ? `${ss58.slice(0, 8)}…` : ss58;
}

// Keep branches whose prefix matches a known conventional-commits style; otherwise
// fall back to just the last `/` segment so user-prefixed branches like "rh/foo"
// become "foo" instead of leaking the user slug.
export function sanitizeBranch(name: string | undefined): string | undefined {
  if (!name) return name;
  const slash = name.indexOf("/");
  if (slash === -1) return name;
  const prefix = name.slice(0, slash).toLowerCase();
  if (CONVENTIONAL_BRANCH_PREFIXES.has(prefix)) return name;
  return name.slice(slash + 1);
}

// All slugs keep only the org and hash the repo name, so project names don't
// end up on the dashboard.
export function sanitizeRepo(slug: string | undefined): string | undefined {
  if (!slug) return slug;
  const slash = slug.indexOf("/");
  if (slash === -1) {
    // No org component (git remote fallback to a single name) — hash the whole thing.
    return `ext/${createHash("sha256").update(slug).digest("hex").slice(0, 12)}`;
  }
  const org = slug.slice(0, slash);
  const repo = slug.slice(slash + 1);
  return `${org}/${createHash("sha256").update(repo).digest("hex").slice(0, 12)}`;
}

let Sentry: SentryModule = null;

if (!DISABLED) {
  try {
    Sentry = await import("@sentry/node");
  } catch {
    // @sentry/node not installed — telemetry disabled
  }
}

// Crash-capture plumbing (issue #154). `runStateActive` gates sampleMemory's
// per-sample writeRunState call so that unit-test invocations of
// sampleMemory (outside a real deploy) don't touch the user's state file.
// `relaunchOomHintShown` is set by `bin/bulletin-deploy` when it prints the
// OOM hint from a prior run; withDeploySpan then attaches it to the retry's
// deploy span so the hint landing can be tracked in Sentry.
let runStateActive = false;
let relaunchOomHintShown = false;

export function setRunStateActive(v: boolean): void {
  runStateActive = v;
}

export function markRelaunchOomHintShown(): void {
  relaunchOomHintShown = true;
}

// Awaitable Sentry flush-and-close. Exposed so the CLI signal handlers can
// await the flush before calling process.exit — fire-and-forget loses the
// trace when the process exits before the transport completes.
export async function closeTelemetry(timeoutMs: number): Promise<void> {
  if (!Sentry) return;
  try {
    await Sentry.close(timeoutMs);
  } catch {
    // Transport shutdown failures are non-fatal; we're about to exit anyway.
  }
}

export function initTelemetry(): void {
  if (!Sentry) return;
  // Ambient mode: a host app (e.g. playground-cli) has already called its
  // own Sentry.init(). Skip ours so we don't clobber the host's client.
  // All downstream instrumentation (withDeploySpan, captureWarning, etc.)
  // continues to use the global Sentry client the host set up.
  if (process.env.PAD_USE_AMBIENT_SENTRY === "1") {
    return;
  }
  const dsn = process.env.SENTRY_DSN || (typeof __SENTRY_DSN__ !== "undefined" ? __SENTRY_DSN__ : "");
  if (!dsn) return; // No DSN baked in (source build) and no override — skip telemetry
  Sentry.init({
    dsn,
    release: `${pkg.name}@${VERSION}`,
    tracesSampleRate: 1.0,
    environment: process.env.CI ? "ci" : "local",
    // Sentry Node SDK captures os.hostname() by default, which leaks personal
    // machine names (e.g. "Mac.fritz.box"). Override to something anonymous.
    serverName: process.env.CI ? (process.env.RUNNER_NAME ?? "ci") : "local",
    beforeSend(event) {
      if (event.server_name) event.server_name = process.env.CI ? (process.env.RUNNER_NAME ?? "ci") : "local";
      if (event.message) event.message = scrubPaths(event.message);
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = scrubPaths(ex.value);
      }
      for (const bc of event.breadcrumbs ?? []) {
        if (bc.message) bc.message = scrubPaths(bc.message);
      }
      return event;
    },
    beforeSendTransaction(event) {
      // Scrub span attributes that may carry paths (e.g. deploy.error).
      const spans = event.spans ?? [];
      for (const span of spans) {
        const attrs = span.data;
        if (!attrs) continue;
        for (const k of Object.keys(attrs)) {
          const v = attrs[k];
          if (typeof v === "string") attrs[k] = scrubPaths(v);
        }
      }
      return event;
    },
  });
  // `release` above is Sentry-internal release tracking; it doesn't show up as
  // a filterable tag in Discover or dashboard queries. setTag/setContext do,
  // and they attach to every event (transactions AND errors) — so wrappers or
  // consumer code that bypasses getDeployAttributes still surfaces the version.
  Sentry.setTag("bulletin-deploy.version", VERSION);
  Sentry.setContext("bulletin-deploy", {
    version: VERSION,
    release: `${pkg.name}@${VERSION}`,
    node: process.version,
  });
}


function tryPackageJsonRepo(): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"));
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    if (repo) return extractRepoSlug(repo);
  } catch {}
  return undefined;
}

export function resolveRepo(domain: string): string {
  return process.env.GITHUB_REPOSITORY || tryGitRemote() || tryPackageJsonRepo() || domain || "unknown";
}

function tryGitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch { return "unknown"; }
}

export function resolveRunner(): string {
  if (!process.env.CI) return "local";
  if (process.env.RUNNER_NAME?.startsWith("parity-")) return process.env.RUNNER_NAME;
  return process.env.RUNNER_NAME || "unknown";
}

export function resolveRunnerType(): string {
  if (!process.env.CI) return "local";
  if (process.env.RUNNER_NAME?.startsWith("parity-")) return "self-hosted";
  return "github-hosted";
}

// ── Static seed partials (issue #497) ────────────────────────────────────────
// Each partial owns one semantic domain. PRs that add a new attribute touch only
// their relevant partial — no cascading conflicts in a shared monolith.
// getDeployAttributes unions these with the computed-at-call-time attributes.
// IMPORTANT: each key must appear in exactly ONE partial (duplicates silently
// let the later spread win; run the completeness test in test.js after any change).

// Outcome ratio booleans: seeded "false" so every span forms the denominator for
// %SAD and %EXPECTED metrics. Catch block / captureWarning flip to "true".
const DEPLOY_SEED_OUTCOME: Record<string, string> = {
  "deploy.sad": "false",
  "deploy.expected": "false",
};

// RPC health: seeded "false" (boolean-both-values rule). Flipped by
// getWsProvider's onStatusChanged when papi connects to a non-primary endpoint.
const DEPLOY_SEED_RPC: Record<string, string> = {
  "deploy.rpc.failed_over": "false",
};

// DotNS / naming layer: balance gate flags + tx resolution kind + backend identity.
const DEPLOY_SEED_DOTNS: Record<string, string> = {
  // Preflight balance gate. Seeded "false" so successful spans form the denominator
  // for "% hitting the floor" and "% recovered via testnet auto-top-up". Flipped by gateOnFeeBalance.
  "deploy.dotns.signer_below_floor": "false",
  "deploy.dotns.toppedup": "false",
  // Seeded "hash" so spans for non-DotNS deploys group cleanly in the "hash" bucket.
  "deploy.dotns.tx_resolution_kind": "hash",
  // Backend identity (module constants — stable across calls).
  "deploy.dotns_backend": DOTNS_BACKEND,
  "deploy.dotns_pop_source": DOTNS_POP_SOURCE,
};

// Content-type booleans: seeded "false" so every span carries them for ratio queries.
const DEPLOY_SEED_CONTENT: Record<string, string> = {
  // Flipped by deploy.ts storage phase when content is encrypted.
  "deploy.encrypted": "false",
  // Flipped by deploy.ts after parseDomainName resolves isSubdomain.
  "deploy.subdomain": "false",
  // Flipped by deploy.ts after readPreviousContenthashSafe when a prior CID is found.
  "deploy.incremental": "false",
};

// Storage layer: phase A/B counters and probe metrics.
const DEPLOY_SEED_STORAGE: Record<string, string | number> = {
  // Seeded "false"; flipped by storeDirectoryV2 when Phase A root node is already on-chain.
  "deploy.storage.phase_a.root_already_onchain": "false",
  // Seeded 0; incremented per Phase B chunk confirmed on-chain (probe hit → skip re-upload).
  "deploy.storage.phase_b.probe_hit_count": 0,
  "deploy.phase_a.chunks_uploaded": 0,
  // Manifest-aware Phase A trust: count of section-1 CIDs trusted from prev manifest.
  "deploy.phase_a.chunks_trusted": 0,
};

// Probe / finality counters: seeded 0 so every span carries them.
const DEPLOY_SEED_PROBE: Record<string, number> = {
  "deploy.probe.finality_miss_count": 0,
  "deploy.probe.finality_miss_reupload_count": 0,
};

// Pool layer: eligible pool size + nonce-advance collision probe counters.
const DEPLOY_SEED_POOL: Record<string, number> = {
  "deploy.pool.eligible_count": 0,
  // Nonce-advance collision probe counters. Seeded 0 so every span carries them.
  "deploy.pool.nonce_collision_count": 0,
  "deploy.pool.nonce_collision_missing": 0,
  "deploy.pool.nonce_collision_reupload_count": 0,
};

// Manifest fetch outcome. Seeded so every span carries the attributes even when
// fetchPreviousManifest is never reached (first deploy, early error, non-incremental path).
// "none" + "0" form the denominator for ratio queries.
// String-valued per @sentry/node EAP numeric-attribute caveat (numbers come back null).
const DEPLOY_SEED_MANIFEST: Record<string, string> = {
  "deploy.manifest.fetch_source": "none",
  "deploy.manifest.fetch_attempts": "0",
  "deploy.manifest.bytes_downloaded": "0",
};

// Bulletin storage upload chain receipt (root-node tx, or last chunk when root skipped).
// Empty-string / 0 defaults so every span carries the attributes for filter queries.
const DEPLOY_SEED_BULLETIN_UPLOAD: Record<string, string | number> = {
  "bulletin.upload.tx_hash": "",
  "bulletin.upload.block_hash": "",
  "bulletin.upload.block_number": "",
};

// DotNS on-chain receipts: setContenthash, register (fresh registrations), setSubnodeOwner (subdomains).
const DEPLOY_SEED_RECEIPTS: Record<string, string | number> = {
  "deploy.contenthash.tx": "",
  "deploy.contenthash.block": "",
  "deploy.contenthash.block_hash": "",
  "deploy.register.tx": "",
  "deploy.register.block": "",
  "deploy.register.block_hash": "",
  "deploy.subnode.tx": "",
  "deploy.subnode.block": "",
  "deploy.subnode.block_hash": "",
};

// P2P retrieval liveness probe (issue #456). String-typed per @sentry/node EAP
// numeric-attribute caveat — numbers come back null from EAP regardless of emit type.
// "false"/"0"/"none" seed every span with the denominator values so ratio queries
// (e.g. count_if(deploy.p2p.retrievable, "true") / count()) work on all spans.
const DEPLOY_SEED_P2P: Record<string, string> = {
  "deploy.p2p.retrievable": "false",
  "deploy.p2p.check_ms": "0",
  "deploy.p2p.error_variant": "none",
};

export function getDeployAttributes(domain: string): Record<string, string | number | boolean | undefined> {
  const hostApp = process.env.PAD_HOST_APP;
  // Static seeds: spread all partials. Each PR that adds a new attribute touches
  // only its own partial → no cascading conflicts in a single shared literal.
  const attrs: Record<string, string | number | boolean | undefined> = {
    ...DEPLOY_SEED_OUTCOME,
    ...DEPLOY_SEED_RPC,
    ...DEPLOY_SEED_DOTNS,
    ...DEPLOY_SEED_CONTENT,
    ...DEPLOY_SEED_STORAGE,
    ...DEPLOY_SEED_PROBE,
    ...DEPLOY_SEED_POOL,
    ...DEPLOY_SEED_MANIFEST,
    ...DEPLOY_SEED_BULLETIN_UPLOAD,
    ...DEPLOY_SEED_RECEIPTS,
    ...DEPLOY_SEED_P2P,
    // Computed at call time (depend on domain arg, env vars, or external process calls):
    "deploy.repo": sanitizeRepo(resolveRepo(domain)),
    "deploy.branch": sanitizeBranch(process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || tryGitBranch()),
    "deploy.source": process.env.CI ? "ci" : "local",
    "deploy.pr": process.env.GITHUB_PR_NUMBER || undefined,
    "deploy.tool_version": VERSION,
    "deploy.runner": resolveRunner(),
    "deploy.runner_type": resolveRunnerType(),
  };
  if (hostApp) attrs["deploy.host_app"] = hostApp;
  const hostAppVersion = process.env.PAD_HOST_APP_VERSION;
  if (hostAppVersion) attrs["deploy.host_app_version"] = hostAppVersion;
  return attrs;
}

export function isExpectedError(msg: string): boolean {
  return /personhood|owned by|owner mismatch|reserved for original|invalid domain label|not authorized for bulletin|insufficient balance|insufficient funds|quota exhausted|insufficient .* authorization|bip39 mnemonic|ipfs cli not installed|base name is \d+ chars|NameNotAvailable|name must be lowercase/i.test(msg);
}

export type DeployErrorCategory = 'user' | 'environment' | 'internal' | 'unknown';

export function classifyDeployError(msg: string): DeployErrorCategory {
  if (isExpectedError(msg)) return 'user';
  if (/chunk.*failed after.*retr|tx dropped from best chain|timed out after \d+s waiting for block|Contract reverted|Contract execution would revert|dotns register failed|All promises were rejected|"type"\s*:\s*"Invalid"|Commitment still too new|not finalised after \d+s|chain may have (dropped|evicted)|ReviveApi.*timed out|ReviveApi.*returned empty result|\b(?:commit|register|setSubnodeOwner|setResolver|setContenthash|setText|publish|unpublish|Revive\.call|Utility\.batch_all) timed out after \d+ms|transaction watcher silent for/i.test(msg)) return 'environment';
  if (/javascript heap out of memory|allocation failed.*heap|External signer mode is not supported with dotns-cli/i.test(msg)) return 'internal';
  return 'unknown';
}

export function classifySadReason(message: string): string {
  if (/process terminated: SIG/i.test(message)) return 'killed';
  if (/memory threshold/i.test(message)) return 'memory';
  if (/spektr injection|account map failed/i.test(message)) return 'signer';
  if (/chunk upload failed|chunk retry failed/i.test(message)) return 'chain_storage';
  if (/websocket connection lost|rpc.*endpoint failed|rpc failover/i.test(message)) return 'rpc';
  return 'other';
}

export function computeDeployOutcome(
  errorCategory: DeployErrorCategory | null,
  isSad: boolean,
  sadReason: string,
): string {
  if (errorCategory === 'user') return 'user_error';
  if (errorCategory === 'environment') return 'env_error';
  if (errorCategory === 'internal') return 'internal_error';
  if (errorCategory === 'unknown') return 'unknown_error';
  if (isSad) return `sad_${sadReason}`;
  return 'clean';
}

// Fine-grained mechanism classification for `deploy.error_kind`. Orthogonal to
// `deploy.error_category` (which gives fault attribution: user/environment/internal/unknown).
// This classifies the failure *mechanism* so dashboards can group by root cause
// without parsing free-text messages.
//
// Values:
//   contract-revert                — Revive dry-run or dispatch returned revert (flags=1, data=0x or similar)
//   chain-timeout                  — tx or chain poll exceeded wall-clock or chain-time budget
//   nonce-stale                    — tx rejected due to stale/future nonce
//   connection                     — WS disconnect, heartbeat timeout, ChainHead disjointed
//   naming.pop_required            — label requires ProofOfPersonhoodFull but signer is NoStatus
//   naming.nostatus_required       — label requires NoStatus but signer has ProofOfPersonhood
//   naming.contract_unavailable    — DotNS contract ABI call returned zero data (contract not deployed or wrong address)
//   naming.already_owned           — domain is already owned by a different EVM address
//   naming.subdomain_orphan        — subdomain parent is owned by a different address
//   verify.contenthash_mismatch    — post-deploy on-chain contenthash differs from what was written
//   verify.dagpb_not_finalised     — DAG-PB root not finalised; chain may have dropped the extrinsic
//   network.recovery_exhausted     — retry budget exhausted after too many recovery attempts
//   account.mapping_pending        — EVM account auto-mapping submitted but not yet reflected on-chain
//   chain.api_timeout              — ReviveApi call timed out (EVM address resolution)
//   chain.tx_timeout               — outer per-op budget hit during signed-tx submission (commit / register / setSubnodeOwner / setResolver / setContenthash / setText / publish / unpublish / Revive.call / Utility.batch_all)
//   chain.tx_silent                — signSubmitAndWatch observable emitted no events for the no-progress threshold; watchdog tripped
//   chain.extrinsic_expired        — tx rejected because the mortality window passed (AncientBirthBlock)
//   chain.quota_exhausted          — Bulletin chain storage quota exhausted
//   signer.message_too_large       — mobile signer rejected the payload because it exceeds the signing size limit
//   tool.invariant                 — internal invariant assertion failed
//   unknown                        — none of the above patterns matched
export type DeployErrorKind =
  | 'contract-revert'
  | 'chain-timeout'
  | 'nonce-stale'
  | 'connection'
  | 'naming.pop_required'
  | 'naming.nostatus_required'
  | 'naming.contract_unavailable'
  | 'naming.already_owned'
  | 'naming.subdomain_orphan'
  | 'verify.contenthash_mismatch'
  | 'verify.dagpb_not_finalised'
  | 'network.recovery_exhausted'
  | 'account.mapping_pending'
  | 'chain.api_timeout'
  // outer per-op budget hit during signed-tx submission (commit / register / setSubnodeOwner / setResolver / setContenthash / setText / publish / unpublish / Revive.call / Utility.batch_all)
  | 'chain.tx_timeout'
  // signSubmitAndWatch observable emitted no events for the no-progress threshold; watchdog tripped
  | 'chain.tx_silent'
  | 'chain.extrinsic_expired'
  | 'chain.quota_exhausted'
  | 'signer.message_too_large'
  | 'tool.invariant'
  | 'unknown';

// Precedence-ordered list of (regex, kind) tuples. First match wins.
// Strong-signal infra kinds first, then naming, then verify, then network/chain, then tool.
const ERROR_KIND_RULES: Array<[RegExp, DeployErrorKind]> = [
  [/Contract reverted|Contract execution would revert|revert(?:ed|ing)?\s*\(flags=[0-9]+\)/i, 'contract-revert'],
  [/timed out after \d+s waiting for block|Transaction not included after \d+s|Transaction did not settle within/i, 'chain-timeout'],
  [/\bstale\b.*nonce|nonce.*\bstale\b|"type"\s*:\s*"(?:Future|Stale)"|Invalid::Future|tx rejected by pool/i, 'nonce-stale'],
  [/heartbeat timeout|WS halt|Unable to connect|ChainHead disjointed|websocket.*closed|socket closed|disconnect/i, 'connection'],
  [/requires ProofOfPersonhood(?:Full|Lite|Light),\s*but this signer is NoStatus/i, 'naming.pop_required'],
  [/requires NoStatus,\s*but this signer is ProofOfPersonhood/i, 'naming.nostatus_required'],
  [/Cannot decode zero data.*with ABI parameters/i, 'naming.contract_unavailable'],
  [/Domain\s+\S+\.dot\s+is already owned by\s+0x[a-fA-F0-9]+/i, 'naming.already_owned'],
  [/Cannot deploy\s+[\w.-]+\.dot:\s*parent\s+[\w.-]+\.dot\s+is owned by/i, 'naming.subdomain_orphan'],
  [/Post-deploy verification failed for .+: on-chain contenthash is /i, 'verify.contenthash_mismatch'],
  [/Deploy verification failed:\s*DAG-PB root.+not finalised/i, 'verify.dagpb_not_finalised'],
  [/Retry budget exhausted:.*recovery attempts/i, 'network.recovery_exhausted'],
  [/Account auto-mapping did not take effect on-chain/i, 'account.mapping_pending'],
  [/ReviveApi\.\w+ timed out after \d+ms/i, 'chain.api_timeout'],
  [/ReviveApi\.\w+ returned empty result/i, 'chain.api_timeout'],
  [/transaction watcher silent for \d+s/i, 'chain.tx_silent'],
  [/(?:commit|register|setSubnodeOwner|setResolver|setContenthash|setText|publish|unpublish|Revive\.call|Utility\.batch_all) timed out after \d+ms/i, 'chain.tx_timeout'],
  [/AncientBirthBlock/i, 'chain.extrinsic_expired'],
  [/Bulletin quota exhausted/i, 'chain.quota_exhausted'],
  [/Mobile signing (?:failed|rejected).*message too big/i, 'signer.message_too_large'],
  [/^INVARIANT FAILED:/i, 'tool.invariant'],
];

export function classifyErrorKind(msg: string): DeployErrorKind {
  for (const [re, kind] of ERROR_KIND_RULES) {
    if (re.test(msg)) return kind;
  }
  return 'unknown';
}

// Sanitize an error message before attaching it to a Sentry span attribute.
// Truncates first (before scrubbing) so regexes run on at most 500 chars.
// Strips absolute paths (beforeSendTransaction already does this for the final
// event, but we apply it eagerly here so intermediate child spans are clean too).
// Does NOT attempt to strip mnemonics — chain-op errors don't interpolate key
// material (the mnemonic is consumed by deriveRootSigner, not thrown).
export function sanitizeErrorMessage(msg: string): string {
  return scrubPaths(msg.slice(0, 500));
}

/**
 * Classify an error message's *shape* (length, presence of certain patterns)
 * without excerpting content. The result is a comma-joined list of tags;
 * future analysis of scrubbed events will use this to identify which content
 * shape triggered Sentry's PII scrubber, so we can build a real sanitiser.
 */
export function analyseErrorPattern(msg: string): string {
  const tags: string[] = [];
  const len = msg.length;
  // Length buckets — useful even when the body is fully redacted.
  if (len < 50) tags.push("len:lt50");
  else if (len < 100) tags.push("len:50-99");
  else if (len < 200) tags.push("len:100-199");
  else if (len < 500) tags.push("len:200-499");
  else tags.push("len:gte500");
  // URL with userinfo (typical credentials-in-URL).
  if (/[a-z]+:\/\/[^\s:/?#]+:[^\s@/?#]+@/i.test(msg)) tags.push("url-userinfo");
  // Long hex sequences NOT prefixed 0xe30 (the cid prefix for IPFS-CIDv1 dag-pb / dag-cbor)
  // and NOT 40-char (EVM address hex body length).
  const longHexRuns = (msg.match(/[0-9a-fA-F]{40,}/g) ?? [])
    .filter(h => !h.toLowerCase().startsWith("e30") && h.length !== 40);
  if (longHexRuns.length > 0) tags.push(`long-hex:${Math.min(longHexRuns.length, 9)}`);
  // Base64-ish runs (≥ 30 contiguous chars in the [A-Za-z0-9+/=] set, with mixed case).
  const b64ish = msg.match(/[A-Za-z0-9+/=]{30,}/g) ?? [];
  if (b64ish.some(s => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s))) tags.push("base64ish");
  // JWT shape (3 base64url segments separated by dots).
  if (/\b[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/.test(msg)) tags.push("jwt-shape");
  // Hex-EVM-address count (length 42 including 0x prefix).
  const evmCount = (msg.match(/0x[a-fA-F0-9]{40}\b/g) ?? []).length;
  if (evmCount > 0) tags.push(`evm:${Math.min(evmCount, 9)}`);
  // Substrate SS58 address (rough): base58 alphabet, 46-49 chars, starts with 1-5.
  if (/\b[1-9A-HJ-NP-Za-km-z]{46,49}\b/.test(msg)) tags.push("ss58-shape");
  // Embedded mnemonic (12 or 24 words separated by single spaces, all lowercase letters).
  if (/(?:\b[a-z]{3,8}\s){11,23}\b[a-z]{3,8}\b/.test(msg)) tags.push("mnemonic-shape");
  return tags.join(",");
}

export async function withSpan<T>(op: string, description: string, attributes: Record<string, string | number | boolean | undefined>, fn: () => T | Promise<T>): Promise<T> {
  if (!Sentry) return fn();
  return Sentry.startSpan({ op, name: description, attributes }, async (span) => {
    try {
      return await fn();
    } catch (error) {
      const msg = (error as Error).message ?? String(error);
      span.setAttribute("error.message", msg);
      span.setAttribute("deploy.error_kind", classifyErrorKind(msg));
      span.setAttribute("deploy.error_message", sanitizeErrorMessage(msg));
      span.setAttribute("deploy.error_pattern_signature", analyseErrorPattern(msg));
      span.setStatus({ code: 2, message: "internal_error" });
      throw error;
    }
  });
}

// Raw-byte peaks for the current deploy. Rounded to MB only at flush so
// rounding doesn't accumulate across Math.max calls. Module-scoped because
// the CLI runs one deploy per Node process; if bulletin-deploy ever gets
// imported as a library with concurrent deploys, migrate to AsyncLocalStorage.
interface RawMemorySample {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

let memoryPeak: RawMemorySample | null = null;
// Direct handle to the current deploy's root span. Captured inside
// withDeploySpan so sampleMemory can write `deploy.mem.peak_*` onto the
// span even after nested withSpan callbacks have ended (getRootSpan +
// getActiveSpan round-trip through Sentry's scope stack turned out to be
// unreliable for attributes set late in the deploy lifecycle).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let deployRootSpan: any | null = null;
// Per-stage memory snapshots kept alongside the peak. Flushed to the
// threshold-triggered memory report (memory-report.ts) if the deploy
// exceeded the threshold AND we're in an internal context.
let stageSamples: Record<string, MemorySampleMb> = {};
// Best-effort context enrichment the caller can inject before the deploy
// ends (e.g. the build directory so the report file lands next to dump).
let reportContext: Partial<DeployContextForReport> & { outputDir?: string } = {};

// Outcome trackers — reset by withDeploySpan, updated by captureWarning / catch block.
let currentErrorCategory: DeployErrorCategory | null = null;
let currentDeploySad = false;
let currentSadReason = 'other';
let currentSadReasonPriority = 0;

const SAD_REASON_PRIORITY: Record<string, number> = {
  killed: 5, memory: 4, signer: 3, chain_storage: 2, rpc: 1, other: 0,
};

function toMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

// Record a memory sample on the active span (labelled by `stage`) and roll
// running peaks onto the captured deploy span. Peaks are written on every
// sample rather than only in a final block so early exits still get a valid
// snapshot. No-op when telemetry is disabled.
export function sampleMemory(stage: string): void {
  if (!Sentry) return;
  const m = process.memoryUsage();
  const active = Sentry.getActiveSpan();
  if (process.env.PAD_MEM_DEBUG) {
    console.error(`[sampleMemory] stage=${stage} active=${active ? (active as any).description ?? (active as any).name ?? "?" : "null"} rss=${toMb(m.rss)}MB`);
  }
  // Send raw bytes as numbers. Sentry EAP requires numeric typing for
  // max()/p95() aggregates and rejects strings; the prior stringified-MB
  // cast was a workaround for an older Discover behaviour that no longer
  // applies. The `_bytes` suffix lets Sentry's UI render MB/GB automatically.
  if (active) {
    active.setAttribute(`mem.${stage}.rss_bytes`, m.rss);
    active.setAttribute(`mem.${stage}.heap_used_bytes`, m.heapUsed);
    active.setAttribute(`mem.${stage}.external_bytes`, m.external);
    active.setAttribute(`mem.${stage}.array_buffers_bytes`, m.arrayBuffers);
  }
  stageSamples[stage] = sampleFromBytes(m);
  if (memoryPeak) {
    if (m.rss > memoryPeak.rss) memoryPeak.rss = m.rss;
    if (m.heapUsed > memoryPeak.heapUsed) memoryPeak.heapUsed = m.heapUsed;
    if (m.external > memoryPeak.external) memoryPeak.external = m.external;
    if (m.arrayBuffers > memoryPeak.arrayBuffers) memoryPeak.arrayBuffers = m.arrayBuffers;
    if (deployRootSpan) {
      // String-typed MB: @sentry/node user attrs come back as null in EAP when
      // sent as numbers, so we emit MB strings and use count_if/has for filtering.
      deployRootSpan.setAttribute("deploy.mem.peak_rss_mb", String(toMb(memoryPeak.rss)));
      deployRootSpan.setAttribute("deploy.mem.peak_heap_used_mb", String(toMb(memoryPeak.heapUsed)));
      deployRootSpan.setAttribute("deploy.mem.peak_external_mb", String(toMb(memoryPeak.external)));
      deployRootSpan.setAttribute("deploy.mem.peak_array_buffers_mb", String(toMb(memoryPeak.arrayBuffers)));
    }
  }
  // Persist to the on-disk run-state so a future SIGKILL-relaunch can hint
  // NODE_OPTIONS. Guarded by `runStateActive` so sampleMemory calls outside
  // a real deploy (unit tests) don't touch the user's state file.
  if (runStateActive && memoryPeak) {
    try {
      writeRunState({ lastPeakRssMb: toMb(memoryPeak.rss), lastStage: stage });
    } catch {
      // writeRunState already swallows fs errors; belt-and-braces.
    }
  }
}

export async function withDeploySpan<T>(domain: string, fn: () => T | Promise<T>): Promise<T> {
  if (!Sentry) return fn();
  const attrs: Record<string, string | number | boolean | undefined> = { ...getDeployAttributes(domain), "deploy.domain": domain };
  const m0 = process.memoryUsage();
  memoryPeak = { rss: m0.rss, heapUsed: m0.heapUsed, external: m0.external, arrayBuffers: m0.arrayBuffers };
  stageSamples = {};
  reportContext = {};
  currentErrorCategory = null;
  currentDeploySad = false;
  currentSadReason = 'other';
  currentSadReasonPriority = 0;
  const deployStartMs = Date.now();
  try {
    return await Sentry.startSpan({ op: "deploy", name: `deploy ${domain}`, attributes: attrs }, async (span) => {
      deployRootSpan = span;
      // Redundant with the getDeployAttributes() seed — kept so wrapper code
      // that overrides `attrs` can't accidentally drop the tool version.
      span.setAttribute("deploy.tool_version", VERSION);
      // If the PREVIOUS run's bin printed an OOM hint (via
      // markRelaunchOomHintShown), record that on THIS run's deploy span so
      // the Sentry dashboard can track how often the hint actually leads to
      // a successful retry.
      if (relaunchOomHintShown) {
        span.setAttribute("deploy.relaunch.oom_hint_shown", "true");
      }
      const tagsToSet: Record<string, string> = {
        "deploy.repo": attrs["deploy.repo"] as string,
        "deploy.branch": attrs["deploy.branch"] as string,
        "deploy.domain": domain,
        "deploy.source": attrs["deploy.source"] as string,
        "deploy.tool_version": VERSION,
        "deploy.runner_type": resolveRunnerType(),
        "deploy.host_app": (attrs["deploy.host_app"] as string | undefined) ?? "",
      };
      // Drop the tag when unset so dashboards can use has:deploy.host_app as a discriminator.
      if (!tagsToSet["deploy.host_app"]) delete tagsToSet["deploy.host_app"];
      Sentry!.setTags(tagsToSet);
      try {
        const result = await fn();
        span.setAttribute("deploy.status", "ok");
        return result;
      } catch (error) {
        const msg = (error as Error).message ?? String(error);
        span.setAttribute("deploy.status", "error");
        span.setAttribute("deploy.error", msg.slice(0, 500));
        const errorCategory = classifyDeployError(msg);
        span.setAttribute("deploy.error_category", errorCategory);
        // Mechanism classification (how it failed, not whose fault).
        // Propagated from the leaf chain-op span up to the root deploy span so
        // dashboards can group by deploy.error_kind without drilling into child spans.
        span.setAttribute("deploy.error_kind", classifyErrorKind(msg));
        span.setAttribute("deploy.error_message", sanitizeErrorMessage(msg));
        span.setAttribute("deploy.error_pattern_signature", analyseErrorPattern(msg));
        currentErrorCategory = errorCategory;
        // Expected refusals (owned-by, reserved label, insufficient balance…)
        // are product rules, not tool friction: keep sad="false" so dashboards
        // filtering `deploy.sad:true` (and `NOT deploy.expected:true` on error
        // widgets) reflect the tool's health, not the user's typing. A later
        // captureWarning during the refusal flow will still flip sad back to
        // "true" — intentional, friction during a refusal is still friction.
        const isExpected = isExpectedError(msg);
        span.setAttribute("deploy.expected", isExpected ? "true" : "false");
        span.setAttribute("deploy.sad", isExpected ? "false" : "true");
        if (!isExpected) {
          span.setStatus({ code: 2, message: "internal_error" });
        }
        throw error;
      } finally {
        // sampleMemory folds the "end" point into the running peak and writes
        // deploy.mem.peak_* via the captured deployRootSpan reference.
        sampleMemory("end");
        span.setAttribute("deploy.outcome",
          computeDeployOutcome(currentErrorCategory, currentDeploySad, currentSadReason));
        // Threshold-triggered diagnostic bundle (memory-report.ts). No-op
        // for external users — heap introspection is for us.
        if (memoryPeak) {
          try {
            const report = maybeWriteMemoryReport({
              peak: sampleFromBytes(memoryPeak),
              stages: stageSamples,
              deploy: {
                domain,
                repo: attrs["deploy.repo"] as string | undefined,
                deployTag: attrs["deploy.tag"] as string | undefined,
                durationMs: Date.now() - deployStartMs,
                sentryTraceId: (span as { spanContext?: () => { traceId?: string } }).spanContext?.().traceId,
                ...reportContext,
              },
              outputDir: reportContext.outputDir,
              onSentryAttach: (r: MemoryReport) => {
                try {
                  Sentry!.captureMessage(`deploy memory threshold crossed (${r.threshold.peakRssMb} MB)`, {
                    level: "warning",
                    tags: { "deploy.mem.report": "1" },
                    extra: { memoryReport: r },
                  });
                } catch { /* telemetry must never break the deploy */ }
              },
            });
            if (report.status === "written") {
              span.setAttribute("deploy.mem.report_written", "true");
              span.setAttribute("deploy.mem.report_path", report.path as string);
              console.log(`\n   High memory usage detected (peak ${report.peakRssMb} MB, threshold ${report.thresholdMb} MB).`);
              console.log(`   Diagnostic report written to ${report.path}`);
            }
          } catch (e: unknown) {
            // Memory-report is diagnostic; must never interrupt a deploy. Any throw is logged and swallowed.
            captureWarning("maybeWriteMemoryReport threw", {
              error: (e as Error)?.message?.slice(0, 200),
            });
          }
        }
      }
    });
  } finally {
    memoryPeak = null;
    deployRootSpan = null;
    stageSamples = {};
    reportContext = {};
    currentErrorCategory = null;
    currentDeploySad = false;
    currentSadReason = 'other';
    currentSadReasonPriority = 0;
    try { await Sentry.flush(5000); } catch { /* telemetry must never break the deploy */ }
  }
}

// Optional enrichment callers can add before the deploy ends so the memory
// report carries deploy-specific fields (chunk count, CAR bytes, etc). No-op
// outside of a deploy span. Additive — later calls merge over earlier ones.
export function setDeployReportContext(patch: Partial<DeployContextForReport> & { outputDir?: string }): void {
  reportContext = { ...reportContext, ...patch };
}

export function setDeployAttribute(key: string, value: string | number | boolean): void {
  if (!deployRootSpan) return;
  deployRootSpan.setAttribute(key, value);
}

// @internal — test hook: injects a fake root span so unit tests can assert
// that setDeployAttribute (and sampleMemory) write to the root span, not the
// active child span.  Named with __ prefix to match the __assignDenseNoncesForTest
// convention already used in deploy.ts.
export function __setDeployRootSpanForTest(span: any | null): void {
  deployRootSpan = span;
}

// @internal — test hook: replaces the module-private Sentry instance so unit
// tests can inject a stub transport without relying on ESM namespace tricks.
// Returns the previous value so callers can restore it in a finally block.
export function __setSentryForTest(stub: any): SentryModule {
  const prev = Sentry;
  Sentry = stub;
  return prev;
}

// Trace ID of the active Sentry span, or undefined when telemetry is off or
// called outside a span. Used by the bug-report body so issue filers can hop
// straight to the Sentry trace.
export function getCurrentSentryTraceId(): string | undefined {
  if (!Sentry) return undefined;
  const span = Sentry.getActiveSpan();
  if (!span) return undefined;
  return (span as { spanContext?: () => { traceId?: string } }).spanContext?.().traceId;
}

// Promote a deploy attribute to a Sentry scope tag so child events
// (captureWarning, captureException) carry it too. Span attributes live on
// the span itself and aren't searchable on the Errors dataset; tags are.
// Use for attributes you want to filter dashboards by on BOTH spans and
// errors — e.g. deploy.tag for the E2E Health dashboard.
export function setDeploySentryTag(key: string, value: string): void {
  if (!Sentry) return;
  Sentry.setTag(key, value);
}

/**
 * Mark a code path as exercised in the current deploy span.
 * Used for dead-branch coverage monitoring — see src/code-paths.ts.
 *
 * Design: each path gets its own boolean attribute `code.path.<id>` = "true"
 * rather than a single `code.path` attribute. This avoids the overwrite problem
 * — a single deploy span that exercises multiple branches would otherwise only
 * record the last one. Boolean-per-path lets Sentry query `has:code.path.pool.auth.v2`
 * independently for each path.
 *
 * Note: @sentry/node user-defined attributes come back as string-typed in EAP
 * regardless of value type. Store as the string "true" so queries using
 * `count_if(code.path.pool.auth.v2, "true")` or `has:code.path.pool.auth.v2`
 * both work correctly.
 *
 * No-ops gracefully if called outside a deploy span (setDeployAttribute guards
 * on deployRootSpan — see setDeployAttribute implementation above).
 */
export function markCodePath(id: CodePath): void {
  setDeployAttribute(`code.path.${id}`, "true");
}

export function captureWarning(message: string, context?: Record<string, unknown>): void {
  if (!Sentry) return;
  try {
    Sentry.addBreadcrumb({ level: "warning", message, data: context });
    Sentry.captureMessage(message, { level: "warning", extra: context });
    if (deployRootSpan) deployRootSpan.setAttribute("deploy.sad", "true");
    const reason = classifySadReason(message);
    const priority = SAD_REASON_PRIORITY[reason] ?? 0;
    if (priority >= currentSadReasonPriority) {
      currentSadReason = reason;
      currentSadReasonPriority = priority;
    }
    currentDeploySad = true;
  } catch { /* telemetry must never break the deploy */ }
}

export async function flush(): Promise<void> {
  if (!Sentry) return;
  try { await Sentry.flush(5000); } catch { /* telemetry must never break the deploy */ }
}
