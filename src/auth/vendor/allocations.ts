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
 *   - caching granted key material to disk as `{appId}_AllowanceKeys.json`
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
} from "@parity/product-sdk-terminal/host";

/**
 * Structural mirror of host-papp's `ApAllocatableResource` codec type. We
 * declare it locally because host-papp's package root doesn't re-export the
 * codec types yet — when it does (and product-sdk-terminal threads them
 * through) this can be replaced with a direct import.
 *
 *   StatementStoreAllowance — write to the SSS (host_chat, allowance ring).
 *   BulletInAllowance       — write to Bulletin (TransactionStorage.store).
 *   SmartContractAllowance  — PGAS sponsoring for Revive contract calls.
 *                             The `value` is the derivation index of the
 *                             product account (0 for the default account).
 *   AutoSigning             — surrender the product-account signing key to
 *                             the host so it can sign on the user's behalf
 *                             without per-call prompts. Not used today.
 *
 * NOTE: host-api v0.8 renamed this variant to 'BulletinAllowance', but the
 * SSO resource-allocation codec (host-papp, which this path reaches via
 * product-sdk-terminal) retains the old 'BulletInAllowance' spelling as of
 * host-papp 0.8.5 / terminal 0.3.1. Ours must match the SSO codec — the
 * _SDK_COMPAT_PIN below fails the build if the SDK's spelling ever changes.
 */
export type AllocatableResource =
    | { tag: "StatementStoreAllowance"; value: undefined }
    | { tag: "BulletInAllowance"; value: undefined }
    | { tag: "SmartContractAllowance"; value: number }
    | { tag: "AutoSigning"; value: undefined };

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

export type OnExistingAllowancePolicy = "Ignore" | "Increase";

/**
 * Default mobile-granted resource set for a CLI product account: write access
 * to the statement store + Bulletin, plus PGAS sponsoring for the default
 * (index 0) product account.
 */
export const DEFAULT_RESOURCES: AllocatableResource[] = [
    { tag: "BulletInAllowance", value: undefined },
    { tag: "StatementStoreAllowance", value: undefined },
    // derivation index 0 = the default product account.
    { tag: "SmartContractAllowance", value: 0 },
];

// Compile-time pin: DEFAULT_RESOURCES must be assignable to the SDK's own
// resource type derived from UserSession["requestResourceAllocation"]. If this
// assignment ever fails to compile, our spelling has drifted from the SSO codec
// — fix ours, not the SDK's. Same derivation as product-sdk-terminal/dist/host.d.ts:53.
type _SdkResource = Parameters<UserSession["requestResourceAllocation"]>[0]["resources"][number];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _SDK_COMPAT_PIN: _SdkResource[] = DEFAULT_RESOURCES;

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
 * to disk by the terminal facet (`{appId}_AllowanceKeys.json`) so subsequent
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
    resources: AllocatableResource[] = DEFAULT_RESOURCES,
    onExisting: OnExistingAllowancePolicy = "Ignore",
): Promise<AllocationOutcome[]> {
    const outcomes = await terminalRequestResourceAllocation(session, adapter, resources, { onExisting });
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
 * (`{appId}_AllowanceKeys.json`) written by `requestResourceAllocation`.
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
): Promise<import("polkadot-api").PolkadotSigner | null> {
    return terminalCreateSlotAccountSigner(adapter, resource);
}
