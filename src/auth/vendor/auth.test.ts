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

import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi, beforeEach } from "vitest";
import { ss58Encode } from "@parity/product-sdk-address";
import { createAuthClient } from "./auth.js";
import type { AuthConfig } from "./types.js";

// Module-level capture for the vi.mock() hoisting boundary — the factory runs
// at module-init time, so the captured reference must be at module scope.
let _capturedAdapterOptions: unknown = undefined;

const config: AuthConfig = {
    dappId: "test-app",
    productId: "test-app.dot",
    derivationIndex: 0,
    hostName: "test-app",
    hostVersion: "0.0.0",
    peopleEndpoints: ["wss://example.com/people"],
};

describe("createAuthClient", () => {
    test("returns the bound auth surface (all functions)", () => {
        const client = createAuthClient(config);
        for (const fn of [
            "connect",
            "waitForLogin",
            "getSessionSigner",
            "findSession",
            "waitForLogout",
            "requestAllocation",
            "clearLocalAppStorage",
        ] as const) {
            expect(typeof client[fn]).toBe("function");
        }
    });

    test("clearLocalAppStorage returns (no throw) when the dir does not exist", async () => {
        const client = createAuthClient(config);
        await expect(
            client.clearLocalAppStorage("/nonexistent/dir/should-not-exist-xyz"),
        ).resolves.toBeUndefined();
    });

    test("clearLocalAppStorage removes every env's files for this dappId and nothing else", async () => {
        const dir = await mkdtemp(join(tmpdir(), "bd-auth-clear-"));
        try {
            for (const f of ["test-app_SsoSessionsV4.json", "test-app.paseo_AllowanceKeys.json", "test-app.testnet_AllowanceKeys.json", "other_SsoSessionsV4.json"]) {
                await writeFile(join(dir, f), "{}");
            }
            await createAuthClient(config).clearLocalAppStorage(dir);
            expect(await readdir(dir)).toEqual(["other_SsoSessionsV4.json"]);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

// vi.mock is hoisted to module top by Vitest — the factory captures into the
// module-level `_capturedAdapterOptions` var so it's in scope at init time.
//
// `waitForSessions` is also overrideable per-test via `_waitForSessionsImpl`.
// Default: returns []. Tests that need a real session set it before calling.
let _waitForSessionsImpl: () => Promise<unknown[]> = async () => [];
const PRODUCT_KEY = new Uint8Array(32).fill(0x5a);
let _deriveImpl: () => Promise<Uint8Array> = async () => PRODUCT_KEY;

vi.mock("@parity/product-sdk-terminal", async (importOriginal) => {
    const original = await importOriginal<typeof import("@parity/product-sdk-terminal")>();
    return {
        ...original,
        createTerminalAdapter: (opts: unknown) => {
            _capturedAdapterOptions = opts;
            // Minimal stub so findSession() resolves without a real WS.
            // `storageDir` must be present so the terminal requestResourceAllocation
            // facet can build the AllowanceKeys cache path correctly.
            return {
                appId: (opts as { appId: string }).appId,
                storageDir: undefined,
                sso: { authenticate: async () => ({ match: () => {} }) },
                sessions: {
                    sessions: { read: () => [] },
                    disconnect: async () => ({ isOk: () => true }),
                },
                destroy: async () => {},
                allowance: {},
            };
        },
        waitForSessions: (..._args: unknown[]) => _waitForSessionsImpl(),
        renderQrCode: original.renderQrCode,
        // The real calls fetch the subtree key from the phone and cache it under
        // ~/.polkadot-apps; the derivation itself is covered in sessionSigner.test.ts.
        deriveProductPublicKey: () => _deriveImpl(),
        // A signer built without the derived key would get 0x11 and fail the
        // address check below.
        createSessionSignerForAccount: async (_session: unknown, ref: { publicKey?: Uint8Array }) => ({
            publicKey: ref.publicKey ?? new Uint8Array(32).fill(0x11),
            signTx: async () => new Uint8Array(),
            signBytes: async () => new Uint8Array(),
        }),
    };
});

describe("waitForLogin returns SessionHandle on the live pairing adapter", () => {
    beforeEach(() => {
        _capturedAdapterOptions = undefined;
        // Reset to default (no sessions).
        _waitForSessionsImpl = async () => [];
        _deriveImpl = async () => PRODUCT_KEY;
    });

    test("resolves to a SessionHandle (no fresh-adapter re-read race)", async () => {
        // Alice's canonical sr25519 public key (a valid Ristretto255 point).
        // Substrate test account — used here only for derivation math correctness.
        const alicePubkey = new Uint8Array(Buffer.from(
            "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
            "hex",
        ));
        const fakeSession = { rootAccountId: alicePubkey };
        let destroyCalled = false;
        let authResolve!: (v: unknown) => void;
        const authPromise: ReturnType<import("@parity/product-sdk-terminal").TerminalAdapter["sso"]["authenticate"]> =
            new Promise((resolve) => { authResolve = resolve; }) as never;

        // Set up waitForSessions to return one session on the FIRST call
        // (the call inside waitForLogin, on adapter-A), before authPromise resolves.
        _waitForSessionsImpl = async () => [fakeSession];

        // Provide a minimal adapter-A that tracks destroy() calls.
        const adapterA = {
            appId: "test-app",
            storageDir: undefined,
            sso: {
                authenticate: () => authPromise,
                pairingStatus: { subscribe: () => () => {} },
            },
            sessions: { sessions: { read: () => [] }, disconnect: async () => ({ isOk: () => true }) },
            destroy: async () => { destroyCalled = true; },
            allowance: {},
        } as unknown as import("@parity/product-sdk-terminal").TerminalAdapter;

        const client = createAuthClient(config);
        const loginHandle = {
            adapter: adapterA,
            authPromise,
        };

        // Resolve auth right away — simulate phone approve.
        // authenticate() result is a Result<UserSession | null, Error> — mock Ok(fakeSession).
        const waitPromise = client.waitForLogin(loginHandle, () => {});
        authResolve({ match: (ok: (s: unknown) => void) => ok(fakeSession) });

        const handle = await waitPromise;

        expect(handle, ">> FAIL: waitForLogin must return a usable SessionHandle on the live pairing adapter (no fresh-adapter re-read race)").not.toBeNull();
        expect(handle, ">> FAIL: waitForLogin must return a usable SessionHandle on the live pairing adapter (no fresh-adapter re-read race)").not.toBe(null);
        if (!handle) return; // type narrowing
        expect(typeof handle.address, ">> FAIL: handle.address must be a string").toBe("string");
        expect(handle.userSession, ">> FAIL: handle.userSession must be the paired session (not null)").toBe(fakeSession);
        expect(handle.adapter, ">> FAIL: handle.adapter must be adapter-A (the live pairing adapter, not a fresh one)").toBe(adapterA);
        expect(handle.productId, ">> FAIL: handle.productId must be the configured product id").toBe(config.productId);
        expect(ss58Encode(handle.signer.publicKey), ">> FAIL: the displayed address must be the key the signer signs with").toBe(handle.address);
        expect(typeof handle.destroy, ">> FAIL: handle.destroy must be callable").toBe("function");
        // Calling destroy() on the handle should eventually destroy adapter-A.
        handle.destroy();
        expect(destroyCalled, ">> FAIL: handle.destroy() must tear down adapter-A").toBe(true);
    });
});

describe("session loading failures", () => {
    const alicePubkey = new Uint8Array(Buffer.from(
        "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d",
        "hex",
    ));

    beforeEach(() => {
        _waitForSessionsImpl = async () => [];
        _deriveImpl = async () => PRODUCT_KEY;
    });

    test("a stored session without rootAccountId reports INCOMPLETE_SESSION_MESSAGE", async () => {
        _waitForSessionsImpl = async () => [{ id: "s1", rootAccountId: new Uint8Array() }];
        await expect(
            createAuthClient(config).getSessionSigner(),
            ">> FAIL: a session missing rootAccountId must tell the user to log out and in again",
        ).rejects.toThrow("missing the root account public key");
    });

    test("waitForLogin drops the new session when the phone does not return the account key", async () => {
        const origHome = process.env.HOME;
        const home = await mkdtemp(join(tmpdir(), "bd-auth-home-"));
        process.env.HOME = home;
        try {
            const session = { id: "s1", rootAccountId: alicePubkey };
            _waitForSessionsImpl = async () => [session];
            _deriveImpl = async () => { throw new Error("phone did not answer"); };
            const disconnected: unknown[] = [];
            const adapter = {
                appId: "test-app",
                sso: { pairingStatus: { subscribe: () => () => {} } },
                sessions: { disconnect: async (s: unknown) => { disconnected.push(s); return { isOk: () => true }; } },
                destroy: async () => {},
            } as unknown as import("@parity/product-sdk-terminal").TerminalAdapter;
            const statuses: { step: string }[] = [];

            const handle = await createAuthClient(config).waitForLogin(
                { adapter, authPromise: Promise.resolve({ match: (ok: (s: unknown) => void) => ok(session) }) as never },
                (s) => statuses.push(s),
            );

            expect(handle, ">> FAIL: login must fail when the account key cannot be derived").toBeNull();
            expect(disconnected, ">> FAIL: the half-made session must be dropped so the next login pairs again").toEqual([session]);
            expect(statuses.at(-1)?.step).toBe("error");
        } finally {
            process.env.HOME = origHome;
            await rm(home, { recursive: true, force: true });
        }
    });
});

describe("createAdapter options (V2 wire shape)", () => {
    beforeEach(() => {
        _capturedAdapterOptions = undefined;
    });

    test("createTerminalAdapter receives inline hostMetadata and no metadataUrl", async () => {
        const client = createAuthClient(config);
        // findSession() is the lightest path that calls createAdapter and returns
        // without needing pairingStatus.subscribe or authenticate.
        await client.findSession();

        expect(_capturedAdapterOptions, ">> FAIL: adapter options: createTerminalAdapter must have been called")
            .toBeDefined();
        const opts = _capturedAdapterOptions as Record<string, unknown>;
        expect(opts, ">> FAIL: adapter options: v0.8 requires inline hostMetadata (metadataUrl was removed)")
            .not.toHaveProperty("metadataUrl");
        const hm = opts.hostMetadata as Record<string, unknown>;
        expect(hm, ">> FAIL: adapter options: hostMetadata must be present")
            .toBeDefined();
        expect(typeof hm.hostName, ">> FAIL: adapter options: hostMetadata.hostName must be a string")
            .toBe("string");
        expect(typeof hm.hostVersion, ">> FAIL: adapter options: hostMetadata.hostVersion must be a string")
            .toBe("string");
        expect(typeof hm.platformType, ">> FAIL: adapter options: hostMetadata.platformType must be a string")
            .toBe("string");
        expect(typeof hm.platformVersion, ">> FAIL: adapter options: hostMetadata.platformVersion must be a string")
            .toBe("string");
    });
});
