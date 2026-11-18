/**
 * whoami — show the currently logged-in session account, or "not logged in".
 * Pure formatter `formatWhoami` is unit-tested; `runWhoami` is the live async path.
 */

import type { SessionAddresses } from "../auth/index.js";
import { getAuthClient, hasPersistedSession, STALE_SESSION_MESSAGE } from "../auth-config.js";
import type { Stack } from "../stacks.js";
import { CLI_NAME } from "../cli-name.js";
import { NonRetryableError } from "../errors.js";

/**
 * Format session address info for display. Pass `null` when no session exists.
 * Pure function — unit-testable without any SSO stack.
 */
export function formatWhoami(addresses: SessionAddresses | null): string {
    if (!addresses) {
        return `Not logged in. Run \`${CLI_NAME} login\` to sign in.`;
    }
    return [
        `Logged in:`,
        `  Root address:    ${addresses.rootAddress}`,
        `  Product address: ${addresses.productAddress}`,
        `  H160 (EVM):      ${addresses.productH160}`,
    ].join("\n");
}

/**
 * Run the whoami command. Gets the session signer (if any) and prints the
 * formatted output. Without a session file it prints the not-logged-in message
 * without calling `loadStack`; otherwise it fails only when the stack does not load.
 */
export async function runWhoami(loadStack: () => Promise<Stack>): Promise<void> {
    if (!hasPersistedSession()) {
        console.log(formatWhoami(null));
        return;
    }
    const stack = await loadStack();
    try {
        const client = await getAuthClient(stack);
        const handle = await client.getSessionSigner();
        if (handle) {
            console.log(formatWhoami(handle.addresses));
            handle.destroy();
        } else {
            // Session file exists but the adapter found no usable session — the blob is
            // likely stale (written by v0.7, incompatible with the V2 codec). Guide the
            // user through re-pairing instead of silently printing "Not logged in".
            console.error(STALE_SESSION_MESSAGE);
        }
    } catch (err: unknown) {
        const e = err as { name?: string; message?: string } | null;
        if (e?.name === "SignerNotAvailableError") {
            // Expected: session file exists but no usable signer — treat as stale.
            console.error(STALE_SESSION_MESSAGE);
        } else if (err instanceof NonRetryableError) {
            // The phone did not return this stack's account key.
            console.error(err.message);
        } else {
            // Unexpected error (WS failure, People chain unavailable, etc.).
            console.log(`Could not reach login service: ${e?.message ?? String(err)}`);
            console.log(formatWhoami(null));
        }
    }
}
