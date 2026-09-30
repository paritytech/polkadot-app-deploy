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
 * RFC-0010 resource allocation — thin wrapper over product-sdk-terminal's
 * host-runner facet. Lifted from playground-cli `src/utils/allowances/host.ts`
 * (issue #411).
 *
 * `@parity/product-sdk-terminal/host` exports `requestResourceAllocation(session,
 * adapter, resources, options?)` which handles:
 *   - sending the AP request to the paired mobile wallet
 *   - the `onExisting` policy (default auto-picks "Ignore" unless all requested
 *     resources are already slot-table cached, then "Increase")
 *   - caching granted key material to disk as `{productId}_AllowanceKeys.json`
 *     (the same file our storage-signer reads — verified compat-stable in PR #855)
 *
 * Wire format (SCALE-derived, mirrors host-papp's
 * `dist/sso/sessionManager/scale/resourceAllocation.d.ts`):
 *   request  → { callingProductId, resources: AllocatableResource[], onExisting }
 *   response → AllocationOutcome[] (one per resource, in order)
 *
 * The mobile app handles `hostRequestResourceAllocation` in
 * `AllowanceHostCalls.kt` and routes the user through an approval UI.
 */

import type { UserSession } from "@parity/product-sdk-terminal";
import type { TerminalAdapter } from "@parity/product-sdk-terminal";
import {
    requestResourceAllocation as terminalRequestResourceAllocation,
    createSlotAccountSigner as terminalCreateSlotAccountSigner,
    type AllocatableResource,
    type OnExistingAllowancePolicy,
} from "@parity/product-sdk-terminal/host";

// The SSO codec spells it `BulletInAllowance`; host-api's `BulletinAllowance` does not apply here.
export type { AllocatableResource, OnExistingAllowancePolicy } from "@parity/product-sdk-terminal/host";

/**
 * Outcome of one allocation. We don't read the inner `Allocated` payload
 * (allowance slot keys, derivation secrets) — the host stores them and uses
 * them transparently on subsequent calls. We just need the tag to know
 * whether the allocation succeeded.
 */
export type AllocationOutcome =
    | { tag: "Allocated"; value: unknown }
    | { tag: "Rejected"; value: undefined }
    | { tag: "NotAvailable"; value: undefined };

/** Tag-only view, handy for downstream code that doesn't care about payloads. */
export type ResourceTag = AllocatableResource["tag"];

/**
 * Default mobile-granted resource set for a CLI product account: write access
 * to the statement store + Bulletin, plus PGAS sponsoring for the default
 * (index 0) product account.
 */
export const DEFAULT_RESOURCES: AllocatableResource[] = [
    { tag: "BulletInAllowance", value: undefined },
    { tag: "StatementStoreAllowance", value: undefined },
    { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
];

/**
 * The BulletInAllowance resource singleton. Callers that only need this one
 * resource (e.g. createSlotAccountSigner) use this constant instead of
 * constructing the literal — keeps the SSO codec spelling in one place.
 */
export const BULLETIN_RESOURCE: AllocatableResource = { tag: "BulletInAllowance", value: undefined };

/**
 * Send a `host_request_resource_allocation` request over the user's active
 * session. The host (mobile wallet) prompts the user to approve and returns
 * one outcome per requested resource in order. Granted key material is cached
 * to disk by the terminal facet (`{productId}_AllowanceKeys.json`) so subsequent
 * calls (and the storage-signer reader) find it without a second wallet prompt.
 *
 * Throws on transport-level failures (Statement Store unreachable, encryption
 * error, etc.). Per-resource refusals are reported as `Rejected`/`NotAvailable`
 * outcomes — callers inspect the array to decide whether to proceed.
 *
 * `onExisting` is pinned to "Ignore": return existing cached keys if any, else
 * allocate a new slot. Auto-pick would give "Increase" when all slot-table
 * resources are already cached, which re-prompts the user unnecessarily.
 */
export async function requestResourceAllocation(
    session: UserSession,
    adapter: TerminalAdapter,
    productId: string,
    resources: AllocatableResource[] = DEFAULT_RESOURCES,
    onExisting: OnExistingAllowancePolicy = "Ignore",
): Promise<AllocationOutcome[]> {
    const outcomes = await terminalRequestResourceAllocation(session, adapter, resources, { onExisting, productId });
    return outcomes as AllocationOutcome[];
}

export interface AllocationSummary {
    granted: AllocatableResource[];
    rejected: AllocatableResource[];
    unavailable: AllocatableResource[];
}

/**
 * Bucket allocation outcomes by tag. Order-sensitive: `outcomes[i]` maps to
 * `resources[i]`. Outcomes without a matching resource are silently dropped.
 */
export function summarizeOutcomes(
    outcomes: AllocationOutcome[],
    resources: AllocatableResource[],
): AllocationSummary {
    const granted: AllocatableResource[] = [];
    const rejected: AllocatableResource[] = [];
    const unavailable: AllocatableResource[] = [];
    outcomes.forEach((outcome, i) => {
        const resource = resources[i];
        if (!resource) return;
        if (outcome.tag === "Allocated") granted.push(resource);
        else if (outcome.tag === "Rejected") rejected.push(resource);
        else unavailable.push(resource);
    });
    return { granted, rejected, unavailable };
}

/**
 * Read a previously allocated slot signer from the terminal cache
 * (`{productId}_AllowanceKeys.json`) written by `requestResourceAllocation`.
 *
 * Returns `null` on a cache miss — never triggers a phone prompt. Use this
 * instead of `adapter.allowance.getBulletinSigner()` when the allocation has
 * already been claimed in the same session (e.g. after a successful
 * `requestResourceAllocation(DEFAULT_RESOURCES)` call) so that step 2 of the
 * login flow is a guaranteed cache-hit with zero additional wallet interaction.
 *
 * Throws only for SmartContractAllowance / AutoSigning resources (not applicable
 * to BulletInAllowance). Returns `null` for BulletInAllowance when no cached
 * entry exists.
 */
export async function createSlotAccountSigner(
    adapter: TerminalAdapter,
    resource: AllocatableResource,
    productId: string,
): Promise<import("polkadot-api").PolkadotSigner | null> {
    return terminalCreateSlotAccountSigner(adapter, resource, productId);
}
