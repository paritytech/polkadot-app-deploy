/**
 * logout — sign out the current session.
 *
 * Flow: findSession() → null → "no session" ; else waitForLogout()
 */

import type { LogoutStatus } from "../auth/index.js";
import { getAuthClient } from "../auth-config.js";
import { renderLogoutStatus } from "../auth/index.js";
import { clearSssAllowanceCache } from "../sss-allowance-cache.js";

/**
 * Format a logout status line. Pure function, unit-testable.
 */
export function formatLogout(status: LogoutStatus): string {
    return renderLogoutStatus(status);
}

/**
 * Run the logout command. Finds the current session and signs out.
 */
export async function runLogout(envId: string): Promise<void> {
    const client = await getAuthClient(envId);
    try {
        const handle = await client.findSession();
        if (!handle) {
            console.log("Not logged in. No session to sign out.");
            return;
        }
        await client.waitForLogout(handle, (status) => {
            console.log(formatLogout(status));
        });
    } finally {
        // clearLocalAppStorage already called inside waitForLogout on success;
        // belt-and-suspenders cleanup on the error path.
        try {
            await client.clearLocalAppStorage();
        } catch {
            // best-effort
        }
        // Drop our same-period SSS allowance cache too (erase-on-logout). It's
        // account-keyed so a stale entry is harmless, but clearing keeps logout
        // a clean slate.
        await clearSssAllowanceCache();
    }
}
