import { DotNS, DEFAULT_MNEMONIC } from "../../dist/dotns.js";
import { resolveE2eEnv } from "./e2e-env.js";

// Shared by resolveContenthashOnChain/resolveTextRecordOnChain below — both
// are thin one-off-read wrappers that only differ in which DotNS getter they
// call once connected.
//
// Pass envId (e.g. "paseo-next-v2") to read from a specific environment; omit
// it for the one the CLI itself defaults to.
async function buildConnectOpts(envId) {
  return { mnemonic: DEFAULT_MNEMONIC, ...(await resolveE2eEnv(envId)).dotnsConnectOptions };
}

// Thin wrapper around DotNS.getContenthash that manages the connection
// lifetime for one-off reads (post-run CI verification, ad-hoc debugging).
// Anything inside a running deploy should use dotns.getContenthash directly
// on its existing connection.
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
