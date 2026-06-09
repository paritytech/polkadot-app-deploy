/**
 * Conservative same-period cache for the SSS allowance preflight.
 *
 * The SSS allowance is a 1-day-period resource on the People chain (period =
 * floor(unix_secs / 86_400), UTC-midnight-aligned) plus a chain-side grace
 * window (~2 days, `StmtStoreGraceWindow`). The on-chain value carries NO
 * expiry — expiry is enforced by *pruning* the key at period rollover + grace.
 *
 * We cannot read an authoritative expiry (unlike Bulletin, which stores one),
 * and we must not bake the grace constant into the CLI (it lives in someone
 * else's runtime and already changed once, in people PR #1022). But one fact is
 * stable and safe: an allowance confirmed present during the current period
 * CANNOT be pruned before the period ends (grace only extends validity beyond
 * that). So "valid until the end of the current period" (next UTC midnight) is
 * a STRICT lower bound — it deliberately discards the volatile grace, so it can
 * never over-estimate even if the grace constant changes again.
 *
 * Within that window we skip the (sub-second) People-chain read; after it we
 * fall through to the authoritative `checkSSSAllowance`. The cache is keyed by
 * the statement-signing account so a different session never reads a stale hit.
 *
 * Clock skew: for a fresh grant (claimed this period, valid through +2 days of
 * grace) the period boundary has ~2 days of slack, so skew is immaterial. The
 * one tight case is the oldest still-valid grant — claimed two periods ago, it
 * expires exactly at our boundary — where a local clock running behind chain
 * time gives a skew-sized over-estimate. That residual is covered by the
 * sessionSigner `NoAllowanceError` fast-fail backstop, not by this cache.
 *
 * The marker lives next to the bulletin slot cache (`~/.polkadot-apps`).
 */

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DOT_DAPP_ID } from "./auth-config.js";
import { checkSSSAllowance } from "./sss-allowance.js";

const SECONDS_PER_DAY = 86_400;
// Filename mirrors the bulletin slot cache (`<appId>_AllowanceKeys*`) — derive
// the appId from the single source of truth so both caches follow a rename.
const CACHE_FILE = `${DOT_DAPP_ID}_SssAllowanceCheck.json`;

/**
 * End of the current SSS 1-day allowance period, in unix seconds. Equals the
 * next UTC-midnight boundary. An allowance present in the current period is
 * valid at least until this instant (grace extends it further), so it is a
 * safe lower bound for skipping the chain read.
 */
export function sssPeriodEndSec(nowSec: number): number {
    return (Math.floor(nowSec / SECONDS_PER_DAY) + 1) * SECONDS_PER_DAY;
}

function cacheFilePath(storageDir?: string): string {
    return join(storageDir ?? homedir(), ".polkadot-apps", CACHE_FILE);
}

function accountHex(account: Uint8Array): string {
    return Buffer.from(account).toString("hex");
}

/**
 * True when a cached confirmation says THIS account's allowance is valid for
 * the current period — letting the preflight skip the chain read. Conservative:
 * only trusts the cache within the granting period. Any read/parse error or
 * account mismatch → false (fall through to the authoritative check).
 */
export async function isSssAllowanceCacheValid(
    account: Uint8Array,
    nowSec: number = Math.floor(Date.now() / 1000),
    storageDir?: string,
): Promise<boolean> {
    try {
        const raw = await readFile(cacheFilePath(storageDir), "utf-8");
        const cached = JSON.parse(raw) as { account?: string; validUntilSec?: number };
        return (
            cached.account === accountHex(account) &&
            typeof cached.validUntilSec === "number" &&
            nowSec < cached.validUntilSec
        );
    } catch {
        return false;
    }
}

/**
 * Record that THIS account's allowance was confirmed present on-chain; valid
 * (conservatively) until the end of the current 1-day period. Best-effort — a
 * write failure just means the next deploy re-reads the chain.
 */
export async function writeSssAllowanceCache(
    account: Uint8Array,
    nowSec: number = Math.floor(Date.now() / 1000),
    storageDir?: string,
): Promise<void> {
    const payload = JSON.stringify({
        account: accountHex(account),
        validUntilSec: sssPeriodEndSec(nowSec),
    });
    const path = cacheFilePath(storageDir);
    try {
        // Match the bulletin slot cache (storage-signer.ts): ensure the dir
        // exists, else a fresh machine silently no-ops the cache write.
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, payload, "utf-8");
    } catch {
        /* best-effort cache; ignore */
    }
}

/**
 * Drop the cached confirmation (e.g. when the chain reports the allowance is
 * gone) so the next preflight re-reads the chain rather than trusting a hit.
 */
export async function clearSssAllowanceCache(storageDir?: string): Promise<void> {
    try {
        await unlink(cacheFilePath(storageDir));
    } catch {
        /* already absent */
    }
}

/**
 * Cached SSS allowance preflight, shared by the deploy and login paths.
 *
 *   `true`  — allowance present (same-period cache hit, or chain-confirmed and
 *             cache refreshed)
 *   `false` — chain-confirmed absent/expired (cache cleared); caller should
 *             surface the "run logout/login" guidance
 *   `null`  — no statement account, or People chain unreachable → don't block
 *
 * On a cache hit it skips BOTH the chain read and the endpoint resolution, so
 * `getPeopleEndpoints` is a thunk evaluated only on a miss.
 */
export async function preflightSssAllowance(
    account: Uint8Array | null,
    getPeopleEndpoints: () => Promise<string[]>,
): Promise<boolean | null> {
    if (!account) return null;
    if (await isSssAllowanceCacheValid(account)) return true;
    const allowed = await checkSSSAllowance(account, await getPeopleEndpoints());
    if (allowed === true) await writeSssAllowanceCache(account);
    else if (allowed === false) await clearSssAllowanceCache();
    return allowed;
}
