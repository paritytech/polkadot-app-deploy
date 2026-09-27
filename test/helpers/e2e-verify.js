import { DotNS, DEFAULT_MNEMONIC } from "../../dist/dotns.js";
import { loadEnvironments, resolveEndpoints } from "../../dist/environments.js";

// Shared by resolveContenthashOnChain/resolveTextRecordOnChain below — both
// are thin one-off-read wrappers that only differ in which DotNS getter they
// call once connected.
async function buildConnectOpts(envId) {
  let connectOpts = { mnemonic: DEFAULT_MNEMONIC };
  if (envId) {
    const { doc } = await loadEnvironments();
    const resolved = resolveEndpoints(doc, envId);
    connectOpts = {
      ...connectOpts,
      rpc: resolved.assetHub[0],
      assetHubEndpoints: resolved.assetHub,
      autoAccountMapping: resolved.autoAccountMapping,
      contracts: Object.keys(resolved.contracts).length > 0 ? resolved.contracts : undefined,
      nativeToEthRatio: resolved.nativeToEthRatio,
    };
  }
  return connectOpts;
}

// Thin wrapper around DotNS.getContenthash that manages the connection
// lifetime for one-off reads (post-run CI verification, ad-hoc debugging).
// Anything inside a running deploy should use dotns.getContenthash directly
// on its existing connection.
//
// Pass envId (e.g. "paseo-next-v2") to read from a non-default environment.
export async function resolveContenthashOnChain(label, envId = null) {
  const dotns = new DotNS();
  try {
    await dotns.connect(await buildConnectOpts(envId));
    return await dotns.getContenthash(label);
  } finally {
    dotns.disconnect();
  }
}

// Thin wrapper around DotNS.getTextRecord that manages the connection
// lifetime for one-off reads. Mirrors resolveContenthashOnChain above.
export async function resolveTextRecordOnChain(label, key, envId = null) {
  const dotns = new DotNS();
  try {
    await dotns.connect(await buildConnectOpts(envId));
    return await dotns.getTextRecord(label, key);
  } finally {
    dotns.disconnect();
  }
}
