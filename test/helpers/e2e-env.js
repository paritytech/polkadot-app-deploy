import { DEFAULT_ENV_ID, loadEnvironments, resolveEndpoints } from "@parity/polkadot-app-deploy";

// A run without PAD_ENV still deploys somewhere: deploy() resolves
// `options.env ?? DEFAULT_ENV_ID` (src/deploy.ts), so the harness resolves the
// same env rather than naming a chain of its own.
export function resolveE2eEnvId(padEnv) {
  return padEnv || DEFAULT_ENV_ID;
}

// Everything the harness needs about the target chain, from one resolve.
export async function resolveE2eEnv(padEnv) {
  const envId = resolveE2eEnvId(padEnv);
  const { doc } = await loadEnvironments();
  const resolved = resolveEndpoints(doc, envId);
  if (!resolved.ipfs) {
    throw new Error(`>> FAIL: e2e env: "${envId}" declares no ipfs gateway in environments.json`);
  }
  return {
    envId,
    // Envs that configure no tld make DotNS.connect read it from the registry;
    // the harness cannot, so it keeps DEFAULT_TLD's "dot" for those.
    tld: resolved.tld ?? "dot",
    bulletin: resolved.bulletin[0],
    gateway: resolved.ipfs,
    dotnsConnectOptions: {
      rpc: resolved.assetHub[0],
      assetHubEndpoints: resolved.assetHub,
      autoAccountMapping: resolved.autoAccountMapping,
      contracts: Object.keys(resolved.contracts).length > 0 ? resolved.contracts : undefined,
      nativeToEthRatio: resolved.nativeToEthRatio,
      // Undefined stays undefined: connect() only reads the TLD from the
      // registry when none is passed, and that branch is worth keeping.
      tld: resolved.tld,
    },
  };
}
