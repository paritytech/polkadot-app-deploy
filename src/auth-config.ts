/**
 * Auth configuration builder for the sign-in integration.
 *
 * DOT_DAPP_ID scopes the session files on disk. The product id is
 * `polkadot-app-deploy.<network suffix>` (RFC-0022): the wallet derives the
 * signing account `//product//{productId}/{index}` from it, funds PGAS there,
 * and keys the Bulletin / statement-store allowances by it. Android only
 * answers for a product id whose suffix matches its People chain's
 * `NetworkSuffix`.
 */

import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadEnvironments } from "./environments.js";
import type { EnvironmentsDoc } from "./environments.js";
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
 * Build an `AuthConfig` from the bundled environments document.
 *
 * Reads the People-parachain endpoint for `envId` and assembles the config that
 * `createAuthClient` needs. Throws with a clear message if the people chain or
 * its endpoint for `envId` is absent.
 */
export function buildAuthConfig(
    doc: EnvironmentsDoc,
    envId: string,
    networkSuffix?: string | null,
): AuthConfig {
    const peopleChain = doc.chains.find((c) => c.id === "people");
    if (!peopleChain) {
        throw new Error(
            `No "people" chain found in environments doc. ` +
            `Add a "people" entry under "chains" in environments.json.`,
        );
    }
    const endpoint = peopleChain.endpoints[envId];
    if (!endpoint) {
        throw new Error(
            `No people-chain endpoint for environment "${envId}". ` +
            `Available envs: ${Object.keys(peopleChain.endpoints).join(", ")}.`,
        );
    }
    // Normalize string | string[] to string[]
    const peopleEndpoints = Array.isArray(endpoint.wss) ? endpoint.wss : [endpoint.wss];

    // Envs without a `tld` use the People chain's suffix if the caller read it,
    // else "dot", the same default as DEFAULT_TLD in src/dotns.ts.
    const tld = doc.environments.find((e) => e.id === envId)?.tld ?? networkSuffix ?? "dot";

    return {
        dappId: DOT_DAPP_ID,
        productId: `${DOT_DAPP_ID}.${tld}`,
        derivationIndex: DOT_DERIVATION_INDEX,
        hostName: DOT_HOST_NAME,
        hostVersion: VERSION,
        peopleEndpoints,
    };
}

/**
 * Resolve the Bulletin chain WS endpoint(s) for an environment from the
 * environments doc. Mirrors buildAuthConfig's people-chain resolution.
 *
 * Login needs this because src/deploy.ts only reassigns its module-level
 * BULLETIN_ENDPOINTS (initialized to DEFAULT_BULLETIN_RPC = the paseo-next
 * chain) to the selected env's endpoint inside the deploy flow. The login path
 * never runs that, so without resolving here it would poll the default chain
 * instead of the selected env's (e.g. paseo-next-v2 on paseo-bulletin-next-rpc)
 * and never observe an authorization that lives on the selected chain.
 *
 * Returns null if the bulletin chain or its endpoint for envId is absent.
 */
export function resolveBulletinEndpoints(
    doc: EnvironmentsDoc,
    envId: string,
): string[] | null {
    const bulletinChain = doc.chains.find((c) => c.id === "bulletin");
    const endpoint = bulletinChain?.endpoints[envId];
    if (!endpoint) return null;
    return Array.isArray(endpoint.wss) ? endpoint.wss : [endpoint.wss];
}

/**
 * Return the People chain WSS endpoints for the given environment.
 * Used by the SSS allowance preflight check — no SSO deps loaded.
 */
export async function getPeopleChainEndpoints(envId: string): Promise<string[]> {
    const { doc } = await loadEnvironments();
    const config = buildAuthConfig(doc, envId);
    return config.peopleEndpoints;
}

/**
 * The People chain's `NetworkSuffix`, which the phone checks the product id
 * against. Null when the chain has none or the read fails.
 */
export async function readNetworkSuffix(peopleEndpoints: string[]): Promise<string | null> {
    const { Storage, str } = await import("@polkadot-api/substrate-bindings");
    const { readStorageValue } = await import("./sss-allowance.js");
    const value = await readStorageValue(Storage("NetworkSuffix")("NetworkSuffix").enc(), peopleEndpoints);
    if (!value) return null;
    try {
        return str.dec(value) || null;
    } catch {
        return null;
    }
}

/**
 * Lazily create an auth client for the given environment. Imports the facade
 * only when called so the SSO deps don't load in headless/mnemonic paths.
 */
export async function getAuthClient(envId: string) {
    const { createAuthClient } = await import("./auth/index.js");
    const { doc } = await loadEnvironments();
    const config = buildAuthConfig(doc, envId);
    // Bundled tlds match their chain's suffix (test/auth-config.test.js), so only
    // envs without one, like devnet, pay for the chain read.
    if (doc.environments.find((e) => e.id === envId)?.tld) return createAuthClient(config);
    return createAuthClient(buildAuthConfig(doc, envId, await readNetworkSuffix(config.peopleEndpoints)));
}
