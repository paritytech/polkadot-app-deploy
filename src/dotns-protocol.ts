// DotNS ABI-profile abstraction.
//
// polkadot-app-deploy talks to two DotNS deployment generations that are (or
// have been) live at the same time — a testnet redeployed its DotNS
// contracts at identical CREATE3 addresses with a changed ABI, while another
// testnet still ran the old bytecode.
//
//   poprules-startingPrice:
//     - Registration tuple: (label, owner, secret, reserved) — 4 fields.
//     - NoStatus deposit gate reads PopRules.startingPrice() (flat, no args).
//     - PopRules.pricingVersion() does not exist (reverts).
//     - Named after its discriminator function, NOT an upstream tag: this
//       shape held over an observed range of upstream releases, but the
//       floor isn't independently established far enough back to assert a
//       tag here without re-checking. Do NOT attach a tag to this profile
//       without re-verifying that first.
//
//   v0.5.8-rc1:
//     - Named after the upstream tag that introduced it — diffing the
//       published ABI across release assets shows v0.5.8-rc1 is exactly the
//       tag that added pricingVersion/priceWithCheckAtVersion and removed
//       startingPrice.
//     - Registration tuple: (label, owner, secret, reserved, maxPrice,
//       pricingVersion) — 6 fields. Field order is load-bearing: both new
//       fields are uint256, so a swap still encodes and still produces a
//       valid selector — it only fails later at register() after a commit
//       has been paid for.
//     - NoStatus deposit gate reads PopRules.price(label) (per-label).
//     - PopRules.startingPrice() has been removed (reverts).
//
//   v0.6.0 (released 2026-09-07. Generations go live per environment, NOT
//   per release, so at any time the fleet may be mixed: never assume a
//   single live generation, and never read a date in a comment as current —
//   probe.):
//     - ENCODING is IDENTICAL to v0.5.8-rc1 — every function we declare is
//       byte-identical except startingPrice, which is the OLD profile's own
//       function and was never expected to exist here. Registration tuple,
//       controllerAbi, popRulesAbi, needsPricingBeforeCommit and depositCall
//       are all reused verbatim from v0.5.8-rc1 — see getAdapter below.
//     - The break is SEMANTIC, not structural: PopRules._classifyValidatedName
//       (mirrored by classifyLabelStatus in dotns.ts) now computes base
//       length as the label AS WRITTEN — it no longer strips trailing
//       digits from an ordinary name. Only a lite personhood username (the
//       gateway-issued `stem.NN` shape) still sheds its separator and its
//       two allocated digits. See classifyLabelStatus's own v0.6.0 branch.
//     - DISCRIMINATOR CANNOT BE PopRules-based: v0.6.0 is signature-identical
//       to v0.5.8-rc1 on every PopRules function, INCLUDING pricingVersion()
//       — so a capability probe on PopRules alone cannot tell the two apart.
//       The discriminator instead probes a DIFFERENT contract:
//       DotnsPopController.isPopIssued(label), new in v0.6.0 (absent from
//       the poprules-startingPrice/v0.5.8-rc1 generations). A dry-run call
//       answering (not reverting) is itself positive proof of the new
//       function's presence — the same "a probe answering is proof" posture
//       classifyProtocolVersion already uses for pricingVersion/startingPrice.
//       See DotnsProtocolProbe.isPopIssuedOk and classifyProtocolVersion
//       below for the exact wiring (including the fallback when
//       DOTNS_POP_CONTROLLER has no configured address).
//
// CREATE3 keeps contract addresses identical across generations, so the ABI
// shape is the only reliable discriminator — hence the live probe in
// dotns.ts's connect() and the classification helper below. This module has
// no chain I/O of its own: everything here is pure, so it is unit-testable
// without a node. `getAdapter` is the single seam a future artifact-consuming
// refactor would touch to swap where these ABI arrays come from, without
// touching any call site.
//
// IMPORTANT: the `introducedAt` tag below is provenance ASSERTED from
// published upstream release artifacts (diffed offline) — it is NOT
// something detected from the chain. Runtime detection (classifyProtocolVersion)
// stays capability-based: it probes for the discriminating function and
// never reads a version/tag off-chain or on-chain. Nobody should read the
// tag as "what release this chain is running" — only as "what upstream
// artifact this profile's ABI shape matches".

export type DotnsAbiProfile = "poprules-startingPrice" | "v0.5.8-rc1" | "v0.6.0";

/** One DotNS ABI profile's provenance: the upstream artifact it corresponds to, and how the live probe recognises it. */
export interface DotnsAbiProfileInfo {
  /**
   * The upstream `paritytech/dotns` tag that introduced this ABI shape, or
   * `null` when the floor is not independently established (see this
   * profile's own comment above `DOTNS_ABI_PROFILES`). Never invent a tag
   * here to fill this in — an unverified tag is exactly the over-claim this
   * field exists to prevent.
   */
  introducedAt: string | null;
  /** The `dotns-abis-<tag>.zip` release asset this profile's ABI shape matches, or `null` when unknown. */
  abiPackage: string | null;
  /**
   * The view function whose presence (probed live, never read from the
   * chain as a version) identifies this profile. For the first two
   * profiles this is a PopRules function; v0.6.0's discriminator
   * (isPopIssued) lives on DotnsPopController instead, because v0.6.0 is
   * signature-identical to v0.5.8-rc1 on every PopRules function — see the
   * module doc comment above for why that forced a different contract.
   */
  discriminator: string;
}

export const DOTNS_ABI_PROFILES: Record<DotnsAbiProfile, DotnsAbiProfileInfo> = {
  "poprules-startingPrice": {
    introducedAt: null,
    abiPackage: null,
    discriminator: "startingPrice",
  },
  "v0.5.8-rc1": {
    introducedAt: "v0.5.8-rc1",
    abiPackage: "dotns-abis-v0.5.8-rc1.zip",
    discriminator: "pricingVersion",
  },
  "v0.6.0": {
    introducedAt: "v0.6.0",
    abiPackage: "dotns-abis-v0.6.0.zip",
    discriminator: "isPopIssued",
  },
};

/** Inputs to classifyProtocolVersion — the live dry-run results from connect(). */
export interface DotnsProtocolProbe {
  /**
   * Whether POP_RULES has contract code at all (a prerequisite, not a
   * verdict) — `false` is a definitive "no code here" and `null` means code
   * presence could not be verified (the underlying `hasContractCode` read is
   * itself three-valued for the same reason: its own doc comment says
   * callers must not read `null` as "no code"). Only `false` short-circuits
   * classification; `null` falls through to the two live probes below,
   * because a probe answering is itself positive proof the contract exists
   * regardless of whether the code-presence read could confirm it.
   */
  hasCode: boolean | null;
  /** Whether a dry-run call to PopRules.pricingVersion() completed without reverting. */
  pricingVersionOk: boolean;
  /** Whether a dry-run call to PopRules.startingPrice() completed without reverting. */
  startingPriceOk: boolean;
  /**
   * Whether a dry-run call to DotnsPopController.isPopIssued(<label>)
   * completed without reverting — the v0.6.0-vs-v0.5.8-rc1 discriminator
   * (pricingVersion answers on BOTH, so it cannot tell them apart on its
   * own). Three-valued:
   *   - `true`  — the function answered: this IS v0.6.0.
   *   - `false` — the function reverted (or no data came back): the same
   *     "a probe not answering means this generation lacks it" posture
   *     already used for pricingVersion/startingPrice above.
   *   - `null`/`undefined` — the probe was never attempted, typically
   *     because DOTNS_POP_CONTROLLER has no configured address for this
   *     environment (a `--contract` override that supplies only POP_RULES,
   *     say). Falls back to v0.5.8-rc1 rather than erroring: v0.5.8-rc1 and
   *     v0.6.0 share an IDENTICAL registration tuple/ABI adapter (see the
   *     module doc comment), so this field only ever changes
   *     classifyLabelStatus's LOCAL advisory label semantics, never the
   *     on-chain transaction shape — misclassifying that is a
   *     preflight-message inaccuracy, not a broken deploy. Optional so
   *     every existing caller/test built before this field existed (which
   *     never needed to disambiguate v0.6.0) keeps compiling and keeps its
   *     exact old verdict.
   */
  isPopIssuedOk?: boolean | null;
}

export type DotnsProtocolClassification =
  | { profile: DotnsAbiProfile }
  | { profile: null; reason: string };

/**
 * Pure, three-valued classification of the live DotNS ABI profile. Owns all
 * three outcome branches AND their wording, including the `hasCode === null`
 * (code presence unverified) case — moving it into this pure classifier
 * means every caller gets the null-handling for free and it is unit-testable
 * without a stubbed clientWrapper.
 *
 * This is capability-based detection, NOT release detection: it never reads
 * a version/tag off the chain, only whether a given function answers a
 * dry-run call. The `introducedAt` tags in DOTNS_ABI_PROFILES are asserted
 * provenance from an offline artifact diff, unrelated to this runtime probe.
 *
 * - `hasCode === false` is NOT a profile verdict — it is a configuration
 *   problem (wrong/undeployed address), checked first so it always wins even
 *   if a probe happens to answer, and it gets its own reason distinct from
 *   "unknown generation". This is the same wording the dotns.ts call site
 *   used to throw directly; it has just moved here.
 * - `hasCode === null` does NOT short-circuit — code presence being
 *   unverified is not the same as code being absent, so classification falls
 *   through to the two live probes below: a probe answering is itself
 *   positive proof the contract exists, regardless of whether the
 *   code-presence read could confirm it.
 * - Neither probe answering is an explicit unknown-profile error naming BOTH
 *   probes, so the failure is diagnosable rather than silently falling back
 *   to the old profile (a silent poprules-startingPrice fallback here is
 *   exactly the failure mode this whole module exists to prevent). When
 *   `hasCode` was `null` rather than `true`, the reason also notes that code
 *   presence itself couldn't be verified — a wrong/undeployed POP_RULES
 *   address is then also a possible explanation, not just a genuinely
 *   unrecognised ABI profile.
 * - Both probes answering (a hypothetical future overlap) prefers
 *   v0.5.8-rc1 — it is the superset generation, and preferring the newer one
 *   avoids stranding a fully-upgraded deployment on the old ABI just because
 *   the old function selector happens to still resolve. (When
 *   `isPopIssuedOk` also answers `true`, v0.6.0 wins instead — see below.)
 * - When `pricingVersionOk` is true, `isPopIssuedOk` decides v0.6.0 vs
 *   v0.5.8-rc1: `true` → v0.6.0, anything else (`false`/`null`/`undefined`)
 *   → v0.5.8-rc1. See `DotnsProtocolProbe.isPopIssuedOk`'s own doc comment
 *   for why the fallback case is safe (identical adapter either way).
 */
export function classifyProtocolVersion(probe: DotnsProtocolProbe): DotnsProtocolClassification {
  const { hasCode, pricingVersionOk, startingPriceOk, isPopIssuedOk } = probe;
  if (hasCode === false) {
    return {
      profile: null,
      reason:
        "No contract deployed at this address — could not detect the DotNS ABI profile because no contract code was found here. Check environments.json / --contract config for this network.",
    };
  }
  if (pricingVersionOk) return { profile: isPopIssuedOk === true ? "v0.6.0" : "v0.5.8-rc1" };
  if (startingPriceOk) return { profile: "poprules-startingPrice" };
  const reason =
    hasCode === true
      ? "Could not determine the DotNS ABI profile: contract code is present at POP_RULES, but neither pricingVersion() (v0.5.8-rc1) nor startingPrice() (poprules-startingPrice) answered."
      : "Could not determine the DotNS ABI profile: neither pricingVersion() (v0.5.8-rc1) nor startingPrice() (poprules-startingPrice) answered. Code presence at this address could not be verified either (the runtime code-presence query failed), so a wrong/undeployed POP_RULES address is also possible.";
  return { profile: null, reason };
}

/** The 4 fields every registration carries, regardless of ABI profile. */
export interface DotnsRegistrationBase {
  label: string;
  owner: string;
  secret: string;
  reserved: boolean;
}

/**
 * Pricing facts needed to build a v0.5.8-rc1 registration tuple. Both fields
 * are optional at the type level so a poprules-startingPrice caller (which
 * ignores this argument entirely) can pass `{}`; the v0.5.8-rc1 adapter
 * enforces its own requirements at build time and throws with a specific,
 * named reason when a required field is missing.
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
  readonly profile: DotnsAbiProfile;
  /**
   * True when pricing (maxPrice + pricingVersion) must be resolved BEFORE
   * makeCommitment/commit, because it is part of the committed tuple
   * (v0.5.8-rc1). False when pricing is resolved after commit, unaffected by
   * the tuple (poprules-startingPrice — today's behaviour, must stay
   * byte-for-byte identical).
   */
  readonly needsPricingBeforeCommit: boolean;
  /** This profile's RegistrarController ABI fragment (makeCommitment/register vary in tuple shape; commit/commitments/minCommitmentAge/maxCommitmentAge are identical across profiles but included here too so callers have a single ABI source). */
  readonly controllerAbi: readonly any[];
  /** This profile's PopRules ABI fragment for the functions THIS adapter calls directly (the deposit-gate read, plus pricingVersion/priceWithCheckAtVersion on v0.5.8-rc1). Functions unchanged across profiles (price, priceWithCheck, classifyName, etc.) are called via the shared ABI in dotns.ts and never need to go through here. */
  readonly popRulesAbi: readonly any[];
  /** Build the on-chain registration tuple for this profile from the base fields + pricing facts. */
  buildRegistration(base: DotnsRegistrationBase, pricing: DotnsPricingInput): Record<string, unknown>;
  /** Which PopRules view function (and args) resolves the NoStatus deposit gate on this profile. */
  depositCall(label: string): DotnsDepositCall;
}

const REGISTRATION_COMPONENTS_OLD = [
  { name: "label", type: "string" },
  { name: "owner", type: "address" },
  { name: "secret", type: "bytes32" },
  { name: "reserved", type: "bool" },
] as const;

const REGISTRATION_COMPONENTS_V0_5_8_RC1 = [
  ...REGISTRATION_COMPONENTS_OLD,
  { name: "maxPrice", type: "uint256" },
  { name: "pricingVersion", type: "uint256" },
] as const;

export const OLD_CONTROLLER_ABI = [
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_OLD }], name: "makeCommitment", outputs: [{ name: "", type: "bytes32" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "minCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "maxCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commitments", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_OLD }], name: "register", outputs: [], stateMutability: "payable", type: "function" },
] as const;

export const V0_5_8_RC1_CONTROLLER_ABI = [
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_V0_5_8_RC1 }], name: "makeCommitment", outputs: [{ name: "", type: "bytes32" }], stateMutability: "pure", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commit", outputs: [], stateMutability: "nonpayable", type: "function" },
  { inputs: [], name: "minCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "maxCommitmentAge", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "commitment", type: "bytes32" }], name: "commitments", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "registration", type: "tuple", components: REGISTRATION_COMPONENTS_V0_5_8_RC1 }], name: "register", outputs: [], stateMutability: "payable", type: "function" },
] as const;

const PRICE_WITH_CHECK_METADATA_OUTPUT = {
  name: "metadata", type: "tuple", components: [
    { name: "price", type: "uint256" },
    { name: "status", type: "uint8" },
    { name: "userStatus", type: "uint8" },
    { name: "message", type: "string" },
  ],
} as const;

export const OLD_POP_RULES_ABI = [
  { inputs: [], name: "startingPrice", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

export const V0_5_8_RC1_POP_RULES_ABI = [
  { inputs: [{ name: "name", type: "string" }], name: "price", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [], name: "pricingVersion", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "name", type: "string" }, { name: "userAddress", type: "address" }, { name: "version", type: "uint256" }], name: "priceWithCheckAtVersion", outputs: [PRICE_WITH_CHECK_METADATA_OUTPUT], stateMutability: "view", type: "function" },
] as const;

/**
 * DotnsPopController.isPopIssued(label) — new in v0.6.0, absent from every
 * earlier generation. This is the v0.6.0-vs-v0.5.8-rc1 discriminator: a
 * dry-run call answering (not reverting) is itself positive proof of the
 * new function's presence. Lives on a DIFFERENT contract
 * (DOTNS_POP_CONTROLLER) than every other ABI in this file, which is why it
 * isn't part of either DotnsProtocolAdapter's `popRulesAbi` — it's
 * detection-only, never called again once the profile is known.
 */
export const POP_CONTROLLER_PROBE_ABI = [
  { inputs: [{ name: "label", type: "string" }], name: "isPopIssued", outputs: [{ name: "issued", type: "bool" }], stateMutability: "view", type: "function" },
] as const;

/**
 * Well-formed, arbitrary label used only to probe isPopIssued's presence —
 * never registered, never sent in a real transaction. Plain lowercase
 * letters, no digits, no separator, so it can't trip any label-shape
 * validation the real contract might apply before the mapping lookup runs.
 */
export const PROTOCOL_PROBE_LABEL = "probelabel";

/** finalizeRegistration's existing +10% payment buffer — maxPrice must agree with the amount actually sent, so they share this exact formula. */
function withTenPercentBuffer(priceWei: bigint): bigint {
  return (priceWei * 110n) / 100n;
}

const oldAdapter: DotnsProtocolAdapter = {
  profile: "poprules-startingPrice",
  needsPricingBeforeCommit: false,
  controllerAbi: OLD_CONTROLLER_ABI,
  popRulesAbi: OLD_POP_RULES_ABI,
  buildRegistration(base) {
    // This profile's tuple is unchanged: 4 fields, in the exact order the
    // contract (and every existing call site/test) already expects. Pricing
    // is deliberately ignored — this profile resolves it AFTER commit,
    // unaffected by the committed tuple, exactly as today.
    return { label: base.label, owner: base.owner, secret: base.secret, reserved: base.reserved };
  },
  depositCall() {
    return { functionName: "startingPrice", args: [] };
  },
};

// Shared by v0.5.8-rc1 and v0.6.0: the encoding is byte-identical between
// the two, and the registration tuple/pricing-before-commit requirement is
// exactly this same shape on both. One implementation parameterised by the
// profile label (for its error text) rather than two copies that could
// silently drift apart.
function buildPricedRegistration(profileLabel: DotnsAbiProfile) {
  return (base: DotnsRegistrationBase, pricing: DotnsPricingInput): Record<string, unknown> => {
    if (pricing.pricingVersion === undefined) {
      throw new Error(
        `DotNS ${profileLabel} registration requires pricing.pricingVersion (read PopRules.pricingVersion() before committing — it must be known before makeCommitment since it is part of the committed tuple).`,
      );
    }
    if (pricing.priceWei === undefined) {
      throw new Error(`DotNS ${profileLabel} registration requires pricing.priceWei to compute maxPrice.`);
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
  };
}

function pricedDepositCall(label: string): DotnsDepositCall {
  return { functionName: "price", args: [label] };
}

const v058rc1Adapter: DotnsProtocolAdapter = {
  profile: "v0.5.8-rc1",
  needsPricingBeforeCommit: true,
  controllerAbi: V0_5_8_RC1_CONTROLLER_ABI,
  popRulesAbi: V0_5_8_RC1_POP_RULES_ABI,
  buildRegistration: buildPricedRegistration("v0.5.8-rc1"),
  depositCall: pricedDepositCall,
};

// v0.6.0: same tuple, same ABI, same deposit read as v0.5.8-rc1 — see the
// module doc comment for the full "encoding unchanged, only classifyLabelStatus
// semantics changed" argument. Reuses v0.5.8-rc1's ABI constants directly
// rather than declaring byte-identical copies under a new name.
const v060Adapter: DotnsProtocolAdapter = {
  profile: "v0.6.0",
  needsPricingBeforeCommit: true,
  controllerAbi: V0_5_8_RC1_CONTROLLER_ABI,
  popRulesAbi: V0_5_8_RC1_POP_RULES_ABI,
  buildRegistration: buildPricedRegistration("v0.6.0"),
  depositCall: pricedDepositCall,
};

// Record, not a ternary/if-chain: a future profile added to the DotnsAbiProfile
// union without a matching entry here is a TYPE ERROR, not a silent fallthrough
// to the wrong adapter (a ternary would quietly return oldAdapter — 4-field
// tuple + startingPrice — for any profile it didn't explicitly name).
const ADAPTERS: Record<DotnsAbiProfile, DotnsProtocolAdapter> = {
  "poprules-startingPrice": oldAdapter,
  "v0.5.8-rc1": v058rc1Adapter,
  "v0.6.0": v060Adapter,
};

export function getAdapter(profile: DotnsAbiProfile): DotnsProtocolAdapter {
  return ADAPTERS[profile];
}
