// Opens an untyped polkadot-api client against the People-chain wss endpoint
// for a given environment. Mirrors the AH-client setup pattern in dotns.ts.

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import type { PolkadotClient } from "polkadot-api";
import { loadEnvironments } from "../environments.js";
import { WS_HEARTBEAT_TIMEOUT_MS } from "../dotns.js";

export interface PeopleClientResult {
  client: PolkadotClient;
  // Untyped API — same casting pattern as dotns.ts `as unknown as <shape>`
  unsafeApi: ReturnType<PolkadotClient["getUnsafeApi"]>;
  disconnect: () => void;
}

/**
 * Open a People-chain polkadot-api client for the given environment.
 * The caller must call `disconnect()` when done to release the WS connection.
 */
export async function connectPeopleClient(
  environmentId: string,
): Promise<PeopleClientResult> {
  const { doc } = await loadEnvironments();
  const peopleChain = doc.chains.find((c) => c.id === "people");
  if (!peopleChain) {
    throw new Error(
      `environments.json has no 'people' chain entry for env '${environmentId}'`,
    );
  }
  const entry = peopleChain.endpoints[environmentId];
  if (!entry) {
    throw new Error(
      `No People-chain endpoint for environment '${environmentId}'. ` +
        `Bootstrap is only available on paseo-next-v2.`,
    );
  }
  const rawWss = entry.wss;
  const wss = Array.isArray(rawWss) ? rawWss[0] : rawWss;

  const client = createClient(
    getWsProvider(wss, { heartbeatTimeout: WS_HEARTBEAT_TIMEOUT_MS }),
  );
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
