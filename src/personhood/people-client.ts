// Opens an untyped polkadot-api client against a stack's People chain.

import type { PolkadotClient } from "polkadot-api";
import type { Stack } from "../stacks.js";
import { connectChainClient } from "../genesis.js";
import { WS_HEARTBEAT_TIMEOUT_MS } from "../dotns.js";

export interface PeopleClientResult {
  client: PolkadotClient;
  // Untyped API — same casting pattern as dotns.ts `as unknown as <shape>`
  unsafeApi: ReturnType<PolkadotClient["getUnsafeApi"]>;
  disconnect: () => void;
}

/**
 * Open a People-chain polkadot-api client for `stack`, failing when the chain's genesis hash
 * differs from the stack's. The caller must call `disconnect()` when done to release the WS
 * connection.
 */
export async function connectPeopleClient(stack: Stack): Promise<PeopleClientResult> {
  const client = await connectChainClient(stack, "People", undefined, { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS });
  const unsafeApi = client.getUnsafeApi();

  return {
    client,
    unsafeApi,
    disconnect: () => {
      try {
        client.destroy();
      } catch {}
    },
  };
}
