// VENDORED from @parity/product-sdk-auth — do not edit here; see src/auth/index.ts swap note.
// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Session-backed `PolkadotSigner` for a product account, built on
 * product-sdk-terminal's `createSessionSignerForAccount`.
 *
 * RFC-0022 puts the product account at `//product//{productId}/{index}`. The
 * first two junctions are hard, so the key cannot be derived from the session's
 * root public key: the SDK asks the phone for the `//product//{productId}`
 * subtree key once and caches it in `{appId}_ProductSubtrees.json`.
 */

import {
    AllowanceExpiredError,
    createSessionSignerForAccount,
    deriveProductPublicKey as sdkDeriveProductPublicKey,
    type ProductAccountRef,
    type ProductSubtreeOptions,
    type UserSession,
} from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";
import { NonRetryableError } from "../../errors.js";
import { CLI_NAME } from "../../cli-name.js";

export { INCOMPLETE_SESSION_MESSAGE, sessionRootPublicKey } from "@parity/product-sdk-terminal";
export type { ProductAccountRef };

export const SESSION_EXPIRED_MESSAGE =
    "Session signing allowance has expired (~2-3 days after login). " +
    `Run \`${CLI_NAME} logout\`, then \`${CLI_NAME} login\`, to renew ` +
    "(login alone won't refresh a stale session).";

/** A healthy phone answers in 3-30s; host-papp's own deadline is 240s. */
export const SUBTREE_TIMEOUT_MS = 60_000;

/**
 * The product account public key for `ref`. Reaches the phone only when the
 * subtree key is not cached yet, which is normally once, right after pairing.
 */
export async function deriveProductPublicKey(
    session: UserSession,
    ref: ProductAccountRef,
    options?: ProductSubtreeOptions,
): Promise<Uint8Array> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            sdkDeriveProductPublicKey(session, ref, options),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`no reply within ${SUBTREE_TIMEOUT_MS / 1000}s`)),
                    SUBTREE_TIMEOUT_MS,
                );
            }),
        ]);
    } catch (err) {
        // Android drops this request without replying when the product id's TLD
        // does not match the phone's network; a backgrounded app looks the same.
        const reason = err instanceof Error ? err.message : String(err);
        throw new NonRetryableError(
            `The phone did not return the account key for "${ref.productId}" (${reason}). ` +
            "Keep the Polkadot app open and check that it is on the same network as this command.",
        );
    } finally {
        clearTimeout(timer);
    }
}

export async function createSessionSigner(
    session: UserSession,
    ref: ProductAccountRef,
    options?: ProductSubtreeOptions,
): Promise<PolkadotSigner> {
    const signer = await createSessionSignerForAccount(session, ref, options);
    return {
        publicKey: signer.publicKey,
        signTx: withExpiredAllowanceHint(signer.signTx),
        signBytes: withExpiredAllowanceHint(signer.signBytes),
    };
}

/**
 * The SDK rejects with `AllowanceExpiredError`; replace it with the remedy. Also
 * drops the statement-store's "submitRequest failed: Not connected" teardown noise
 * logged after a deploy has already failed.
 */
function withExpiredAllowanceHint<A extends unknown[], R>(
    fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
    return async (...args: A): Promise<R> => {
        const origErr = console.error;
        console.error = (...errArgs: unknown[]) => {
            const msg = errArgs.map(String).join(" ");
            if (/submitRequest failed/i.test(msg) && /not connected|destroyederror|client destroyed/i.test(msg)) return;
            origErr(...errArgs);
        };
        try {
            return await fn(...args);
        } catch (err) {
            if (err instanceof AllowanceExpiredError) {
                throw new NonRetryableError(SESSION_EXPIRED_MESSAGE);
            }
            throw err;
        } finally {
            console.error = origErr;
        }
    };
}
