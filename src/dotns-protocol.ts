// DotNS protocol-version abstraction.
//
// Two DotNS deployment generations are live at the same time (2026-09-01
// drift — paseo-next-v2 redeployed its DotNS contracts at identical CREATE3
// addresses with a changed ABI, while other deployments still run the old
// bytecode). Of the environments configured here, paseo-next-v2 is v2 and
// devnet is not E2E-eligible, so v1 has no CI coverage in this repo — which
// is exactly why the v1 path below must stay behaviour-identical to what
// shipped before this change rather than being "cleaned up" alongside v2.
//
//   v1 (the pre-drift generation):
//     - Registration tuple: (label, owner, secret, reserved) — 4 fields.
//     - NoStatus deposit gate reads PopRules.startingPrice() (flat, no args).
//     - PopRules.pricingVersion() does not exist (reverts).
//
//   v2 (`paseo-next-v2`):
//     - Registration tuple: (label, owner, secret, reserved, maxPrice,
//       pricingVersion) — 6 fields. Field order is load-bearing: both new
//       fields are uint256, so a swap still encodes and still produces a
//       valid selector — it only fails later at register() after a commit
//       has been paid for.
//     - NoStatus deposit gate reads PopRules.price(label) (per-label).
//     - PopRules.startingPrice() has been removed (reverts).
//
// CREATE3 keeps contract addresses identical across generations, so the ABI
// shape is the only reliable discriminator — hence the live probe in
// dotns.ts's connect() and the classification helper below. This module has
// no chain I/O of its own: everything here is pure, so it is unit-testable
// without a node.

export type DotnsProtocolVersion = "v1" | "v2";

/** Inputs to classifyProtocolVersion — the live dry-run results from connect(). */
export interface DotnsProtocolProbe {
  /** Whether POP_RULES has contract code at all (a prerequisite, not a verdict). */
  hasCode: boolean;
  /** Whether a dry-run call to PopRules.pricingVersion() completed without reverting. */
  pricingVersionOk: boolean;
  /** Whether a dry-run call to PopRules.startingPrice() completed without reverting. */
  startingPriceOk: boolean;
}

export type DotnsProtocolClassification =
  | { version: DotnsProtocolVersion }
  | { version: null; reason: string };

/**
 * Pure, three-valued classification of the live DotNS protocol generation.
 *
 * - No contract code at POP_RULES is NOT a version verdict — it is a
 *   configuration problem (wrong/undeployed address), so it gets its own
 *   reason distinct from "unknown generation".
 * - Code present but neither probe answers is an explicit unknown-version
 *   error naming BOTH probes, so the failure is diagnosable rather than
 *   silently falling back to v1 (a silent v1 fallback here is exactly the
 *   failure mode this whole module exists to prevent).
 * - Both probes answering (a hypothetical future overlap) prefers v2 — v2 is
 *   the superset generation, and preferring the newer one avoids stranding a
 *   fully-upgraded deployment on the old ABI just because the old function
 *   selector happens to still resolve.
 */
export function classifyProtocolVersion(probe: DotnsProtocolProbe): DotnsProtocolClassification {
  const { hasCode, pricingVersionOk, startingPriceOk } = probe;
  if (!hasCode) {
    return { version: null, reason: "No contract code at POP_RULES — cannot determine the DotNS protocol version." };
  }
  if (pricingVersionOk) return { version: "v2" };
  if (startingPriceOk) return { version: "v1" };
  return {
    version: null,
    reason: "Could not determine the DotNS protocol version: contract code is present at POP_RULES, but neither pricingVersion() (v2) nor startingPrice() (v1) answered.",
  };
}

/** The 4 fields every registration carries, regardless of protocol version. */
export interface DotnsRegistrationBase {
  label: string;
  owner: string;
  secret: string;
  reserved: boolean;
}

/**
 * Pricing facts needed to build a v2 registration tuple. Both fields are
 * optional at the type level so a v1 caller (which ignores this argument
 * entirely) can pass `{}`; the v2 adapter enforces its own requirements at
 * build time and throws with a specific, named reason when a required field
 * is missing.
 */
export interface DotnsPricingInput {
  priceWei?: bigint;
  pricingVersion?: bigint;
}

/** A view-function call description: which function to call and with what args. */
export interface DotnsDepositCall {
  functionName: string;
  args: unknown[];
}

export interface DotnsProtocolAdapter {
  readonly version: DotnsProtocolVersion;
  /**
   * True when pricing (maxPrice + pricingVersion) must be resolved BEFORE
   * makeCommitment/commit, because it is part of the committed tuple (v2).
   * False when pricing is resolved after commit, unaffected by the tuple
   * (v1 — today's behaviour, must stay byte-for-byte identical).
   */
  readonly needsPricingBeforeCommit: boolean;
  /** This version's RegistrarController ABI fragment (makeCommitment/register vary in tuple shape; commit/commitments/minCommitmentAge/maxCommitmentAge are identical across versions but included here too so callers have a single ABI source). */
  readonly controllerAbi: readonly any[];
  /** This version's PopRules ABI fragment for the functions THIS adapter calls directly (the deposit-gate read, plus pricingVersion/priceWithCheckAtVersion on v2). Functions unchanged across versions (price, priceWithCheck, classifyName, etc.) are called via the shared ABI in dotns.ts and never need to go through here. */
  readonly popRulesAbi: readonly any[];
  /** Build the on-chain registration tuple for this version from the base fields + pricing facts. */
  buildRegistration(base: DotnsRegistrationBase, pricing: DotnsPricingInput): Record<string, unknown>;
  /** Which PopRules view function (and args) resolves the NoStatus deposit gate on this version. */
  depositCall(label: string): DotnsDepositCall;
}

const REGISTRATION_COMPONENTS_V1 = [
  { name: "label", type: "string" },
  { name: "owner", type: "address" },
  { name: "secret", type: "bytes32" },
  { name: "reserved", type: "bool" },
] as const;

const REGISTRATION_COMPONENTS_V2 = [
  ...REGISTRATION_COMPONENTS_V1,
  { name: "maxPrice", type: "uint256" },
  { name: "pricingVersion", type: "uint256" },
] as const;

export const V1_CONTROLLER_ABI = [
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_V1 }], name: "makeCommitment", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "minCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "maxCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commitments", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_V1 }], name: "register", outputs: [], stateMutability: "payable", type: "function" },
] as const;

export const V2_CONTROLLER_ABI = [
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_V2 }], name: "makeCommitment", outputs: [{ name: "", type: "bytes32" }], stateMutability: "pure", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "minCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "maxCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commitments", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_V2 }], name: "register", outputs: [], stateMutability: "payable", type: "function" },
] as const;

const PRICE_WITH_CHECK_METADATA_OUTPUT = {
  name: "metadata", type: "tuple", components: [
    { name: "price", type: "uint256" },
    { name: "status", type: "uint8" },
    { name: "userStatus", type: "uint8" },
    { name: "message", type: "string" },
  ],
} as const;

export const V1_POP_RULES_ABI = [
  { inputs: [], name: "startingPrice", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

export const V2_POP_RULES_ABI = [
  { inputs: [{ name: "name", type: "string" }], name: "price", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "pricingVersion", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "name", type: "string" }, { name: "userAddress", type: "address" }, { name: "version", type: "uint256" }], name: "priceWithCheckAtVersion", outputs: [PRICE_WITH_CHECK_METADATA_OUTPUT], stateMutability: "view", type: "function" },
] as const;

/** finalizeRegistration's existing +10% payment buffer — maxPrice must agree with the amount actually sent, so they share this exact formula. */
function withTenPercentBuffer(priceWei: bigint): bigint {
  return (priceWei * 110n) / 100n;
}

const v1Adapter: DotnsProtocolAdapter = {
  version: "v1",
  needsPricingBeforeCommit: false,
  controllerAbi: V1_CONTROLLER_ABI,
  popRulesAbi: V1_POP_RULES_ABI,
  buildRegistration(base) {
    // v1's tuple is unchanged: 4 fields, in the exact order the contract
    // (and every existing v1 call site/test) already expects. Pricing is
    // deliberately ignored — v1 resolves it AFTER commit, unaffected by the
    // committed tuple, exactly as today.
    return { label: base.label, owner: base.owner, secret: base.secret, reserved: base.reserved };
  },
  depositCall() {
    return { functionName: "startingPrice", args: [] };
  },
};

const v2Adapter: DotnsProtocolAdapter = {
  version: "v2",
  needsPricingBeforeCommit: true,
  controllerAbi: V2_CONTROLLER_ABI,
  popRulesAbi: V2_POP_RULES_ABI,
  buildRegistration(base, pricing) {
    if (pricing.pricingVersion === undefined) {
      throw new Error(
        "DotNS v2 registration requires pricing.pricingVersion (read PopRules.pricingVersion() before committing — it must be known before makeCommitment since it is part of the committed tuple).",
      );
    }
    if (pricing.priceWei === undefined) {
      throw new Error("DotNS v2 registration requires pricing.priceWei to compute maxPrice.");
    }
    // Field order is load-bearing: both maxPrice and pricingVersion are
    // uint256, so a swap still encodes and still produces a valid selector
    // — it only surfaces as a revert later, at register(), after the commit
    // tx has already been paid for.
    return {
      label: base.label,
      owner: base.owner,
      secret: base.secret,
      reserved: base.reserved,
      maxPrice: withTenPercentBuffer(pricing.priceWei),
      pricingVersion: pricing.pricingVersion,
    };
  },
  depositCall(label) {
    return { functionName: "price", args: [label] };
  },
};

export function getAdapter(version: DotnsProtocolVersion): DotnsProtocolAdapter {
  return version === "v2" ? v2Adapter : v1Adapter;
}
