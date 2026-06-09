// Fetch the embedded manifest from a previous deploy.
//
// Priority order (gateway-first, see plan 2026-05-21-manifest-fetch-gateway-pivot.md):
//   1. Persistent local cache at ~/.cache/bulletin-deploy/manifests/ (survives rebuilds).
//   2. IPFS gateway tier ladder (range-request, falls through to full-body if needed).
//   3. Heuristic fallback: caller proceeds with lossier file classification.
//
// Root cause of the manifest-fetch flakiness: assets/environments.json correctly declares
// env.ipfs per environment (e.g. paseo-bulletin-next-ipfs.polkadot.io for paseo-next-v2),
// but resolveEndpoints() in src/environments.ts was silently dropping the field. Every
// deploy fell back to the hardcoded DEFAULT_GATEWAY pointing at the wrong gateway.
// Fixing the propagation (Task 2 of 2026-05-21 gateway-pivot plan) is the real fix.
// The gateway tier ladder + patience-pattern timeouts here provide the reliability layer.

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as Sentry from "@sentry/node";
import { CarReader } from "@ipld/car/reader";
import * as dagPB from "@ipld/dag-pb";
import { CID } from "multiformats/cid";
import { parseManifest, type EmbeddedManifest, MANIFEST_DIR, MANIFEST_FILENAME } from "./manifest.js";

// No DEFAULT_GATEWAY constant — caller must provide a gateway URL (typically
// from environments.ts's resolveEndpoints().ipfs, threaded through
// storeDirectoryV2's opts.gateway). Without a gateway, fetchPreviousManifest
// short-circuits to heuristic_fallback rather than silently hitting a
// hardcoded URL pointing at the wrong environment.
// Per-tier timeout — patience pattern matching dotli/polkadot-desktop.
// Was 5s historically; that turned out to be too short when the gateway
// was hitting back-pressure. dotli polls indefinitely at 10s interval;
// for a CLI tool we cap at ~90s total (30s × 3 tiers).
export const DEFAULT_TIMEOUT_MS = 30_000;

// SIDECAR_FILENAME kept for any external callers reading old sidecar files;
// bulletin-deploy itself no longer writes or reads this file.
export const SIDECAR_FILENAME = ".last_deploy_cid";

const RANGE_TIERS: (string | undefined)[] = [
  "bytes=0-4095",
  "bytes=0-65535",
  "bytes=0-1048575",
  undefined, // full body
];

export type FetchOutcome =
  | { source: "embedded"; manifest: EmbeddedManifest; attempts: number; bytesDownloaded?: number }
  | { source: "heuristic_fallback"; reason: string; attempts: number; bytesDownloaded?: number }
  | { source: "none" };

export interface FetchOptions {
  gateway?: string;
  gateways?: string[];
  timeoutMs?: number;
  domain?: string;
  buildDir?: string;  // (kept for backwards compat — no longer read)
  /**
   * Injectable chain client for the chain-storage tier. When provided,
   * fetchPreviousManifest attempts to read the previous manifest directly
   * from the bulletin chain via bitswap_v1_get, before falling through to
   * the IPFS gateway. Accepts any object exposing `_request(method, params)`.
   *
   * The bitswap_v1_get request shape `(cid: string) => unknown` is confirmed
   * present on the bulletin chain (per #456 live E2E). The **response payload
   * shape** (hex string vs Uint8Array vs other) is NOT yet exercised in a
   * round-trip test — normalizeBitswapBytes handles the known candidates
   * defensively, but a live verification against a stored CID is still needed.
   * The PR flags this explicitly.
   */
  chainClient?: { _request: (method: string, params: unknown[]) => Promise<unknown> };
}

// Categorical outcome for a single tier attempt. Surfaced on the
// `manifest.fetch.tier` span so traces show exactly what each tier did.
// "retryable" outcomes (timeout, network_error, http_NNN, car_truncated,
// manifest_not_in_slice, body_read_error on partial-slice tiers) cause the loop to widen.
// All other outcomes are terminal for the gateway.
export type TierOutcome =
  | "timeout"
  | "network_error"
  | `http_${number}`
  | "body_read_error"          // retryable on partial-slice tiers; terminal on full-body tier
  | "car_truncated"            // partial slice didn't contain full manifest — widen
  | "manifest_not_in_slice"    // same — widen
  | "car_parse_error"          // full-body CAR is unparseable
  | "manifest_missing"         // full-body CAR has no .bulletin-deploy/manifest.json
  | "manifest_parse_error"
  | "success";

type TierAttempt = {
  outcome: TierOutcome;
  reason: string;
  bytes: number;
  manifest?: EmbeddedManifest;
};

type TierResult =
  | { outcome: "success"; manifest: EmbeddedManifest; attempts: number; bytesDownloaded: number }
  | { outcome: "404"; attempts: number; bytesDownloaded: number }
  | { outcome: "parse_error"; reason: string; attempts: number; bytesDownloaded: number }
  | { outcome: "retryable"; reason: string; attempts: number; bytesDownloaded: number };

// ───────────────────────────── Persistent local cache ───────────────────────

// Returns the cache dir for persistent manifest storage. Returns null on
// Windows (cache silently disabled). Honors PAD_CACHE_DIR env var
// (for CI runners that don't write to $HOME) and XDG_CACHE_HOME (Linux convention).
export function getCacheDir(): string | null {
  const override = process.env.PAD_CACHE_DIR;
  if (override) return path.join(override, "manifests");
  if (process.platform === "win32") return null;
  // Honor XDG_CACHE_HOME (Linux convention), fall back to ~/.cache.
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return path.join(xdg, "bulletin-deploy", "manifests");
  return path.join(os.homedir(), ".cache", "bulletin-deploy", "manifests");
}

// Read persistent local manifest. Returns null on any miss (no domain, no
// cache dir, missing files, CID mismatch, parse error).
export function readPersistentLocalManifest(
  domain: string | undefined,
  prevContenthash: string
): FetchOutcome | null {
  if (!domain) return null;
  const cacheDir = getCacheDir();
  if (!cacheDir) return null;

  const cidPath = path.join(cacheDir, `${domain}.cid`);
  const manifestPath = path.join(cacheDir, `${domain}.json`);

  let storedCid: string;
  try {
    storedCid = fs.readFileSync(cidPath, "utf8").trim();
  } catch { return null; }
  if (storedCid !== prevContenthash) return null;

  let text: string;
  try {
    text = fs.readFileSync(manifestPath, "utf8");
  } catch { return null; }

  const parsed = parseManifest(text);
  if (!parsed.ok) return null;

  return {
    source: "embedded",
    manifest: parsed.manifest,
    attempts: 0,
    bytesDownloaded: text.length,
  };
}

// Write persistent local manifest. Best-effort — failures don't propagate.
// Uses PID-suffixed temp files for atomic writes to avoid concurrent-deploy
// collisions — matches the pattern in src/run-state.ts:writeRunState.
export function writePersistentLocalManifest(
  domain: string,
  storageCid: string,
  manifestJson: string
): void {
  const cacheDir = getCacheDir();
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const cidPath = path.join(cacheDir, `${domain}.cid`);
    const manifestPath = path.join(cacheDir, `${domain}.json`);
    // Use PID-suffixed temp files to avoid concurrent-deploy collisions —
    // matches the pattern in src/run-state.ts:writeRunState.
    const cidTmp = `${cidPath}.${process.pid}.tmp`;
    const manifestTmp = `${manifestPath}.${process.pid}.tmp`;
    fs.writeFileSync(cidTmp, storageCid);
    fs.renameSync(cidTmp, cidPath);
    fs.writeFileSync(manifestTmp, manifestJson);
    fs.renameSync(manifestTmp, manifestPath);
  } catch { /* best-effort */ }
}

// ───────────────────────────── Gateway tier ladder ─────────────────────────

// Attempt one range tier against the given URL. Wrapped in its own Sentry span
// so the trace shows exactly what each tier did and why it failed.
//
// Span op: `manifest.fetch.tier`
// Span name: `tier <N> <range>` e.g. "tier 0 0-4095"
//
// Attributes (all String-typed — @sentry/node EAP constraint):
//   manifest.tier.index        — "0"–"3"
//   manifest.tier.range        — "0-4095" | "0-65535" | "0-1048575" | "full"
//   manifest.tier.outcome      — TierOutcome string
//   manifest.tier.http_status  — HTTP status, e.g. "206"; "" if no response
//   manifest.tier.bytes        — body bytes received, "0" if none
//   manifest.tier.wait_ms      — ms from fetch() call to response headers
//   manifest.tier.read_ms      — ms to read body after headers (0 if not reached)
//   manifest.tier.error        — error message on non-success; "" on success
async function fetchOneTier(url: string, tierIndex: number, budgetRemaining: number): Promise<TierAttempt> {
  const rangeHeader = RANGE_TIERS[tierIndex];
  const rangeLabel = rangeHeader != null ? rangeHeader.replace("bytes=", "") : "full";
  const isFullBody = rangeHeader === undefined;

  return Sentry.startSpan(
    { op: "manifest.fetch.tier", name: `tier ${tierIndex} ${rangeLabel}` },
    async (span) => {
      span.setAttribute("manifest.tier.index", String(tierIndex));
      span.setAttribute("manifest.tier.range", rangeLabel);
      span.setAttribute("manifest.tier.http_status", "");
      span.setAttribute("manifest.tier.bytes", "0");
      span.setAttribute("manifest.tier.wait_ms", "0");
      span.setAttribute("manifest.tier.read_ms", "0");
      span.setAttribute("manifest.tier.error", "");

      const headers: Record<string, string> = {};
      if (rangeHeader !== undefined) headers.Range = rangeHeader;

      // ── HTTP request ──────────────────────────────────────────────────────
      let res: Response;
      const fetchStart = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), Math.max(100, budgetRemaining));
        try { res = await fetch(url, { headers, signal: ctrl.signal }); }
        finally { clearTimeout(timer); }
      } catch (e: any) {
        const isAbort = e?.name === "AbortError";
        const outcome: TierOutcome = isAbort ? "timeout" : "network_error";
        const msg: string = e?.message ?? String(e);
        span.setAttribute("manifest.tier.outcome", outcome);
        span.setAttribute("manifest.tier.wait_ms", String(Date.now() - fetchStart));
        span.setAttribute("manifest.tier.error", msg);
        return { outcome, reason: `${outcome}: ${msg}`, bytes: 0 };
      }

      const waitMs = Date.now() - fetchStart;
      span.setAttribute("manifest.tier.wait_ms", String(waitMs));
      span.setAttribute("manifest.tier.http_status", String(res.status));

      if (res.status === 404) {
        span.setAttribute("manifest.tier.outcome", "http_404");
        return { outcome: "http_404" as TierOutcome, reason: "gateway 404", bytes: 0 };
      }
      if (res.status !== 200 && res.status !== 206) {
        const outcome = `http_${res.status}` as TierOutcome;
        span.setAttribute("manifest.tier.outcome", outcome);
        span.setAttribute("manifest.tier.error", `HTTP ${res.status}`);
        return { outcome, reason: `gateway HTTP ${res.status}`, bytes: 0 };
      }

      // ── Body read ─────────────────────────────────────────────────────────
      let carBytes: Uint8Array;
      const readStart = Date.now();
      try {
        const buf = await res.arrayBuffer();
        carBytes = new Uint8Array(buf);
        span.setAttribute("manifest.tier.bytes", String(carBytes.length));
        span.setAttribute("manifest.tier.read_ms", String(Date.now() - readStart));
      } catch (e: any) {
        span.setAttribute("manifest.tier.read_ms", String(Date.now() - readStart));
        const msg = `body read error: ${e?.message ?? e}`;
        span.setAttribute("manifest.tier.outcome", "body_read_error");
        span.setAttribute("manifest.tier.error", msg);
        return { outcome: "body_read_error", reason: msg, bytes: 0 };
      }

      // ── CAR parse ─────────────────────────────────────────────────────────
      let manifestBytes: Uint8Array | null;
      try { manifestBytes = await extractManifestFromCar(carBytes); }
      catch (e: any) {
        const msg = `CAR parse error: ${e?.message ?? e}`;
        const outcome: TierOutcome = isFullBody ? "car_parse_error" : "car_truncated";
        span.setAttribute("manifest.tier.outcome", outcome);
        span.setAttribute("manifest.tier.error", msg);
        return { outcome, reason: msg, bytes: carBytes.length };
      }

      if (!manifestBytes) {
        const outcome: TierOutcome = isFullBody ? "manifest_missing" : "manifest_not_in_slice";
        const msg = isFullBody
          ? "no .bulletin-deploy/manifest.json in deployed DAG"
          : `manifest not in slice tier ${tierIndex}`;
        span.setAttribute("manifest.tier.outcome", outcome);
        span.setAttribute("manifest.tier.error", msg);
        return { outcome, reason: msg, bytes: carBytes.length };
      }

      // ── Manifest parse ────────────────────────────────────────────────────
      const text = new TextDecoder().decode(manifestBytes);
      const parsed = parseManifest(text);
      if (parsed.ok) {
        span.setAttribute("manifest.tier.outcome", "success");
        return { outcome: "success", reason: "", bytes: carBytes.length, manifest: parsed.manifest };
      }
      span.setAttribute("manifest.tier.outcome", "manifest_parse_error");
      span.setAttribute("manifest.tier.error", parsed.error);
      return { outcome: "manifest_parse_error", reason: parsed.error, bytes: carBytes.length };
    }
  );
}

async function fetchAcrossTiers(url: string, budget: number, start: number): Promise<TierResult> {
  let lastReason = "unknown";
  let attempts = 0;
  let bytesDownloaded = 0;

  for (let tier = 0; tier < RANGE_TIERS.length; tier++) {
    const elapsed = Date.now() - start;
    if (elapsed > budget) {
      return { outcome: "retryable", reason: `budget exceeded: ${lastReason}`, attempts, bytesDownloaded };
    }

    attempts++;
    const result = await fetchOneTier(url, tier, budget - elapsed);
    bytesDownloaded += result.bytes;

    if (result.outcome === "success") {
      return { outcome: "success", manifest: result.manifest!, attempts, bytesDownloaded };
    }
    if (result.outcome === "http_404") {
      return { outcome: "404", attempts, bytesDownloaded };
    }
    // Terminal parse failures — full-body tier confirmed the content is unreadable.
    if (
      result.outcome === "car_parse_error" ||
      result.outcome === "manifest_missing" ||
      result.outcome === "manifest_parse_error"
    ) {
      return { outcome: "parse_error", reason: result.reason, attempts, bytesDownloaded };
    }
    // body_read_error on a full-body tier is terminal; on a partial-slice tier,
    // widen range and retry (the gateway may have aborted the small slice).
    if (result.outcome === "body_read_error" && tier === RANGE_TIERS.length - 1) {
      return { outcome: "parse_error", reason: result.reason, attempts, bytesDownloaded };
    }
    // Retryable: timeout, network_error, http_NNN, car_truncated, manifest_not_in_slice,
    // body_read_error on partial-slice tiers
    lastReason = result.reason;
  }
  return { outcome: "retryable", reason: `tiers exhausted: ${lastReason}`, attempts, bytesDownloaded };
}

// ───────────────────────────── Chain-storage tier ──────────────────────────

// Per-call timeout for bitswap_v1_get. #456 E2E measured ~600ms round-trips;
// 5s is generous headroom while avoiding a ~90s stall (3 calls × 30s) when
// the RPC is degraded. The caller always falls through to the IPFS gateway on
// any timeout, so this is a latency budget, not a correctness gate.
export const CHAIN_TIER_TIMEOUT_MS = 5_000;

// Defensive normalizer for the `bitswap_v1_get` response payload.
//
// The request shape `client._request("bitswap_v1_get", [cidString])` is
// confirmed present on the bulletin chain (PR #456 live E2E). The **response
// payload shape and the full live round-trip** (root node retrievable, link
// structure, chunk retrieval) are NOT yet exercised in a real chain call —
// only the request signature is confirmed. The most likely payload forms are:
//   1. Hex string `"0x..."` — matches the pattern used by other substrate RPCs
//   2. Raw Uint8Array  — if papi decodes before returning
//   3. number[] / Array<number> — JSON-deserialized bytes
//
// Throws if the value cannot be coerced to Uint8Array.
export function normalizeBitswapBytes(response: unknown): Uint8Array {
  if (response instanceof Uint8Array) return response;
  if (typeof response === "string") {
    const hex = response.startsWith("0x") ? response.slice(2) : response;
    if (hex.length % 2 !== 0) throw new Error(`bitswap_v1_get: odd-length hex response (${hex.length} chars)`);
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (Array.isArray(response) && response.every((x) => typeof x === "number")) {
    return new Uint8Array(response as number[]);
  }
  if (response instanceof ArrayBuffer) return new Uint8Array(response);
  throw new Error(`bitswap_v1_get: unexpected response type ${typeof response}`);
}

// Fetch a single block by CID from the chain via bitswap_v1_get.
// Returns the raw block bytes on success, or throws on error/timeout.
async function chainGet(
  client: { _request: (method: string, params: unknown[]) => Promise<unknown> },
  cid: string,
  timeoutMs: number
): Promise<Uint8Array> {
  const timeoutError = new Error(`bitswap_v1_get timeout after ${timeoutMs}ms`);
  const response = await Promise.race([
    client._request("bitswap_v1_get", [cid]),
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(timeoutError), timeoutMs);
      if (typeof t === "object" && t !== null && typeof (t as any).unref === "function") {
        (t as any).unref();
      }
    }),
  ]);
  return normalizeBitswapBytes(response);
}

// Try to reconstruct and parse the manifest from the chain-storage tier.
//
// Flow (mirrors the gateway's CAR-based approach but via bitswap):
//  1. Fetch root block → dagPB-decode → read unnamed links (chunk CIDs in order).
//  2. Fetch chunk[0] bytes → try extractManifestFromCar on just that chunk.
//  3. If truncated/null, fetch chunk[1] (if present) → concat [0]+[1] → retry.
//  4. On success return the manifest; on any unrecoverable failure return null
//     so the caller falls through to the IPFS gateway.
//
// The root CID (`prevContenthash`) is a UnixFS "file" dag-pb node whose Links
// are the ordered chunk CIDs (Name=""). The gateway tier fetches the whole file
// reassembled; bitswap returns blocks individually. We reassemble manually.
//
// Known limitation: fetches chunk[0] + chunk[1] only. CARs that span more
// than 2 chunks (>~4 MB deploys) fall through to the IPFS gateway since the
// directory root block may not appear in the first two chunks. This covers the
// common case (manifest section + small sites) — large sites fall back gracefully.
//
// OPEN: the full live round-trip (root node retrievable, link structure, chunk
// retrieval, payload encoding) is NOT yet verified against a real chain CID —
// only the request signature `_request("bitswap_v1_get", [cid])` is confirmed
// (PR #456 live E2E). normalizeBitswapBytes handles known payload candidates
// defensively. See PR body for the explicit caveat.
export async function fetchManifestFromChain(
  client: { _request: (method: string, params: unknown[]) => Promise<unknown> },
  rootCid: string,
  timeoutMs: number
): Promise<Uint8Array | null> {
  // Step 1: fetch root block and extract chunk CID list.
  let rootBytes: Uint8Array;
  try {
    rootBytes = await chainGet(client, rootCid, timeoutMs);
  } catch {
    return null; // chain unavailable / not found — fall through to gateway
  }

  let chunkCids: string[];
  try {
    const rootNode = dagPB.decode(rootBytes);
    chunkCids = (rootNode.Links ?? []).map((l) => l.Hash.toString());
  } catch {
    return null; // not a dag-pb node — unexpected format
  }
  if (chunkCids.length === 0) return null;

  // Step 2: fetch chunk[0], try to parse manifest.
  let chunk0: Uint8Array;
  try {
    chunk0 = await chainGet(client, chunkCids[0], timeoutMs);
  } catch {
    return null;
  }

  let manifestBytes: Uint8Array | null;
  try {
    manifestBytes = await extractManifestFromCar(chunk0);
    if (manifestBytes) return manifestBytes;
  } catch {
    // car_truncated — widen to chunk[0]+chunk[1]
  }

  // Step 3: if chunk[0] alone doesn't cover section 0, widen to chunk[1].
  if (chunkCids.length < 2) return null;
  let chunk1: Uint8Array;
  try {
    chunk1 = await chainGet(client, chunkCids[1], timeoutMs);
  } catch {
    return null;
  }

  const combined = new Uint8Array(chunk0.length + chunk1.length);
  combined.set(chunk0, 0);
  combined.set(chunk1, chunk0.length);

  try {
    manifestBytes = await extractManifestFromCar(combined);
    return manifestBytes ?? null;
  } catch {
    return null;
  }
}

// ───────────────────────────── Public API ──────────────────────────────────

export async function fetchPreviousManifest(
  prevContenthash: string | null,
  options: FetchOptions = {}
): Promise<FetchOutcome> {
  if (prevContenthash === null) return { source: "none" };

  // 1. Persistent local cache (zero network, fast).
  const local = readPersistentLocalManifest(options.domain, prevContenthash);
  if (local) return local;

  // 2. Chain-storage tier — content-addressed via bitswap_v1_get on the
  //    already-open bulletin RPC client. More reliable than the IPFS gateway
  //    (no external CDN dependency; serves from the chain's own block store).
  //    Falls through to the gateway on any failure — never terminal.
  //
  //    OPEN: bitswap_v1_get response payload shape (hex vs Uint8Array) is not
  //    yet verified in a live round-trip — see normalizeBitswapBytes + PR body.
  if (options.chainClient) {
    // Per-call timeout intentionally shorter than the gateway budget —
    // a fast miss is better than a 30s stall when the RPC is degraded.
    const chainTimeoutMs = CHAIN_TIER_TIMEOUT_MS;
    const chainManifestBytes = await Sentry.startSpan(
      { op: "manifest.fetch.chain", name: `manifest chain ${prevContenthash.slice(0, 12)}` },
      async (span) => {
        span.setAttribute("manifest.chain.cid", prevContenthash.slice(0, 12));
        try {
          const bytes = await fetchManifestFromChain(options.chainClient!, prevContenthash, chainTimeoutMs);
          span.setAttribute("manifest.chain.outcome", bytes ? "success" : "miss");
          return bytes;
        } catch (e: any) {
          span.setAttribute("manifest.chain.outcome", "error");
          span.setAttribute("manifest.chain.error", e?.message ?? String(e));
          return null;
        }
      }
    );
    if (chainManifestBytes) {
      const text = new TextDecoder().decode(chainManifestBytes);
      const parsed = parseManifest(text);
      if (parsed.ok) {
        return {
          source: "embedded",
          manifest: parsed.manifest,
          attempts: 1,
          bytesDownloaded: chainManifestBytes.length,
        };
      }
    }
    // chain miss or parse failure — fall through to gateway
  }

  // 3. IPFS gateway tier ladder — each gateway gets a `manifest.fetch` parent
  //    span; each range attempt inside it gets a `manifest.fetch.tier` child span.
  const gatewayList = (options.gateways ?? (options.gateway ? [options.gateway] : []))
    .map((g) => g.replace(/\/$/, ""));
  const budget = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  let lastReason = "unknown";
  let totalAttempts = 0;
  let bytesDownloaded = 0;

  for (const gatewayRaw of gatewayList) {
    // Normalise: gateway URLs in environments.json sometimes include a
    // trailing /ipfs or /ipfs/ (paseo-next, preview); other envs don't
    // (paseo-next-v2). Strip it so we always produce `<base>/ipfs/<cid>`
    // exactly once, matching dotli/desktop's convention.
    const gateway = gatewayRaw.replace(/\/ipfs\/?$/, "");
    const url = `${gateway}/ipfs/${prevContenthash}`;
    const gatewayStart = Date.now();

    // Parent span groups all tier attempts for one gateway. Attributes capture
    // the gateway URL and final outcome so you can filter without opening children.
    //
    // Span op: `manifest.fetch`
    // Attributes:
    //   manifest.fetch.gateway    — normalised gateway base URL
    //   manifest.fetch.cid        — first 12 chars of CID
    //   manifest.fetch.budget_ms  — total budget in ms
    //   manifest.fetch.outcome    — final TierResult outcome
    //   manifest.fetch.attempts   — tier attempts made
    //   manifest.fetch.bytes      — total bytes downloaded
    //   manifest.fetch.elapsed_ms — wall time for this gateway only (not cumulative)
    const tierResult = await Sentry.startSpan(
      {
        op: "manifest.fetch",
        name: `manifest fetch ${prevContenthash.slice(0, 12)}`,
        attributes: {
          "manifest.fetch.gateway": gateway,
          "manifest.fetch.cid": prevContenthash.slice(0, 12),
          "manifest.fetch.budget_ms": String(budget),
        },
      },
      async (span) => {
        const result = await fetchAcrossTiers(url, budget, start);
        span.setAttribute("manifest.fetch.outcome", result.outcome);
        span.setAttribute("manifest.fetch.attempts", String(result.attempts));
        span.setAttribute("manifest.fetch.bytes", String(result.bytesDownloaded));
        span.setAttribute("manifest.fetch.elapsed_ms", String(Date.now() - gatewayStart));
        return result;
      }
    );

    if (tierResult.outcome === "success") {
      return {
        source: "embedded",
        manifest: tierResult.manifest,
        attempts: totalAttempts + tierResult.attempts,
        bytesDownloaded: bytesDownloaded + tierResult.bytesDownloaded,
      };
    }
    if (tierResult.outcome === "404" || tierResult.outcome === "parse_error") {
      return {
        source: "heuristic_fallback",
        reason: tierResult.outcome === "404" ? "gateway 404" : tierResult.reason,
        attempts: totalAttempts + tierResult.attempts,
        bytesDownloaded: bytesDownloaded + tierResult.bytesDownloaded,
      };
    }
    lastReason = tierResult.reason;
    totalAttempts += tierResult.attempts;
    bytesDownloaded += tierResult.bytesDownloaded;
  }
  return { source: "heuristic_fallback", reason: `all gateways exhausted: ${lastReason}`, attempts: totalAttempts, bytesDownloaded };
}

// ───────────────────────────── DAG helpers ─────────────────────────────────

// CAR-input wrapper: parse CAR bytes, populate blocks map, walk.
// Returns null if the manifest isn't in the DAG (legitimate fallback path) or
// throws on CAR parse failure (caller treats as heuristic_fallback too).
export async function extractManifestFromCar(carBytes: Uint8Array): Promise<Uint8Array | null> {
  const reader = await CarReader.fromBytes(carBytes);
  const roots = await reader.getRoots();
  if (roots.length === 0) return null;

  const blocks = new Map<string, Uint8Array>();
  for await (const { cid, bytes } of reader.blocks()) {
    blocks.set(cid.toString(), bytes);
  }

  return walkDagToManifest(blocks, roots[0].toString());
}

// Walk a CID-keyed blocks map to find the manifest leaf bytes.
// Returns null if the manifest isn't in the DAG.
//
// Walks two levels: root directory → `.bulletin-deploy` directory → `manifest.json`.
// Handles single-block raw leaves and multi-block dag-pb files for the manifest.
//
// Used by extractManifestFromCar (CAR input).
export async function walkDagToManifest(
  blocks: Map<string, Uint8Array>,
  rootCid: string
): Promise<Uint8Array | null> {
  const rootBytes = blocks.get(rootCid);
  if (!rootBytes) return null;
  const rootNode = dagPB.decode(rootBytes);
  const bdLink = (rootNode.Links ?? []).find((l) => l.Name === MANIFEST_DIR);
  if (!bdLink) return null;

  const bdBytes = blocks.get(bdLink.Hash.toString());
  if (!bdBytes) return null;
  const bdNode = dagPB.decode(bdBytes);
  const manLink = (bdNode.Links ?? []).find((l) => l.Name === MANIFEST_FILENAME);
  if (!manLink) return null;

  const manCidStr = manLink.Hash.toString();
  const manCid = CID.parse(manCidStr);
  const manBytes = blocks.get(manCidStr);
  if (!manBytes) return null;

  if (manCid.code === 0x55) {
    return manBytes; // single-block raw leaf
  }
  if (manCid.code === 0x70) {
    // Multi-block UnixFS file — concatenate leaves in link order.
    const node = dagPB.decode(manBytes);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (const link of node.Links ?? []) {
      const leafBytes = blocks.get(link.Hash.toString());
      if (!leafBytes) return null;
      parts.push(leafBytes);
      total += leafBytes.length;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }
  return null;
}
