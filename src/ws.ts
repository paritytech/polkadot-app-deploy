import { getWsProvider as papiGetWsProvider } from "polkadot-api/ws";

// Twin note: upstream's src/ws.ts also carries a malformed-RPC-frame guard
// (GuardedWebSocket, from an earlier upstream change this repo has not taken),
// which upstream's OwnedWebSocket extends. Here OwnedWebSocket extends the plain
// WebSocket; every papi client in src/ is built through this getWsProvider.

// #1675: papi's ws-provider (with-socket.js) drops its socket WITHOUT closing it when the connect times out
// (default 5s) or the heartbeat goes stale. The orphan can still finish its handshake, and then nothing owns it:
// client.destroy() only reaches papi's current socket, so the open TLS socket keeps the process alive. Each
// provider therefore owns the sockets it creates. It closes the older ones when papi opens a new one (papi only
// ever uses its newest) and closes all of them when it is disconnected, i.e. on client.destroy(). Ownership is
// per provider, so destroying one client never touches a socket another caller owns.
export const getWsProvider: typeof papiGetWsProvider = (endpoints, config) => {
  const sockets = new Set<WebSocket>();
  const closeAll = () => {
    for (const s of sockets) {
      sockets.delete(s);
      try { s.close(); } catch { /* already closing */ }
    }
  };
  class OwnedWebSocket extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      closeAll();
      sockets.add(this);
      this.addEventListener("close", () => sockets.delete(this));
    }
  }
  const provider = papiGetWsProvider(endpoints, { ...config, websocketClass: OwnedWebSocket });
  const owned = (onMessage: Parameters<typeof provider>[0]) => {
    const conn = provider(onMessage);
    return { ...conn, disconnect() { try { conn.disconnect(); } finally { closeAll(); } } };
  };
  return Object.assign(owned, { switch: provider.switch, getStatus: provider.getStatus });
};
