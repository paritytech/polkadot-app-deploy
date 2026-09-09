// _revive-dry-run.mjs — shared read-only ReviveApi.call dry-run helper.
//
// Every tools/*.mjs probe that simulates a contract view call against a
// Revive/pallet-revive chain needs the same three pieces: max weight/storage
// limits for a dry run (never actually charged — the call never executes for
// real), a helper that coerces papi's Binary/Uint8Array return shapes to a
// plain hex string, and the encode -> dry-run -> decode-or-revert sequence
// itself. Extracted here so tools/check-signer-status.mjs and
// tools/probe-dotns-v060.mjs (and any future probe) share one implementation
// instead of drifting apart on the revert-detection logic if the
// ReviveApi.call shape ever changes.
import { Binary } from "polkadot-api";
import { encodeFunctionData, decodeFunctionResult } from "viem";

export const DRY_WEIGHT = { ref_time: 18446744073709551615n, proof_size: 18446744073709551615n };
export const DRY_STORAGE = 18446744073709551615n;

// Coerce a papi Binary / Uint8Array / anything-with-asHex value to a plain
// "0x..."-prefixed hex string, or return null unchanged.
export function render(value) {
  if (value == null) return null;
  if (typeof value.asHex === "function") return value.asHex();
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString("hex")}`;
  return String(value);
}

// Encode `functionName(args)` per `abi`, dry-run it as `callerSubstrate`
// against `contractAddress`, and decode the result. Throws (with `.reverted
// = true` set on the Error) when the call reverts or returns empty data —
// callers that need to tell "reverted" apart from a genuine RPC/connection
// failure (which propagates as a plain Error with `.reverted` unset) should
// check that flag, the same way tools/probe-dotns-v060.mjs does to classify
// its own OUTCOME lines.
export async function dryRun(api, callerSubstrate, contractAddress, abi, functionName, args) {
  const data = encodeFunctionData({ abi, functionName, args });
  const response = await api.apis.ReviveApi.call(
    callerSubstrate, contractAddress, 0n, DRY_WEIGHT, DRY_STORAGE, Binary.fromHex(data),
  );
  const ok = response.result?.success ? response.result.value : null;
  const flags = BigInt(ok?.flags ?? 0);
  if (!ok || (flags & 1n) !== 0n || !ok.data) {
    const reverted = new Error(`Call reverted: flags=${ok?.flags} data=${render(ok?.data)}`);
    reverted.reverted = true;
    throw reverted;
  }
  return decodeFunctionResult({ abi, functionName, data: render(ok.data) });
}
