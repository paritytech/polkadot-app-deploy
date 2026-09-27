// Shared `BuildRingProof` construction over verifiablejs's `one_shot`.
//
// Every call site — src/dotns.ts DotNS#reprove and src/personhood/bootstrap.ts
// runBootstrap — needs the same five-argument call:
// `one_shot(ringExponent, memberEntropy, members, context, msg)`. Each site
// used to hand-roll that call independently, with no single place pinning
// the argument order (bulletin #1360, consolidating a drift bulletin-deploy
// hit in its own tools/reprove-alias.mjs — #1229).
//
// This module intentionally has ZERO runtime imports (only a `type` import
// below, which erases at compile time) so that importing it statically from
// src/dotns.ts does not drag verifiablejs into the main bundle — dotns.ts
// dynamically imports verifiablejs/nodejs specifically to keep it out of
// that bundle. Callers pass their own `one_shot` in, however they obtained
// it (static or dynamic import).
import type { BuildRingProof, BuildRingProofInput, RingExponent } from "./claim-pgas.js";

/** The shape of verifiablejs/nodejs's `one_shot` export. */
export type OneShotFn = (
  ringExponent: RingExponent,
  memberEntropy: Uint8Array,
  members: Uint8Array,
  context: Uint8Array,
  msg: Uint8Array,
) => { proof: Uint8Array; alias: Uint8Array };

/**
 * Build a `BuildRingProof` callback backed by `one_shot`, pinning the
 * argument order — ringExponent, memberEntropy, members, context, msg — in
 * one place so it cannot drift independently between call sites.
 *
 * `memberEntropy` is closed over here rather than threaded through
 * `BuildRingProofInput` because it is derived once per signer/mnemonic
 * up front, while `BuildRingProofInput` carries only what the caller
 * (claimPgas / reproveAliasToAccount) determines per-call.
 */
export function makeOneShotBuildRingProof(oneShot: OneShotFn, memberEntropy: Uint8Array): BuildRingProof {
  return async ({ ringExponent, members, context, msg }: BuildRingProofInput) => {
    const r = oneShot(ringExponent, memberEntropy, members, context, msg);
    return { proof: r.proof, alias: r.alias };
  };
}
