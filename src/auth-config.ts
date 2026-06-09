/**
 * Auth configuration builder for the sign-in integration.
 *
 * Identity is unified under one id: DOT_DAPP_ID === DOT_PRODUCT_ID === DOT_HOST_NAME
 * === "polkadot-app-deploy". The wallet pairs, funds PGAS, and keys all allowances
 * (Bulletin / statement-store / smart-contract) under this single id, and the product
 * account the deploy signer derives from (`product/{id}/{index}`) lives there too —
 * so one identity covers pairing, allowances, and the signing/owning account.
 */

import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadEnvironments } from "./environments.js";
import type { EnvironmentsDoc } from "./environments.js";
import type { AuthConfig } from "./auth/index.js";
import { VERSION } from "./telemetry.js";
import { CLI_NAME } from "./cli-name.js";

/** dApp identity: scopes the SSO session namespace + terminal allowance cache on disk
 *  and the wallet pairing product. Aligned to the app's dedicated id "polkadot-app-deploy". */
export const DOT_DAPP_ID = "polkadot-app-deploy";

/** Product id used for product-account derivation (`/product/{productId}/{index}`).
 *  UNIFIED with DOT_DAPP_ID (#885): the wallet funds PGAS to product/{appId}/{index},
 *  so deriving the signer/owner under the same id lands the account where PGAS sits —
 *  one account is owner + AH signer + PGAS-funded. Requires a fresh re-pairing so the
 *  Bulletin/statement allowance is also claimed under this id (verify the wallet serves
 *  "polkadot-app-deploy"; that's the open mobile-side question). */
export const DOT_PRODUCT_ID = DOT_DAPP_ID;

/** Derivation index (0 = default product account). */
export const DOT_DERIVATION_INDEX = 0;

/** Wallet-facing app name shown on the Sign-In screen. Aligned to the unified identity. */
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

    return {
        dappId: DOT_DAPP_ID,
        productId: DOT_PRODUCT_ID,
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
 * Lazily create an auth client for the given environment. Imports the facade
 * only when called so the SSO deps don't load in headless/mnemonic paths.
 */
export async function getAuthClient(envId: string) {
    const { createAuthClient } = await import("./auth/index.js");
    const { doc } = await loadEnvironments();
    return createAuthClient(buildAuthConfig(doc, envId));
}
