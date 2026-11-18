import { createClient, type PolkadotClient } from "polkadot-api";
import { WsEvent, type StatusChange } from "polkadot-api/ws";
import { GENESIS_ERROR_PHRASES, NonRetryableError } from "./errors.js";
import { getWsProvider } from "./ws.js";
import type { ChainRole, Stack } from "./stacks.js";

/** The chain a client must connect to: one role of the run's stack. */
export interface ExpectedChain {
  stack: Pick<Stack, "id" | "builtIn" | "source" | "chains" | "descriptor">;
  role: ChainRole;
}

export class GenesisMismatchError extends NonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = "GenesisMismatchError";
  }
}

export interface ChainClientConfig {
  heartbeatTimeout?: number;
  onStatusChanged?: (status: StatusChange) => void;
  /** How long the chain has to report its genesis hash; `GENESIS_TIMEOUT_MS` by default. */
  genesisTimeoutMs?: number;
}

function describeMismatchCause({ stack, role }: ExpectedChain, endpoint: string): string {
  if (!stack.chains[role].rpc.includes(endpoint)) {
    return `${endpoint} ${GENESIS_ERROR_PHRASES.otherEndpoint} ${role} endpoints, so it points at another chain`;
  }
  if (!stack.builtIn) return `the descriptor of stack ${stack.id} ${GENESIS_ERROR_PHRASES.customStack}`;
  const sequence = stack.descriptor.sequence;
  switch (stack.source) {
    case "published":
      return `the chain restarted and the published descriptor of stack ${stack.id} (sequence ${sequence}) does not describe the new chain yet; pass --stack with a descriptor of the restarted chain, or wait for its operator to publish one`;
    case "shipped":
      return `the chain restarted, and this run used the copy of stack ${stack.id} shipped with polkadot-app-deploy (sequence ${sequence}) because the published descriptor could not be used (see the warning above); retry when it can be fetched, or pass --stack with a descriptor of the restarted chain`;
    default:
      return `the chain restarted and ${GENESIS_ERROR_PHRASES.passedDescriptor} (sequence ${sequence}) does not describe the new chain; pass a newer one`;
  }
}

/**
 * Fails with `GenesisMismatchError` when `genesisHash`, reported by the chain at `endpoint`, is
 * not the one the stack expects for `expected.role`.
 */
export function assertGenesisHash(genesisHash: string, expected: ExpectedChain, endpoint: string): void {
  const chain = expected.stack.chains[expected.role];
  if (genesisHash.toLowerCase() === chain.genesisHash) return;
  throw new GenesisMismatchError(
    `${expected.role} at ${endpoint} ${GENESIS_ERROR_PHRASES.mismatch} ${genesisHash}, but stack ${expected.stack.id} expects ${chain.genesisHash}: ${describeMismatchCause(expected, endpoint)}.`,
  );
}

export const GENESIS_TIMEOUT_MS = 15_000;

/**
 * A client to `endpoints` (the first is the primary; by default `stack`'s endpoints for `role`)
 * that connected to `stack`'s `role` chain; without `stack` (an endpoint passed without a stack) the
 * client is not checked. Fails with `GenesisMismatchError` on another chain, and with an error
 * naming the role and endpoint when the chain does not report its genesis hash within
 * `config.genesisTimeoutMs`. Both errors contain the endpoint the client connected to. The client is
 * destroyed when it fails.
 */
export async function connectChainClient(
  stack: ExpectedChain["stack"] | undefined,
  role: ChainRole,
  endpoints: string | string[] | undefined = stack?.chains[role].rpc,
  config: ChainClientConfig = {},
): Promise<PolkadotClient> {
  const list = typeof endpoints === "string" ? [endpoints] : endpoints ?? [];
  if (!list[0]) throw new NonRetryableError(`no ${role} endpoint to connect to`);
  const { genesisTimeoutMs = GENESIS_TIMEOUT_MS, onStatusChanged, ...providerConfig } = config;
  let connectedEndpoint: string | undefined;
  const client = createClient(getWsProvider(list, {
    ...providerConfig,
    onStatusChanged: (status) => {
      if (status.type === WsEvent.CONNECTED) connectedEndpoint = status.uri;
      onStatusChanged?.(status);
    },
  }));
  if (!stack) return client;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${role} at ${connectedEndpoint ?? list.join(", ")} ${GENESIS_ERROR_PHRASES.timeout} ${genesisTimeoutMs}ms`)),
      genesisTimeoutMs,
    );
  });
  try {
    const { genesisHash } = await Promise.race([client.getChainSpecData(), timeout]);
    assertGenesisHash(genesisHash, { stack, role }, connectedEndpoint ?? list[0]);
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
