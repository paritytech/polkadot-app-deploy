/**
 * Statement Store (SSS) allowance preflight — pure storage read, no signing.
 *
 * The People chain stores SSS allowances under a deterministic key:
 *   b":statement_allowance:" ++ raw_32_byte_account_pubkey
 *
 * We can check this via a single `state_getStorage` RPC call — no transaction,
 * no phone dialog. Non-null, non-"0x" result means the allowance is present.
 *
 * The stored value is `(used_bytes: u32, max_bytes: u32)` (e.g. `(2, 512000)`)
 * — there is no expiry block in the value. Expiry is enforced chain-side by
 * *pruning* the key when the allowance lapses, so key-present ⇔ allowance valid
 * (and not expired). Verified empirically against paseo-next-v2 People.
 *
 * IMPORTANT — which account: the allowance belongs to the **statement-signing
 * account** (the session's `localAccount`), NOT the product account. The
 * product account signs on-chain extrinsics (DotNS records); it never writes
 * to the statement store and therefore never holds an SSS allowance (its key
 * is always null). The mobile-signing transport rides the statement store: the
 * terminal publishes Request statements signed by `localAccount`, so that is
 * the account the chain grants the allowance to at login. Use
 * `statementSigningAccount(userSession)` to pick it — checking the product
 * account is a false-negative that blocks every valid session.
 *
 * Reference: substrate/primitives/statement-store/src/lib.rs
 */

import WebSocket from "ws";

/**
 * The account whose SSS allowance gates statement publishing for a session:
 * the session's local (statement-signing) account. This is the account that
 * signs the Request statements relayed to the phone — the one the chain grants
 * `StatementStoreAllowance` to at login. Returns its raw 32-byte public key, or
 * `null` if the session shape lacks a usable local account.
 *
 * Typed structurally (just the field we read) rather than importing the
 * concrete `UserSession` type from `@parity/product-sdk-terminal`, keeping the
 * SDK out of the headless deploy/login hot paths.
 */
export function statementSigningAccount(
    userSession: { localAccount?: { accountId?: Uint8Array } } | null | undefined,
): Uint8Array | null {
    const accountId = userSession?.localAccount?.accountId;
    if (accountId instanceof Uint8Array && accountId.length === 32) {
        return accountId;
    }
    return null;
}

/** Length of the ASCII prefix ":statement_allowance:". */
const SSS_PREFIX = new TextEncoder().encode(":statement_allowance:");

/**
 * Build the hex-encoded storage key for an SSS allowance check.
 *
 * Format: 0x + hex(":statement_allowance:" + pubkey_32_bytes)
 * No twox/blake2 hashing — the key is the raw concatenation.
 */
export function sssStorageKey(pubkey: Uint8Array): string {
    if (pubkey.length !== 32) {
        throw new Error(`SSS storage key requires a 32-byte public key, got ${pubkey.length} bytes`);
    }
    const full = new Uint8Array(SSS_PREFIX.length + pubkey.length);
    full.set(SSS_PREFIX, 0);
    full.set(pubkey, SSS_PREFIX.length);
    return "0x" + Buffer.from(full).toString("hex");
}

/**
 * Check whether a Statement Store allowance is present on the People chain.
 *
 * @returns
 *   - `true`  — allowance present (continue)
 *   - `false` — allowance absent / expired (user must re-login)
 *   - `null`  — could not determine (network error or timeout; caller decides whether to block)
 */
export function checkSSSAllowance(
    pubkey: Uint8Array,
    peopleEndpoints: string[],
    timeoutMs = 5000,
): Promise<boolean | null> {
    return new Promise((resolve) => {
        const endpoint = peopleEndpoints[0];
        if (!endpoint) {
            resolve(null);
            return;
        }

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        function done(value: boolean | null) {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            try { ws.terminate(); } catch { /* ignore */ }
            resolve(value);
        }

        let ws: WebSocket;
        try {
            ws = new WebSocket(endpoint);
        } catch {
            resolve(null);
            return;
        }

        timer = setTimeout(() => done(null), timeoutMs);

        ws.on("error", () => done(null));

        ws.on("open", () => {
            let storageKey: string;
            try {
                storageKey = sssStorageKey(pubkey);
            } catch {
                done(null);
                return;
            }
            const request = JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "state_getStorage",
                params: [storageKey],
            });
            ws.send(request, (err?: Error) => {
                if (err) done(null);
            });
        });

        ws.on("message", (data: Buffer | string) => {
            try {
                const msg = JSON.parse(data.toString()) as { result?: string | null };
                const result = msg.result;
                // Non-null and not "0x" means the key is present in storage.
                const present = result != null && result !== "0x";
                done(present);
            } catch {
                done(null);
            }
        });
    });
}
