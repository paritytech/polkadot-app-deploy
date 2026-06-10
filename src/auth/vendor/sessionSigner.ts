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
 * Session-backed `PolkadotSigner` for a product account.
 *
 * Lifted from playground-cli `src/utils/sessionSigner.ts` (issue #411). The
 * product id + derivation index are injected via `ProductAccountRef` so this
 * module is product-agnostic.
 *
 * **Why `session.createTransaction` instead of `signPayload` or `signRaw`?**
 *
 * `signPayload` (PJS-based) throws "PJS does not support this signed-extension"
 * on chains with unknown extensions like `AsPgas` / `AsRingAlias` on
 * paseo-next-v2, and also sends the full calldata as `method` — Android
 * rejects 2 MB chunks with "message too big".
 *
 * `signRaw({ tag: "Payload" })` signs only the bytes PAPI computes, so PAPI
 * must encode every signed extension correctly (including `AsPgas`). When PAPI
 * can't match the phone's encoding, the chain rejects with `BadProof`.
 *
 * `createTransaction` forwards the raw SCALE bytes for every extension to the
 * phone, which uses its own runtime metadata to decode, complete, and sign the
 * full extrinsic. Unknown extensions survive end-to-end; the phone returns the
 * complete signed transaction directly. This is the same path that
 * `@parity/product-sdk-signer` pins via `PRODUCT_SIGNER_TYPE = "createTransaction"`.
 *
 * Replace this whole file with a `product-sdk-terminal` re-export once that
 * package's signer ships `createTransaction` support natively.
 */

import { toHex } from "polkadot-api/utils";
import type { UserSession } from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";
import { NonRetryableError } from "../../errors.js";
import { CLI_NAME } from "../../cli-name.js";

export interface ProductAccountRef {
    productId: string;
    derivationIndex: number;
}

export const INCOMPLETE_SESSION_MESSAGE =
    'Stored login session is missing the root account public key. Run "logout" and then "login" to pair again.';

export function sessionRootPublicKey(session: UserSession): Uint8Array {
    const rootAccountId = (session as { rootAccountId?: Uint8Array }).rootAccountId;
    const publicKey = rootAccountId ? new Uint8Array(rootAccountId) : new Uint8Array();
    if (publicKey.length !== 32) {
        throw new Error(INCOMPLETE_SESSION_MESSAGE);
    }
    return publicKey;
}

/**
 * Soft-derive the product account public key off a wallet root.
 *
 * This is the single source of truth for product-account math. Both
 * `createSessionSigner` (which builds the signer used to actually sign
 * on-chain) and `deriveSessionAddresses` (which builds the display triple)
 * go through here so a future change to derivation params can't silently
 * desync the signer from what we print.
 *
 * sr25519 soft derivation is composable on public keys alone, so deriving
 * from `rootAccountId` locally produces the SAME public key the mobile
 * derives privately via `mnemonic + "/product/...{idx}"`. Algorithm parity
 * with mobile/desktop is locked by the frozen vectors in
 * `@parity/product-sdk-keys`'s `product-account.test.ts`.
 */
export function deriveProductPublicKey(
    rootAccountId: Uint8Array,
    ref: ProductAccountRef,
): Uint8Array {
    return deriveProductAccountPublicKey(rootAccountId, ref.productId, ref.derivationIndex);
}

export function createSessionSigner(
    session: UserSession,
    ref: ProductAccountRef,
): PolkadotSigner {
    const publicKey = deriveProductPublicKey(sessionRootPublicKey(session), ref);
    const productAccountId: [string, number] = [ref.productId, ref.derivationIndex];

    /**
     * Transaction signing via `createTransaction`.
     *
     * Forwards the raw SCALE bytes for every signed extension to the phone;
     * the phone uses its runtime metadata to handle unknown extensions (AsPgas,
     * AsRingAlias, etc.) and returns the complete signed extrinsic.
     *
     * `signTx` returns the fully-encoded extrinsic — PAPI submits it as-is.
     * txExtVersion = 0 for the V4 extrinsic format used on paseo-next-v2.
     */
    const signTx = async (
        callData: Uint8Array,
        signedExtensions: Record<string, { value: Uint8Array; additionalSigned: Uint8Array }>,
        _metadata: Uint8Array,
        _atBlockNumber: number,
    ): Promise<Uint8Array> => {
        const genesisHash = signedExtensions["CheckGenesis"]?.additionalSigned
            ?? new Uint8Array(32);
        const extensions = Object.entries(signedExtensions).map(([id, { value, additionalSigned }]) => ({
            id,
            extra: value,
            additionalSigned,
        }));
        // Fast-fail for expired SSS allowance: the statement-store adapter logs
        // "submitRequest failed: NoAllowanceError" to console.error but does NOT
        // reject the createTransaction promise — it just hangs for 180s waiting
        // for a phone response that never comes (the phone never got the request).
        // Intercept the log and fail fast so the user sees a clear message instead
        // of a 3-minute hang followed by a confusing "transaction watcher silent" error.
        let noAllowanceMsg: string | null = null;
        const origErr = console.error;
        console.error = (...args: unknown[]) => {
            const msg = args.map(String).join(" ");
            if (msg.includes("NoAllowanceError") || msg.includes("no allowance set")) {
                noAllowanceMsg = msg;
                return; // suppress raw stack trace — NonRetryableError below is the clean message
            }
            // Swallow teardown noise emitted by the statement-store adapter when
            // the deploy has already failed and the WS is being torn down. The
            // pattern "submitRequest failed: Error: Not connected" (and similar
            // DestroyedError / Client destroyed variants) is benign post-failure
            // noise — the user already sees the clean Deployment failed message.
            if (/submitRequest failed/i.test(msg) && /not connected|destroyederror|client destroyed/i.test(msg)) {
                return;
            }
            origErr(...args);
        };

        let clearPoll: ReturnType<typeof setInterval> | null = null;
        try {
            const result = await Promise.race([
                session.createTransaction({
                    payload: {
                        tag: "v1",
                        value: {
                            signer: productAccountId,
                            genesisHash,
                            callData,
                            extensions,
                            txExtVersion: 0,
                        },
                    },
                }),
                new Promise<never>((_, reject) => {
                    clearPoll = setInterval(() => {
                        if (noAllowanceMsg) {
                            reject(new NonRetryableError(
                                "Session signing allowance has expired (~2-3 days after login). " +
                                `Run \`${CLI_NAME} login\` to renew.`,
                            ));
                        }
                    }, 200);
                }),
            ]);
            if (result.isErr()) {
                throw new Error(`Mobile signing rejected: ${result.error.message}`);
            }
            return result.value; // complete signed extrinsic
        } finally {
            if (clearPoll !== null) clearInterval(clearPoll);
            console.error = origErr;
        }
    };

    /** Raw-bytes signing keeps the `Bytes` tag so the wallet applies the
     *  anti-phishing `<Bytes>...</Bytes>` envelope on its side. */
    const signBytes = async (data: Uint8Array): Promise<Uint8Array> => {
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Bytes", value: data },
        });
        if (result.isErr()) {
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }
        return result.value.signature;
    };

    return { publicKey, signTx, signBytes };
}
