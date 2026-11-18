/**
 * Auth configuration builder for the sign-in integration.
 *
 * DOT_DAPP_ID scopes the session files on disk. The product id is
 * `polkadot-app-deploy.<tld>` (RFC-0022), with the stack descriptor's `tld`:
 * the wallet derives the signing account `//product//{productId}/{index}` from
 * it, funds PGAS there, and keys the Bulletin / statement-store allowances by
 * it. Android only answers for a product id whose suffix matches its People
 * chain's `NetworkSuffix`.
 */

import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Stack } from "./stacks.js";
import { Storage, str } from "@polkadot-api/substrate-bindings";
import { connectChainClient } from "./genesis.js";
import { NonRetryableError } from "./errors.js";
import type { AuthConfig } from "./auth/index.js";
import { VERSION } from "./telemetry.js";
import { CLI_NAME } from "./cli-name.js";

/** Scopes the SSO session files on disk and prefixes the per-env product ids. */
export const DOT_DAPP_ID = "polkadot-app-deploy";

/** Derivation index (0 = default product account). */
export const DOT_DERIVATION_INDEX = 0;

/** Wallet-facing app name shown on the Sign-In screen. */
export const DOT_HOST_NAME = "polkadot-app-deploy";

/**
 * Shown when a persisted session file exists but the V2 codec cannot decode it —
 * typically a v0.7 SCALE blob that is structurally incompatible with the V2 wire format.
 * The adapter silently returns [] in this case; we surface the cause and recovery steps.
 */
export const STALE_SESSION_MESSAGE =
    'Stored login session could not be read — it may have been written by an older version. ' +
    `Run "${CLI_NAME} logout", then "${CLI_NAME} login" to pair again.`;

/**
 * Deploy-specific variant of STALE_SESSION_MESSAGE. See src/deploy-actors.ts's
 * resolveDeployActors for the full rationale (issue #234) — in short, `deploy`
 * has a remedy `whoami` doesn't: an explicit `--mnemonic` / `MNEMONIC` signer,
 * which wins even when the persisted session can't be read. Naming it here
 * means the fail-fast error doesn't just point at re-pairing.
 */
export const STALE_SESSION_DEPLOY_MESSAGE =
    `${STALE_SESSION_MESSAGE} Or pass --mnemonic explicitly to sign with a different key.`;

/**
 * Returns true if there is a persisted SSO session file on disk.
 * Does NOT load the SSO stack — uses only node fs/os/path.
 * Safe to call from headless/pool paths.
 */
export function hasPersistedSession(): boolean {
    // host-papp's session filename is version-suffixed and has changed across
    // SDK releases (0.8.5 `_SsoSessions.json` → 0.8.6 `_SsoSessionsV2.json`).
    // Match the prefix so this fs probe survives the SDK renaming its file.
    const dir = join(homedir(), ".polkadot-apps");
    if (!existsSync(dir)) return false;
    const prefix = `${DOT_DAPP_ID}_SsoSessions`;
    try {
        return readdirSync(dir).some((f) => f.startsWith(prefix) && f.endsWith(".json"));
    } catch {
        return false;
    }
}

/**
 * The `AuthConfig` `createAuthClient` needs for `stack`: its People endpoints, and the
 * product id `polkadot-app-deploy.<tld>` the wallet derives the signing account from.
 */
export function buildAuthConfig(stack: Pick<Stack, "chains" | "tld">): AuthConfig {
    return {
        dappId: DOT_DAPP_ID,
        productId: `${DOT_DAPP_ID}.${stack.tld}`,
        derivationIndex: DOT_DERIVATION_INDEX,
        hostName: DOT_HOST_NAME,
        hostVersion: VERSION,
        peopleEndpoints: stack.chains.People.rpc,
    };
}

/**
 * Lazily create an auth client for `stack` without reading any chain. Imports the facade only
 * when called so the SSO deps don't load in headless/mnemonic paths.
 */
export async function getAuthClient(stack: Stack) {
    const { createAuthClient } = await import("./auth/index.js");
    return createAuthClient(buildAuthConfig(stack));
}

/**
 * Fails when `stack`'s People chain has another genesis hash, or a `NetworkSuffix` other than
 * `stack.tld`: the wallet rejects a product id with another suffix.
 */
export async function assertPeopleMatchesStack(stack: Stack): Promise<void> {
    // Lazy: dotns.js loads the DotNS deps, which logout and whoami don't use.
    const { WS_HEARTBEAT_TIMEOUT_MS } = await import("./dotns.js");
    const client = await connectChainClient(stack, "People", undefined, {
        heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS,
    });
    let suffix: string | null;
    try {
        const value: string | null = await client._request("state_getStorage", [
            Storage("NetworkSuffix")("NetworkSuffix").enc(),
        ]);
        suffix = value && value !== "0x" ? str.dec(value) || null : null;
    } finally {
        client.destroy();
    }
    if (suffix !== null && suffix !== stack.tld) {
        throw new NonRetryableError(
            `stack '${stack.id}' has tld '${stack.tld}', but its People chain's NetworkSuffix is '${suffix}'`,
        );
    }
}
