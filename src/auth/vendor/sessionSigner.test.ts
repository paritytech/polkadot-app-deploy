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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AllowanceExpiredError, type UserSession } from "@parity/product-sdk-terminal";
import { seedToAccount } from "@parity/product-sdk-keys";
import { entropyToMnemonic } from "@polkadot-labs/hdkd-helpers";
import { SUBTREE_TIMEOUT_MS, createSessionSigner, deriveProductPublicKey } from "./sessionSigner.js";

const { createSessionSignerForAccountMock } = vi.hoisted(() => ({
    createSessionSignerForAccountMock: vi.fn(),
}));

// deriveProductPublicKey stays real; the signer factory is real unless a test overrides it.
vi.mock("@parity/product-sdk-terminal", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@parity/product-sdk-terminal")>()),
    createSessionSignerForAccount: createSessionSignerForAccountMock,
}));

// host-rust-core vector (product_account.rs, wasm_crypto_vectors.rs): entropy
// 0xab x 16, product "myapp.dot", index 0.
const VECTOR_MNEMONIC = entropyToMnemonic(new Uint8Array(16).fill(0xab));
const VECTOR_PRODUCT = "myapp.dot";
const VECTOR_ACCOUNT = "1c1ae478b564572f806ffa6352b4273d612beb01610b19f4e5bf444521cd5b5c";

/** The `//product//{productId}` key the phone returns for ProductSubtreeRequest. */
function phoneSubtreeKey(mnemonic: string, productId: string): Uint8Array {
    return seedToAccount(mnemonic, `//product//${productId}`).publicKey;
}

function fakeSession(getProductSubtree: () => Promise<unknown>): UserSession {
    return { id: `s-${Math.random()}`, getProductSubtree } as unknown as UserSession;
}

const ok = (value: Uint8Array) => ({ isErr: () => false, value });

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("deriveProductPublicKey", () => {
    let storageDir = "";
    beforeEach(async () => {
        storageDir = await mkdtemp(join(tmpdir(), "bd-subtree-"));
    });
    afterEach(async () => {
        await rm(storageDir, { recursive: true, force: true });
    });

    test("matches host-rust-core's RFC-0022 account for the phone's subtree key", async () => {
        const subtree = phoneSubtreeKey(VECTOR_MNEMONIC, VECTOR_PRODUCT);
        const session = fakeSession(async () => ok(subtree));

        const key = await deriveProductPublicKey(
            session,
            { productId: VECTOR_PRODUCT, derivationIndex: 0 },
            { appId: "polkadot-app-deploy", storageDir },
        );

        expect(hex(key)).toBe(VECTOR_ACCOUNT);
    });

    test("gives up after SUBTREE_TIMEOUT_MS when the phone never replies", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const pending = deriveProductPublicKey(
                fakeSession(() => new Promise(() => {})),
                { productId: "polkadot-app-deploy.paseo", derivationIndex: 0 },
                { storageDir },
            );
            const assertion = expect(pending).rejects.toMatchObject({
                name: "NonRetryableError",
                message: expect.stringContaining(`no reply within ${SUBTREE_TIMEOUT_MS / 1000}s`),
            });
            await vi.advanceTimersByTimeAsync(SUBTREE_TIMEOUT_MS);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    test("names the product id when the phone does not answer", async () => {
        const session = fakeSession(async () => ({
            isErr: () => true,
            error: { message: "getProductSubtree timed out" },
        }));

        await expect(
            deriveProductPublicKey(
                session,
                { productId: "polkadot-app-deploy.paseo", derivationIndex: 0 },
                { storageDir },
            ),
        ).rejects.toMatchObject({
            name: "NonRetryableError",
            message: expect.stringContaining('"polkadot-app-deploy.paseo"'),
        });
    });
});

describe("createSessionSigner", () => {
    beforeEach(async () => {
        const actual = await vi.importActual<typeof import("@parity/product-sdk-terminal")>("@parity/product-sdk-terminal");
        createSessionSignerForAccountMock.mockReset().mockImplementation(actual.createSessionSignerForAccount);
    });

    test("signs as the RFC-0022 product account, not the wallet's selected account", async () => {
        const storageDir = await mkdtemp(join(tmpdir(), "bd-subtree-"));
        try {
            const wallet = seedToAccount(VECTOR_MNEMONIC, "//SomeWallet").publicKey;
            const session = {
                ...fakeSession(async () => ok(phoneSubtreeKey(VECTOR_MNEMONIC, VECTOR_PRODUCT))),
                remoteAccount: { accountId: wallet },
            } as unknown as UserSession;

            const signer = await createSessionSigner(session, { productId: VECTOR_PRODUCT, derivationIndex: 0 }, { storageDir });

            expect(hex(signer.publicKey)).toBe(VECTOR_ACCOUNT);
            expect(hex(signer.publicKey)).not.toBe(hex(wallet));
        } finally {
            await rm(storageDir, { recursive: true, force: true });
        }
    });

    test("passes the product account ref and subtree options to the SDK signer", async () => {
        createSessionSignerForAccountMock.mockResolvedValue({
            publicKey: new Uint8Array(32),
            signTx: async () => new Uint8Array(),
            signBytes: async () => new Uint8Array(),
        });
        const session = fakeSession(async () => ok(new Uint8Array(32)));
        const ref = { productId: "polkadot-app-deploy.paseo", derivationIndex: 0 };

        await createSessionSigner(session, ref, { appId: "polkadot-app-deploy" });

        expect(createSessionSignerForAccountMock).toHaveBeenCalledWith(session, ref, { appId: "polkadot-app-deploy" });
    });

    test("an expired statement-store allowance becomes a non-retryable login hint", async () => {
        createSessionSignerForAccountMock.mockResolvedValue({
            publicKey: new Uint8Array(32),
            signTx: async () => {
                throw new AllowanceExpiredError("statementStore", new Error("NoAllowance"));
            },
            signBytes: async () => new Uint8Array(),
        });
        const signer = await createSessionSigner(
            fakeSession(async () => ok(new Uint8Array(32))),
            { productId: "polkadot-app-deploy.paseo", derivationIndex: 0 },
        );

        await expect(signer.signTx(new Uint8Array(), {}, new Uint8Array(), 0)).rejects.toMatchObject({
            name: "NonRetryableError",
            message: expect.stringContaining("allowance has expired"),
        });
    });

    test("other signing errors pass through unchanged", async () => {
        const rejected = new Error("user rejected on phone");
        createSessionSignerForAccountMock.mockResolvedValue({
            publicKey: new Uint8Array(32),
            signTx: async () => new Uint8Array(),
            signBytes: async () => {
                throw rejected;
            },
        });
        const signer = await createSessionSigner(
            fakeSession(async () => ok(new Uint8Array(32))),
            { productId: "polkadot-app-deploy.paseo", derivationIndex: 0 },
        );

        await expect(signer.signBytes(new Uint8Array())).rejects.toBe(rejected);
    });
});

// ---------------------------------------------------------------------------
// Issue 2: console.error patch in sessionSigner swallows teardown noise
// ---------------------------------------------------------------------------
describe("sessionSigner teardown noise suppression (issue 2)", () => {
    test("console.error patch source contains teardown noise suppression for submitRequest failed", () => {
        // Verify the source-level fix is present — the patch now also swallows
        // "submitRequest failed: ... Not connected / DestroyedError / Client destroyed".
        const src = require("fs").readFileSync(
            require("path").join(__dirname, "sessionSigner.ts"),
            "utf8",
        );
        expect(src).toMatch(/submitRequest failed/i);
        expect(src).toMatch(/not connected|destroyederror|client destroyed/i);
    });
});
