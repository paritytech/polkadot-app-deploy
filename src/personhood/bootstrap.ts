// Idempotent bootstrap orchestrator for the DotNS personhood binding flow.
//
// Steps (from dotns-consumer-flow.md):
//   1. Recognize (requires sudo/faucet — not automatable, throws RecognizeRequiredError)
//   2. bind-personal-id   (People.set_personal_id_account via AsPerson)
//   3. claim-pgas         (AH.Pgas.claim_pgas via AsPgas)
//   4. bind-paid-alias    (AH.AliasAccounts.set_alias_account, sr25519 signed — §3.2)
//   5. map-account        (AH.Revive.map_account — already done by DotNS.ensureAccountMapped)
//
// Each step is gated on the chain state being "still needs doing". Re-running
// after a partial success resumes from the first incomplete step.

import { createClient } from "polkadot-api";
import { getPolkadotSigner } from "polkadot-api/signer";
import { getWsProvider } from "polkadot-api/ws";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import type { SS58String } from "polkadot-api";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — verifiablejs/nodejs DTS path differs from the types field
import * as verifiable from "verifiablejs/nodejs";

import { loadEnvironments } from "../environments.js";
import { WS_HEARTBEAT_TIMEOUT_MS } from "../dotns.js";
import { bytesToHex } from "./encoding.js";
import { DOTNS_CONTEXT_BYTES, PGAS_ASSET_ID, PEOPLE_MEMBER_IDENTIFIER_HEX } from "./constants.js";
import { deriveMemberEntropy, deriveMemberKey } from "./member-key.js";
import { bindPersonalIdToAccount } from "./bind-personal-id.js";
import { claimPgas, type BuildRingProof } from "./claim-pgas.js";
import { bindPaidAliasToAccount } from "./bind-paid-alias.js";
import { runChainPrereqProbes } from "./chain-prereqs.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BootstrapState {
  recognized: boolean;              // member key present in People.Members.Members
  personalIdBound: boolean;         // People.AccountToPersonalId(ss58) ⇒ personalId
  pgasBalance: bigint;              // Assets.Account(PGAS_ASSET_ID, ss58)
  paidAliasFee: bigint;             // AliasAccounts.AliasFee (§3.1: storage renamed from PaidAliasFee)
  aliasBound: {
    paid: boolean;
    contextHex: string;
    revision: number;
  } | null;
  reviveMapped: boolean;            // Revive.OriginalAccount(evmAddress) ⇒ ss58
}

export interface BootstrapResult {
  initialState: BootstrapState;
  actionsExecuted: Array<
    "bind-personal-id" | "claim-pgas" | "bind-paid-alias" | "map-account"
  >;
  finalState: BootstrapState;
}

// ---------------------------------------------------------------------------
// Loose API shapes
// ---------------------------------------------------------------------------

type AhApi = {
  query: {
    People?: {
      AccountToPersonalId?: {
        getValue: (who: SS58String, opts?: { at: string }) => Promise<bigint | undefined>;
      };
    };
    Assets: {
      Account: {
        getValue: (id: number, who: SS58String, opts?: { at: string }) => Promise<{ balance: bigint } | undefined>;
      };
    };
    AliasAccounts: {
      // §3.1: Storage renamed from PaidAliasFee → AliasFee (individuality#955).
      AliasFee: { getValue: (opts?: { at: string }) => Promise<bigint | undefined> };
      AccountToAlias: {
        getValue: (who: SS58String, opts?: { at: string }) => Promise<{
          // NOTE: `paid` field removed in individuality#955.
          ca: { context: string };
          revision: number;
        } | undefined>;
      };
    };
  };
};

type PeopleApi = {
  query: {
    Members: {
      Members: {
        getValue: (
          ident: string,
          memberKey: string,
          opts?: { at: string },
        ) => Promise<{ type: "Included" | string } | undefined>;
      };
    };
    People?: {
      AccountToPersonalId?: {
        getValue: (who: SS58String, opts?: { at: string }) => Promise<bigint | undefined>;
      };
    };
  };
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class RecognizeRequiredError extends Error {
  constructor() {
    super(
      "This account has not been recognised by the personhood faucet. " +
        "Request recognition from your chain's personhood authority, " +
        "then re-run the bootstrap.",
    );
    this.name = "RecognizeRequiredError";
  }
}

// ---------------------------------------------------------------------------
// Probe state
// ---------------------------------------------------------------------------

/**
 * Probe the current bootstrap state from chain for a given account.
 * All reads are at "best" block — suitable for sequential flow decisions.
 */
export async function probeBootstrapState({
  peopleUnsafeApi,
  ahUnsafeApi,
  memberKey,
  account,
}: {
  peopleUnsafeApi: unknown;
  ahUnsafeApi: unknown;
  memberKey: Uint8Array;
  account: SS58String;
}): Promise<BootstrapState> {
  const { PEOPLE_MEMBER_IDENTIFIER_HEX } = await import("./constants.js");

  const people = peopleUnsafeApi as unknown as PeopleApi;
  const ah = ahUnsafeApi as unknown as AhApi;

  const [memberPosition, pgasAcct, feeRaw, aliasRow] = await Promise.all([
    people.query.Members.Members.getValue(PEOPLE_MEMBER_IDENTIFIER_HEX, bytesToHex(memberKey), { at: "best" }),
    ah.query.Assets.Account.getValue(PGAS_ASSET_ID, account, { at: "best" }),
    // §3.1: Storage renamed from PaidAliasFee → AliasFee (individuality#955).
    ah.query.AliasAccounts.AliasFee.getValue({ at: "best" }),
    ah.query.AliasAccounts.AccountToAlias.getValue(account, { at: "best" }),
  ]);

  const recognized = memberPosition?.type === "Included";

  // PersonalId bound: check People.People.AccountToPersonalId (if pallet exists).
  let personalIdBound = false;
  const peoplePersonal =
    (people.query as unknown as { People?: { AccountToPersonalId?: { getValue: (a: SS58String, opts?: { at: string }) => Promise<unknown> } } }).People;
  if (peoplePersonal?.AccountToPersonalId) {
    const personalId = await peoplePersonal.AccountToPersonalId.getValue(account, { at: "best" });
    personalIdBound = personalId !== undefined;
  }

  const pgasBalance = pgasAcct?.balance ?? 0n;
  const paidAliasFee = feeRaw ?? 0n;

  const aliasBound = aliasRow
    ? {
        // NOTE: `paid` field removed from AccountToAlias in individuality#955.
        // Treat all bound aliases as paid (AliasFee applies to everyone).
        paid: true,
        contextHex: aliasRow.ca.context,
        revision: aliasRow.revision,
      }
    : null;

  // reviveMapped: we can't easily check from here without the EVM address.
  // Set to true if alias is bound (implies map_account was done beforehand).
  const reviveMapped = aliasRow !== undefined && aliasRow !== null;

  return {
    recognized,
    personalIdBound,
    pgasBalance,
    paidAliasFee,
    aliasBound,
    reviveMapped,
  };
}

/**
 * Determine the next action needed given the current bootstrap state.
 * Returns null when the flow is complete.
 */
export function nextBootstrapAction(
  state: BootstrapState,
): "bind-personal-id" | "claim-pgas" | "bind-paid-alias" | null {
  if (!state.personalIdBound) return "bind-personal-id";
  if (state.pgasBalance < state.paidAliasFee) return "claim-pgas";
  if (!state.aliasBound?.paid) return "bind-paid-alias";
  return null;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Test-only injection seam for `runBootstrap`. When provided, the real WS
 * connections and environment lookup are bypassed entirely.
 *
 * @internal — not part of the public API.
 */
export interface RunBootstrapTestApis {
  /** Pre-built AH unsafe API (replaces `ahClient.getUnsafeApi()`). */
  ahUnsafeApi: unknown;
  /** Pre-built People unsafe API (replaces `peopleClient.getUnsafeApi()`). */
  peopleUnsafeApi: unknown;
  /**
   * Mock AH client. Only `destroy` and `submitAndWatch` are used by bootstrap;
   * a no-op `destroy` is sufficient when the test step doesn't submit.
   */
  ahClient: { destroy: () => void; submitAndWatch?: unknown };
  /**
   * Mock People client. Only `destroy` and `submitAndWatch` are used.
   */
  peopleClient: { destroy: () => void; submitAndWatch?: unknown };
  /** Override `bindPersonalIdToAccount` (defaults to the real import). */
  bindPersonalIdToAccount?: typeof bindPersonalIdToAccount;
  /** Override `claimPgas` (defaults to the real import). */
  claimPgas?: typeof claimPgas;
  /** Override `bindPaidAliasToAccount` (defaults to the real import). */
  bindPaidAliasToAccount?: typeof bindPaidAliasToAccount;
  /**
   * Override `runChainPrereqProbes` (defaults to the real import).
   * Tests can inject a no-op or a function that throws to verify probe
   * failure is handled correctly.
   */
  runChainPrereqProbes?: typeof runChainPrereqProbes;
}

export async function runBootstrap({
  mnemonic,
  environmentId,
  requireRecognized = true,
  _testApis,
}: {
  mnemonic: string;
  environmentId: string;
  requireRecognized?: boolean;
  /**
   * Test-only: inject pre-built API objects and function overrides.
   * When set the real WS connections and environment lookup are skipped.
   */
  _testApis?: RunBootstrapTestApis;
}): Promise<BootstrapResult> {
  await cryptoWaitReady();

  let ahClient: { destroy: () => void; getUnsafeApi?: () => unknown; submitAndWatch?: unknown };
  let peopleClient: { destroy: () => void; getUnsafeApi?: () => unknown; submitAndWatch?: unknown };
  let ahUnsafeApiResolved: unknown;
  let peopleUnsafeApiResolved: unknown;

  if (_testApis) {
    ahClient = _testApis.ahClient;
    peopleClient = _testApis.peopleClient;
    ahUnsafeApiResolved = _testApis.ahUnsafeApi;
    peopleUnsafeApiResolved = _testApis.peopleUnsafeApi;
  } else {
    const { doc } = await loadEnvironments();
    const ahChain = doc.chains.find((c) => c.id === "asset-hub");
    const peopleChain = doc.chains.find((c) => c.id === "people");
    if (!ahChain || !peopleChain) {
      throw new Error("environments.json missing asset-hub or people chain");
    }
    const ahEntry = ahChain.endpoints[environmentId];
    const peopleEntry = peopleChain.endpoints[environmentId];
    if (!ahEntry || !peopleEntry) {
      throw new Error(
        `No endpoints for environment '${environmentId}'. Bootstrap is only available on paseo-next-v2.`,
      );
    }
    const ahWss = Array.isArray(ahEntry.wss) ? ahEntry.wss[0] : ahEntry.wss;
    const peopleWss = Array.isArray(peopleEntry.wss) ? peopleEntry.wss[0] : peopleEntry.wss;

    const realAhClient = createClient(
      getWsProvider(ahWss, { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS }),
    );
    const realPeopleClient = createClient(
      getWsProvider(peopleWss, { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS }),
    );
    ahClient = realAhClient;
    peopleClient = realPeopleClient;
    ahUnsafeApiResolved = realAhClient.getUnsafeApi();
    peopleUnsafeApiResolved = realPeopleClient.getUnsafeApi();
  }

  try {
    const keyring = new Keyring({ type: "sr25519" });
    const account = keyring.addFromMnemonic(mnemonic);
    const ss58 = account.address as SS58String;
    const signer = getPolkadotSigner(
      account.publicKey,
      "Sr25519",
      async (input: Uint8Array) => account.sign(input),
    );

    const memberKey = deriveMemberKey(mnemonic);
    const memberEntropy = deriveMemberEntropy(mnemonic);

    const ahUnsafeApi = ahUnsafeApiResolved;
    const peopleUnsafeApi = peopleUnsafeApiResolved;

    const initialState = await probeBootstrapState({
      peopleUnsafeApi,
      ahUnsafeApi,
      memberKey,
      account: ss58,
    });

    if (requireRecognized && !initialState.recognized) {
      throw new RecognizeRequiredError();
    }

    const actionsExecuted: BootstrapResult["actionsExecuted"] = [];
    let currentState = { ...initialState };

    // Run chain prerequisite probes before any chain submission. These are
    // read-only checks for operator-controlled chain state that must exist
    // before any of the below steps can succeed. Fails fast on the first
    // missing prerequisite. Skip probes when all steps are already complete
    // to avoid unnecessary RPC calls on no-op bootstraps. See
    // docs-internal/dotns-bootstrap-handover.md §6.
    if (nextBootstrapAction(currentState) !== null) {
      const _runChainPrereqProbes = _testApis?.runChainPrereqProbes ?? runChainPrereqProbes;
      await _runChainPrereqProbes(ahUnsafeApi, PEOPLE_MEMBER_IDENTIFIER_HEX);
    }

    // Step 2: bind personal ID if not yet done.
    if (!currentState.personalIdBound) {
      const memberKeyHex = ("0x" + Array.from(memberKey, (b) => b.toString(16).padStart(2, "0")).join("")) as `0x${string}`;
      const peoplePeopleStore = (peopleUnsafeApi as unknown as {
        query: { People?: { Keys?: { getValue: (k: string, opts?: { at: string }) => Promise<bigint | undefined> } } };
      }).query.People;
      const personalId = await peoplePeopleStore?.Keys?.getValue(memberKeyHex, { at: "best" });
      if (personalId === undefined || personalId === null) {
        throw new Error(
          `cannot bind personal id: People.Keys[${memberKeyHex}] is not set on this chain. Visit the personhood faucet first.`,
        );
      }
      const _bindPersonalId = _testApis?.bindPersonalIdToAccount ?? bindPersonalIdToAccount;
      await _bindPersonalId({
        typedApi: peopleUnsafeApi,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: peopleClient as any,
        personalId,
        account: ss58,
        signMember: (msg: Uint8Array) => verifiable.sign(memberEntropy, msg),
      });
      actionsExecuted.push("bind-personal-id");
      currentState = await probeBootstrapState({
        peopleUnsafeApi,
        ahUnsafeApi,
        memberKey,
        account: ss58,
      });
    }

    const buildRingProof: BuildRingProof = async ({ ringExponent, members, context, msg }) => {
      const result = verifiable.one_shot(ringExponent, memberEntropy, members, context, msg);
      return { proof: result.proof, alias: result.alias };
    };

    // Step 3: claim PGAS if balance insufficient.
    if (currentState.pgasBalance < currentState.paidAliasFee) {
      const _claimPgas = _testApis?.claimPgas ?? claimPgas;
      await _claimPgas({
        peopleUnsafeApi,
        ahUnsafeApi,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ahClient: ahClient as any,
        target: ss58,
        memberKey,
        buildRingProof,
      });
      actionsExecuted.push("claim-pgas");
      currentState = await probeBootstrapState({
        peopleUnsafeApi,
        ahUnsafeApi,
        memberKey,
        account: ss58,
      });
    }

    // Step 4: bind paid alias if not yet done.
    if (!currentState.aliasBound?.paid) {
      const _bindPaidAlias = _testApis?.bindPaidAliasToAccount ?? bindPaidAliasToAccount;
      await _bindPaidAlias({
        peopleUnsafeApi,
        ahUnsafeApi,
        account: ss58,
        memberKey,
        contextBytes: DOTNS_CONTEXT_BYTES,
        signCall: signer,
        buildRingProof,
      });
      actionsExecuted.push("bind-paid-alias");
      currentState = await probeBootstrapState({
        peopleUnsafeApi,
        ahUnsafeApi,
        memberKey,
        account: ss58,
      });
    }

    return { initialState, actionsExecuted, finalState: currentState };
  } finally {
    try { ahClient.destroy(); } catch {}
    try { peopleClient.destroy(); } catch {}
  }
}
