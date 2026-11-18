import { WebSocketServer } from "ws";

// A local JSON-RPC endpoint that answers the chainSpec_v1 calls polkadot-api's
// getChainSpecData() makes, reporting `genesisHash`, and `state_getStorage` from `storage`
// (hex key -> hex value), and rejects every other method. A method in `unanswered` gets no reply
// at all. `genesisReads` counts the chainSpec_v1_genesisHash calls it received; `connections`
// counts the client connections it accepted; `openSockets` is the number still open.
export async function startFakeChain(genesisHash, { storage = {}, unanswered = [] } = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const results = {
    rpc_methods: () => ({ methods: ["chainSpec_v1_chainName", "chainSpec_v1_genesisHash", "chainSpec_v1_properties", "state_getStorage"] }),
    chainSpec_v1_chainName: () => "Fake",
    chainSpec_v1_genesisHash: () => genesisHash,
    chainSpec_v1_properties: () => ({}),
    state_getStorage: ([key]) => storage[key] ?? null,
  };
  server.on("connection", () => { chain.connections += 1; });
  server.on("connection", (socket) => socket.on("message", (raw) => {
    const { id, method, params } = JSON.parse(raw);
    if (method === "chainSpec_v1_genesisHash") chain.genesisReads += 1;
    if (unanswered.includes(method)) return;
    socket.send(JSON.stringify(method in results
      ? { jsonrpc: "2.0", id, result: results[method](params ?? []) }
      : { jsonrpc: "2.0", id, error: { code: -32601, message: `${method} is not served` } }));
  }));
  const chain = {
    url: `ws://127.0.0.1:${server.address().port}`,
    genesisReads: 0,
    connections: 0,
    get openSockets() {
      return server.clients.size;
    },
    close: () => new Promise((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(resolve);
    }),
  };
  return chain;
}

/** Resolves once `condition()` is true; rejects after `timeoutMs`. */
export async function waitFor(condition, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * `promise`, or a rejection with `failMessage` when it has not resolved or rejected within `timeoutMs`, so a
 * call that hangs (a client that is never checked, a poll that never ends) fails the test on its
 * own assertion instead of the runner's timeout.
 */
export function rejectAfterTimeout(promise, timeoutMs, failMessage) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(failMessage)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** `stack` with its `role` chain served only at `url`. */
export function withChainEndpoint(stack, role, url) {
  return { ...stack, chains: { ...stack.chains, [role]: { ...stack.chains[role], rpc: [url] } } };
}
