/**
 * login — QR/mobile sign-in command.
 *
 * Flow:
 *  1. connect() → existing session (already logged in) OR QR code
 *  2. Print QR → user scans on phone
 *  3. waitForLogin() → phone approves → paired
 *  4. requestResourceAllocation(DEFAULT_RESOURCES) — one batched claim for all three deploy
 *     allowances (BulletInAllowance, StatementStoreAllowance, SmartContractAllowance). Triggers
 *     a single wallet prompt; granted key material is cached by product-sdk-terminal so later
 *     deploys find it without re-prompting. Non-fatal: Rejected/NotAvailable → log + continue.
 *  5. createSlotAccountSigner(BULLETIN_RESOURCE) — reads the now-cached Bulletin slot from the
 *     terminal cache written in step 4 (pure cache-hit, no phone prompt). Falls back to
 *     getBulletinSigner() only on a rare cache miss.
 *  6. Print summarizeLogin() + slot address on success; map AllowanceError.reason → message on failure
 *  7. Destroy adapters and exit
 */

import { renderLoginStatus, requestResourceAllocation, DEFAULT_RESOURCES, summarizeOutcomes, createSlotAccountSigner, BULLETIN_RESOURCE } from "../auth/index.js";
import type { AllocationSummary } from "../auth/index.js";
import { getAuthClient, DOT_PRODUCT_ID, DOT_DAPP_ID, resolveBulletinEndpoints, getPeopleChainEndpoints } from "../auth-config.js";
import { CLI_NAME } from "../cli-name.js";
import { statementSigningAccount } from "../sss-allowance.js";
import { preflightSssAllowance } from "../sss-allowance-cache.js";
import { loadEnvironments } from "../environments.js";
import { ss58Encode } from "@parity/product-sdk-address";
import { waitForBulletinAuthorization } from "../storage-signer.js";
import { startSpinner } from "../spinner.js";

/**
 * How long we wait for the mobile wallet to respond to the allocation request.
 * The vendor's raw session.requestResourceAllocation had no timeout at all —
 * this prevents the CLI from hanging forever when the phone is unresponsive.
 */
const ALLOCATION_TIMEOUT_MS = 60_000;

/**
 * Map an AllowanceError.reason to a user-facing message.
 *
 * - NoSession: the paired session was not found (should not happen right after login)
 * - Rejected: the user dismissed the wallet prompt
 * - NotAvailable: the wallet has no allocation for this product (re-pair needed)
 * - UnexpectedResponse: protocol-level error in the wire exchange
 */
export function allocationErrorMessage(reason: string): string {
    switch (reason) {
        case "NoSession":
            return "No active session found — try logging in again.";
        case "Rejected":
            return "Bulletin storage access was declined on your phone. Approve the request to enable storage signing.";
        case "NotAvailable":
            return (
                "Bulletin storage is not available for this product on your phone.\n" +
                "   This may mean the wallet paired under a different product ID.\n" +
                `   Run: ${CLI_NAME} logout\n` +
                `   Then: ${CLI_NAME} login\n` +
                "   to re-pair and establish the allocation."
            );
        case "UnexpectedResponse":
            return "Unexpected response from the mobile wallet during storage allocation. Try again.";
        default:
            return `Allocation failed (${reason}).`;
    }
}

/**
 * Soft-warning message shown when the post-sign-in allowance pre-warm steps fail.
 * The user IS already signed in; this is non-fatal.
 * Pure function, unit-testable.
 */
export function allocationFailedMessage(reason: string): string {
    return (
        `Allowance pre-warm failed: ${reason}\n` +
        "   Likely cause: personhood or alias not yet established for this account.\n" +
        "   Storage will fall back to the pool for now.\n" +
        `   Run: ${CLI_NAME} logout, then ${CLI_NAME} login,\n` +
        "   to retry once your wallet's personhood/alias is in place."
    );
}

/**
 * Format the up-front batched allocation result as a human-readable log line.
 * Pure function, unit-testable.
 *
 * Granted resources are logged with ✓; rejected/unavailable are logged as warnings.
 * Non-fatal: callers should log the message but NEVER process.exit on a non-empty
 * rejected or unavailable list — deploys can still fall back.
 */
export function formatAllocationSummary(summary: AllocationSummary): string {
    const parts: string[] = [];
    for (const r of summary.granted) {
        parts.push(`  ✓ ${r.tag}`);
    }
    for (const r of summary.rejected) {
        parts.push(`  ✗ ${r.tag} (declined on phone — deploys will fall back)`);
    }
    for (const r of summary.unavailable) {
        parts.push(`  ~ ${r.tag} (not available — re-pair if this persists)`);
    }
    return parts.join("\n");
}

/**
 * Race `promise` against a timeout, clearing the timer once either side settles.
 *
 * CRITICAL: `Promise.race` does not cancel the loser, and `setTimeout` fires on
 * wall-clock from creation. A bare `race([p, timeoutPromise])` leaves the timer
 * armed after `p` wins — it then rejects an un-awaited promise later, surfacing as
 * an `unhandledRejection`. In login that rejection ("…timed out…") is NOT a benign
 * teardown string, so bin's `unhandledRejection` guard treats it as fatal → exit 1
 * AFTER a successful login (the on-chain authorization wait can push total elapsed
 * past the 60s window). `clearTimeout` in `finally` closes that window.
 */
export async function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Format a post-login summary. Pure function, unit-testable.
 *
 * @param address       SS58 product address (the identity signing on-chain)
 * @param slotAddress   SS58 slot account address for Bulletin storage, or null if not obtained
 */
export function summarizeLogin(address: string, slotAddress: string | null): string {
    const lines: string[] = [`Signed in as: ${address}`];
    if (slotAddress) {
        lines.push(`Bulletin storage slot: ${slotAddress} ✓`);
    } else {
        lines.push("Bulletin storage slot: not allocated (storage will fall back to pool)");
    }
    return lines.join("\n");
}

/**
 * Produce the on-chain authorization result message shown after the active-wait completes.
 * Pure function — unit-testable without a real WS connection.
 *
 * - authorized = true  → ✓ success message with expiration block (exit-0, show summarizeLogin).
 * - authorized = false → soft-warning: active wait timed out before the authorization landed.
 *   Login is still valid — the slot is deterministic and often already authorized; the deploy
 *   path re-probes before use and falls back to the pool if still absent. isWarning=true so
 *   callers know it's a non-fatal outcome. The timeout bound (timeoutSeconds) is embedded in
 *   the message so users understand the ceiling that was used.
 */
export function bulletinAuthSummary(
    authorized: boolean,
    expiration?: number,
    timeoutSeconds = 180,
): { message: string; isWarning: boolean } {
    if (authorized) {
        return {
            message: `✓ Bulletin allowance authorized (until block ${expiration})`,
            isWarning: false,
        };
    }
    return {
        message:
            `   Couldn't confirm on-chain authorization within ${timeoutSeconds}s. Your login is valid — ` +
            "your next deploy will use the slot once it's authorized, or fall back to the pool meanwhile.",
        isWarning: true,
    };
}

export interface LoginOptions {
    suri?: string;
}

/**
 * Run the login command. Prints the QR code to stdout and waits for mobile approval.
 */
export async function runLogin(envId: string, _opts: LoginOptions = {}): Promise<void> {
    // Teardown guard: adapter.destroy() fires a synchronous RxJS finalizer that calls
    // sendUnsubscribe on an already-closed papi WS. polkadot-api's raw client surfaces this
    // as an uncaughtException with "Error: Not connected" (or DestroyedError). The `.catch(()=>{})`
    // on destroy() doesn't catch it because it's thrown in a Subscription finalizer, not the
    // destroy promise's rejection. We narrow-swallow it only while actively tearing down so that
    // real errors (before teardown or after) still surface and crash the process.
    let tearingDown = false;
    const teardownFilter = (e: unknown): void => {
        const msg = String((e as { message?: string })?.message ?? e);
        if (tearingDown && /not connected|client destroyed|destroyederror/i.test(msg)) return;
        console.error(e);
        process.exit(1);
    };
    process.on("uncaughtException", teardownFilter);
    process.on("unhandledRejection", teardownFilter);

    const client = await getAuthClient(envId);
    const result = await client.connect();

    if (result.kind === "existing") {
        // Check that the Statement Store allowance (needed for DotNS signing) is still valid.
        // SSS allowance lasts ~2-3 days (1-day period + 2-day grace). If expired, the user
        // must logout and login again to re-establish it over the direct QR channel.
        // connect() already destroyed its adapter on the existing-path — getSessionSigner
        // creates a fresh adapter-B for this check.
        const sessionHandle = await client.getSessionSigner();
        if (sessionHandle) {
            try {
                // Check the Statement Store allowance (needed for mobile signing) via a pure
                // state_getStorage read on the People chain — no transaction, no phone dialog.
                // Key = b":statement_allowance:" ++ raw 32-byte LOCAL (statement-signing)
                // account pubkey. NOT the product account: the product account signs on-chain
                // extrinsics and never holds an SSS allowance (its key is always null). The
                // local account publishes Request statements to relay signing to the phone, so
                // the chain grants its allowance at login. See sss-allowance.ts.
                const statementAccount = statementSigningAccount(sessionHandle.userSession);
                // Cached preflight: skips the chain read on a same-period hit, clears
                // the cache on a chain-confirmed expiry. See sss-allowance-cache.ts.
                const allowed = await preflightSssAllowance(statementAccount, () => getPeopleChainEndpoints(envId));
                if (allowed === false) {
                    console.error(
                        `\nStatement Store allowance has expired for ${result.address}.\n` +
                        `Run: ${CLI_NAME} logout\n` +
                        `Then: ${CLI_NAME} login\n` +
                        `to re-pair and renew (allowance lasts ~2-3 days).`,
                    );
                    tearingDown = true;
                    sessionHandle.destroy();
                    process.exit(1);
                }
                // allowed === null → People chain unreachable; don't block the user.

                // Quick Bulletin slot check on the existing-session path.
                // Uses getBulletinSigner — cache-hit only, no popup on a cache miss.
                // On 0.8.6+ the allowance cache file is AES-encrypted and scoped by sessionId
                // (_AllowanceKeys_<sessionId>.json); readBulletinSlotSigner reads the pre-0.8.6
                // plaintext format (_AllowanceKeys.json) and is effectively dead on 0.8.6+.
                // getBulletinSigner on the existing adapter reads host-papp's in-process cache.
                // Warn on Err (pool fallback still works); never exit-1 (not fatal like SSS expiry).
                try {
                    await Promise.race([
                        Promise.resolve(
                            sessionHandle.adapter.allowance
                                .getBulletinSigner(sessionHandle.userSession.id, DOT_PRODUCT_ID),
                        ).then((r: { isOk: () => boolean; isErr: () => boolean }) => {
                            if (r.isErr()) {
                                console.warn(
                                    `\nBulletin storage slot allowance not available — storage will fall back to pool.\n` +
                                    `Run: ${CLI_NAME} logout && ${CLI_NAME} login\n` +
                                    `to re-establish your allowance.`,
                                );
                            }
                        }).catch(() => {}),
                        new Promise(r => setTimeout(r, 3000)),
                    ]);
                } catch {
                    // Bulletin check is best-effort; never block existing-session login.
                }
            } finally {
                sessionHandle.destroy();
            }
        }

        console.log(`Already signed in as: ${result.address}`);
        tearingDown = true;
        return;
    }

    // Print the QR code for the user to scan.
    console.log(result.qrCode);
    console.log("Scan the QR code with your Polkadot mobile app.");

    // waitForLogin now returns a SessionHandle built on adapter-A (the live pairing
    // adapter). This eliminates the session-persistence race: previously the code
    // destroyed adapter-A and called getSessionSigner() which created adapter-B and
    // re-read from disk — the disk flush races the read, so adapter-B found nothing
    // and the allowance acquisition never ran. The handle is adapter-A: no disk read,
    // no race, no second adapter.
    const handle = await client.waitForLogin(result.login, (status) => {
        const msg = renderLoginStatus(status);
        if (msg) process.stdout.write(`\r${msg}`);
    });
    // adapter-A is now owned by `handle` (destroyed via handle.destroy() in the
    // finally below). Do NOT call result.login.adapter.destroy() here — it is the
    // same object and would double-destroy.

    if (!handle) {
        tearingDown = true;
        console.error("\nLogin failed.");
        process.exit(1);
        return;
    }

    // RFC-0010: obtain the Bulletin storage slot signer via the terminal cache.
    // Use handle (adapter-A) directly — no getSessionSigner() call, no fresh adapter, no race.
    // Step 1 (batched claim) uses DOT_PRODUCT_ID (unified with DOT_DAPP_ID, #885) so the
    // allowances land on the same product account the deploy signer derives from.
    // Step 2 reads from the same terminal cache file — no second wallet prompt.
    //
    // Step 1: claim ALL deploy allowances (Bulletin + SSS + PGAS) in one batched request
    // so later deploys are friction-free. On a fresh login this triggers one wallet prompt
    // covering all three resources. getBulletinSigner (step 2) is then a cache-hit.
    // Non-fatal: Rejected/NotAvailable per resource → log a warning and continue.
    // Only a thrown/timed-out transport error falls through to the catch → exit(1).
    try {
        console.log("\nAllocating deploy resources — check your phone to approve.");
        const resources = DEFAULT_RESOURCES;
        const outcomes = await withTimeout(
            requestResourceAllocation(handle.userSession, handle.adapter, resources),
            ALLOCATION_TIMEOUT_MS,
            `Allocation request timed out after ${Math.round(ALLOCATION_TIMEOUT_MS / 1000)}s — ` +
                `the wallet did not respond to the approval request.`,
        );
        const summary = summarizeOutcomes(outcomes, resources);
        const summaryText = formatAllocationSummary(summary);
        if (summaryText) console.log(summaryText);
        if (summary.rejected.length > 0 || summary.unavailable.length > 0) {
            console.warn(
                "   Some allowances were not granted — Bulletin storage falls back to a pool account;\n" +
                `   PGAS/contract gaps surface at deploy time. Run: ${CLI_NAME} logout && ${CLI_NAME} login  to retry.`,
            );
        }

        // Step 2: read the Bulletin slot signer from the terminal cache written by step 1.
        // createSlotAccountSigner reads the same {appId}_AllowanceKeys.json file that
        // requestResourceAllocation wrote — guaranteed cache-hit, no phone prompt.
        // Falls back to getBulletinSigner() only on a rare cache miss (e.g. first install
        // before a terminal-cache write).
        let slotSigner = await createSlotAccountSigner(handle.adapter, BULLETIN_RESOURCE);
        if (!slotSigner) {
            // Cache miss (uncommon after a successful batched allocation above).
            // getBulletinSigner goes through host-papp's in-process cache; on a miss
            // it may prompt the phone. Wrap in withTimeout as a safety net.
            const fallbackResult = await withTimeout(
                handle.adapter.allowance.getBulletinSigner(handle.userSession.id, DOT_PRODUCT_ID),
                ALLOCATION_TIMEOUT_MS,
                `Bulletin slot read timed out after ${Math.round(ALLOCATION_TIMEOUT_MS / 1000)}s — ` +
                    `the wallet did not respond.`,
            );
            if (fallbackResult.isOk()) slotSigner = fallbackResult.value;
        }

        if (slotSigner) {
            const slotAddress = ss58Encode(slotSigner.publicKey);
            // Wait for the slot account's on-chain authorization to land before
            // declaring success. The mobile wallet's requestResourceAllocation
            // triggers the authorization tx on-chain; it's async, so we confirm
            // finalization rather than assume it. The slot is deterministic and
            // usually already authorized, so this resolves in seconds. There is
            // no ceiling — we wait until it's confirmed (the query-error retry in
            // pollUntilBulletinAuthorized rides out flaky reads). The user can
            // Ctrl-C to stop waiting; the session is still saved, so we exit 0
            // with the soft-fallback message rather than failing.
            // Poll the SELECTED env's bulletin chain — NOT the deploy-only
            // BULLETIN_ENDPOINTS default. Login never runs deploy's endpoint
            // reassignment, so without this it would wait on the wrong chain
            // (paseo-next) and never see the slot's authorization on, e.g.,
            // paseo-next-v2. Fall back to undefined (→ default) only if the env
            // somehow has no bulletin endpoint.
            const { doc } = await loadEnvironments();
            const bulletinEndpoints = resolveBulletinEndpoints(doc, envId) ?? undefined;
            const spinner = startSpinner("Confirming Bulletin authorization on-chain");
            const onSigint = (): void => {
                spinner.stop();
                console.log(
                    "Cancelled — on-chain authorization not yet confirmed. Your login is saved; " +
                    "your next deploy will use the slot once it's authorized, or fall back to the pool meanwhile.",
                );
                console.log("\n" + summarizeLogin(handle.address, slotAddress));
                tearingDown = true;
                handle.destroy();
                process.exit(0);
            };
            process.once("SIGINT", onSigint);
            let authResult: Awaited<ReturnType<typeof waitForBulletinAuthorization>>;
            try {
                // timeoutMs: Infinity → poll until confirmed (no ceiling).
                authResult = await waitForBulletinAuthorization(slotAddress, {
                    timeoutMs: Infinity,
                    quiet: true,
                    endpoints: bulletinEndpoints,
                });
            } finally {
                spinner.stop();
                process.removeListener("SIGINT", onSigint);
            }
            const authSummary = bulletinAuthSummary(
                authResult.authorized,
                authResult.authorized ? authResult.expiration : undefined,
            );
            console.log(authSummary.message);
            console.log("\n" + summarizeLogin(handle.address, slotAddress));
        } else {
            console.log("\n" + summarizeLogin(handle.address, null));
            console.warn(
                "   Bulletin storage slot not available — storage will fall back to a pool account.\n" +
                `   Run: ${CLI_NAME} logout && ${CLI_NAME} login  to retry.`,
            );
        }
    } catch (err) {
        // Post-sign-in allowance pre-warm failed (steps 2–4: requestResourceAllocation,
        // createSlotAccountSigner, waitForBulletinAuthorization). The user IS already
        // signed in (session saved in step 1) — this is non-fatal. Best-effort: abort
        // any pending statement-store requests before tearing down to clear the wedge
        // that would block subsequent login attempts.
        // ResultAsync.catch() not available — wrap in Promise.resolve() first.
        await Promise.resolve(handle.userSession.abortPendingRequests()).catch(() => {});
        tearingDown = true;
        console.log(
            "\n" + allocationFailedMessage(err instanceof Error ? err.message : String(err)),
        );
        console.log("\n" + summarizeLogin(handle.address, null));
    } finally {
        tearingDown = true;
        handle.destroy();
    }

    // Force exit: the papi client and/or statement-store handles opened during
    // login hold open async resources (pending chain subscriptions, WS heartbeat
    // timers). Both adapters have been explicitly destroyed above; process.exit(0)
    // is the belt-and-suspenders guarantee that the CLI terminates.
    process.exit(0);
}
