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

import { describe, expect, test, vi, beforeEach } from "vitest";
import {
    DEFAULT_RESOURCES,
    requestResourceAllocation,
    summarizeOutcomes,
    type AllocatableResource,
    type AllocationOutcome,
} from "./allocations.js";
import type { TerminalAdapter } from "@parity/product-sdk-terminal";
import type { UserSession } from "@parity/product-sdk-terminal";

// Compile-time SDK-drift detection lives in allocations.ts (_SDK_COMPAT_PIN);
// importing it here means a drift fails this suite's compile step too.

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the terminal/host module so tests run offline with no WS.
vi.mock("@parity/product-sdk-terminal/host", () => ({
    requestResourceAllocation: vi.fn(),
}));

async function getTerminalMock() {
    const mod = await import("@parity/product-sdk-terminal/host");
    return mod.requestResourceAllocation as ReturnType<typeof vi.fn>;
}

/** Minimal TerminalAdapter stub that satisfies the appId/storageDir contract. */
function fakeAdapter(appId = "test-app"): TerminalAdapter {
    return {
        appId,
        storageDir: undefined,
        sso: {} as never,
        sessions: {} as never,
        destroy: async () => {},
    } as unknown as TerminalAdapter;
}

/** Minimal UserSession stub. */
function fakeSession(): UserSession {
    return {} as unknown as UserSession;
}

// ---------------------------------------------------------------------------
// requestResourceAllocation
// ---------------------------------------------------------------------------

describe("requestResourceAllocation (terminal-facet wrapper)", () => {
    beforeEach(async () => {
        const terminalMock = await getTerminalMock();
        terminalMock.mockClear();
    });

    test("forwards session, adapter, resources, and onExisting to terminal", async () => {
        const terminalMock = await getTerminalMock();
        const expectedOutcomes: AllocationOutcome[] = [
            { tag: "Allocated", value: {} },
        ];
        terminalMock.mockResolvedValueOnce(expectedOutcomes);

        const session = fakeSession();
        const adapter = fakeAdapter("my-product.dot");
        const resources: AllocatableResource[] = [{ tag: "BulletInAllowance", value: undefined }];

        const result = await requestResourceAllocation(session, adapter, resources, "Ignore");

        expect(terminalMock).toHaveBeenCalledOnce();
        const [calledSession, calledAdapter, calledResources, calledOptions] = terminalMock.mock.calls[0];
        expect(calledSession).toBe(session);
        expect(calledAdapter).toBe(adapter);
        expect(calledResources).toBe(resources);
        expect(calledOptions).toEqual({ onExisting: "Ignore" });
        expect(result).toEqual(expectedOutcomes);
    });

    test("uses DEFAULT_RESOURCES when resources argument is omitted", async () => {
        const terminalMock = await getTerminalMock();
        terminalMock.mockResolvedValueOnce([]);

        await requestResourceAllocation(fakeSession(), fakeAdapter());

        const [, , calledResources] = terminalMock.mock.calls[0];
        expect(calledResources).toBe(DEFAULT_RESOURCES);
    });

    test("defaults onExisting to 'Ignore'", async () => {
        const terminalMock = await getTerminalMock();
        terminalMock.mockResolvedValueOnce([]);

        await requestResourceAllocation(fakeSession(), fakeAdapter());

        const [, , , calledOptions] = terminalMock.mock.calls[0];
        expect(calledOptions?.onExisting).toBe("Ignore");
    });

    test("propagates terminal errors to caller", async () => {
        const terminalMock = await getTerminalMock();
        terminalMock.mockRejectedValueOnce(new Error("mobile timed out"));

        await expect(
            requestResourceAllocation(fakeSession(), fakeAdapter()),
        ).rejects.toThrow("mobile timed out",
            ">> FAIL: requestResourceAllocation: terminal errors must propagate to caller");
    });
});

// ---------------------------------------------------------------------------
// summarizeOutcomes
// ---------------------------------------------------------------------------

describe("summarizeOutcomes", () => {
    const resources: AllocatableResource[] = [
        { tag: "BulletInAllowance", value: undefined },
        { tag: "StatementStoreAllowance", value: undefined },
        { tag: "SmartContractAllowance", value: 0 },
    ];

    test("buckets outcomes by tag, mapping outcomes[i] → resources[i]", () => {
        const outcomes: AllocationOutcome[] = [
            { tag: "Allocated", value: {} },
            { tag: "Rejected", value: undefined },
            { tag: "NotAvailable", value: undefined },
        ];
        const summary = summarizeOutcomes(outcomes, resources);
        expect(summary.granted.map((r) => r.tag)).toEqual(["BulletInAllowance"]);
        expect(summary.rejected.map((r) => r.tag)).toEqual(["StatementStoreAllowance"]);
        expect(summary.unavailable.map((r) => r.tag)).toEqual(["SmartContractAllowance"]);
    });

    test("all granted", () => {
        const outcomes: AllocationOutcome[] = resources.map(() => ({ tag: "Allocated", value: {} }));
        const summary = summarizeOutcomes(outcomes, resources);
        expect(summary.granted).toHaveLength(3);
        expect(summary.rejected).toHaveLength(0);
        expect(summary.unavailable).toHaveLength(0);
    });

    test("drops outcomes with no matching resource (index past resources)", () => {
        const outcomes: AllocationOutcome[] = [
            { tag: "Allocated", value: {} },
            { tag: "Allocated", value: {} }, // no resources[1]
        ];
        const summary = summarizeOutcomes(outcomes, [resources[0]]);
        expect(summary.granted).toHaveLength(1);
    });

    test("DEFAULT_RESOURCES carries the three expected allowances", () => {
        expect(DEFAULT_RESOURCES.map((r) => r.tag)).toEqual([
            "BulletInAllowance",
            "StatementStoreAllowance",
            "SmartContractAllowance",
        ]);
    });

    test("DEFAULT_RESOURCES Bulletin entry uses the SSO codec spelling (BulletInAllowance)", () => {
        // RUNTIME ASSERT: the tag must match the SSO codec's spelling.
        // host-api v0.8 renamed this to 'BulletinAllowance', but the SSO resource-allocation
        // codec in host-papp (reached via product-sdk-terminal) retains 'BulletInAllowance'.
        // Ours must match the codec or the SCALE encoder silently mis-encodes the variant.
        const bulletinEntry = DEFAULT_RESOURCES.find((r) => r.tag.startsWith("Bullet"));
        expect(bulletinEntry?.tag).toBe(
            "BulletInAllowance",
            ">> FAIL: allocations tag: must match the SSO codec spelling in product-sdk-terminal (BulletInAllowance — host-api's v0.8 'BulletinAllowance' rename does NOT apply to the SSO surface)",
        );
    });
});
