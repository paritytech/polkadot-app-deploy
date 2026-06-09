import { DotNS, DEFAULT_MNEMONIC } from "../../dist/dotns.js";
import { loadEnvironments, resolveEndpoints } from "../../dist/environments.js";

// Thin wrapper around DotNS.getContenthash that manages the connection
// lifetime for one-off reads (post-run CI verification, ad-hoc debugging).
// Anything inside a running deploy should use dotns.getContenthash directly
// on its existing connection.
//
// Pass envId (e.g. "paseo-next-v2") to read from a non-default environment.
export async function resolveContenthashOnChain(label, envId = null) {
  const dotns = new DotNS();
  try {
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
    await dotns.connect(connectOpts);
    return await dotns.getContenthash(label);
  } finally {
    dotns.disconnect();
  }
}
