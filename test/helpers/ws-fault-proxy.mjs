// WebSocket fault-injection proxy for E2E tests (#216 / #271).
//
// Listens on ws://localhost:<dynamic-port>, forwards frames to a real
// upstream (default Bulletin RPC), and injects a server-initiated close
// frame at a configurable point — mimicking the `WS halt (3)` behaviour
// the real chain occasionally produces and that tripped the buffer-churn
// failure mode in #216.
//
// Two drop modes:
//   - mode: "once"   — drop after `dropAtMs` once, then forward cleanly.
//                       Validates "deploy survives a transient halt".
//   - mode: "rapid"  — drop every `dropEveryMs` continuously. Validates
//                       the retry budget bails cleanly under sustained
//                       outage.
//
// The proxy itself never tears down the upstream socket on a drop — only
// the client-facing one. polkadot-api will reconnect; on the new client
// connection the proxy dials a fresh upstream. That's intentional: it
// mirrors what real WS halts look like (server closes, client retries).

import { WebSocket, WebSocketServer } from "ws";

const DEFAULT_UPSTREAM = "wss://paseo-bulletin-rpc.polkadot.io";

export async function startFaultProxy(opts = {}) {
  const upstream = opts.upstream ?? DEFAULT_UPSTREAM;
  const mode = opts.mode ?? "once";
  const dropAtMs = opts.dropAtMs ?? 2000;
  const dropEveryMs = opts.dropEveryMs ?? 500;
  // Hold off the first drop until after CLI warmup — pool authorization
  // checks, metadata loading, etc. don't have their own retry, so an early
  // drop would crash the deploy with an irrelevant error.
  const initialDelayMs = opts.initialDelayMs ?? 0;
  const dropCode = opts.dropCode ?? 1011;
  const dropReason = opts.dropReason ?? "WS halt (3)";
  // Bounded `rapid` storm: stop dropping after this wall-clock window (from proxy
  // start, across reconnects) so the deploy can recover and COMPLETE. Default
  // Infinity = drop forever (legacy behaviour). Used by S8 rapid-storm to assert
  // the deploy survives a burst and finishes (the progress-aware retry budget, #864,
  // recovers through an unbounded storm rather than bailing — so an unbounded storm
  // never reaches a clean outcome and times out).
  const dropDurationMs = opts.dropDurationMs ?? Infinity;

  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;

  // Stats observable by the test for assertions.
  const stats = { connections: 0, dropsInjected: 0, upstreamErrors: 0 };
  const liveSockets = new Set();
  // Global drop budget — `once` means ONE drop across the whole proxy
  // lifetime, not one per connection. Without this, every PAPI reconnect
  // through the proxy gets a fresh drop timer that fires 12 s later,
  // turning "drop-once" into "drop-every-12s".
  let dropsRemaining = mode === "once" ? 1 : Infinity;
  let staleHash = null;
  let staleWindowStart = null;
  const staleDurationMs = opts.staleDurationMs ?? 15_000;
  // Global storm deadline for bounded `rapid` mode — set once at proxy start so
  // reconnects can't restart the storm. After this, all rapid drops stop.
  let stormOver = false;
  if (mode === "rapid" && dropDurationMs !== Infinity) {
    setTimeout(() => { stormOver = true; }, initialDelayMs + dropDurationMs);
  }

  server.on("connection", (clientWs) => {
    stats.connections += 1;
    const pendingFinalizedHeadIds = new Set();
    const upstreamWs = new WebSocket(upstream);
    let dropTimer = null;
    let rapidInterval = null;

    const cleanup = () => {
      if (dropTimer) { clearTimeout(dropTimer); dropTimer = null; }
      if (rapidInterval) { clearInterval(rapidInterval); rapidInterval = null; }
      liveSockets.delete(clientWs);
    };

    upstreamWs.on("open", () => {
      // Buffer client frames received before upstream is open.
      for (const f of pendingClientFrames) {
        try { upstreamWs.send(f.data, { binary: f.isBinary }); } catch { /* upstream gone, swallow */ }
      }
      pendingClientFrames.length = 0;

      if (mode === "once" && dropsRemaining > 0) {
        dropTimer = setTimeout(() => {
          if (dropsRemaining <= 0) return;
          dropsRemaining -= 1;
          stats.dropsInjected += 1;
          // terminate() drops the underlying TCP socket without a WS close frame —
          // closer to a real chain-side "WS halt" than a graceful close(code, reason)
          // would be. close() triggers the close-handshake codepath in PAPI which
          // gives subscriptions a chance to drain cleanly; terminate() forces the
          // abrupt-disconnect codepath that the existing reconnect logic targets.
          try { clientWs.terminate(); } catch { /* socket already gone */ }
        }, dropAtMs);
      } else if (mode === "rapid") {
        dropTimer = setTimeout(() => {
          rapidInterval = setInterval(() => {
            if (stormOver) { clearInterval(rapidInterval); rapidInterval = null; return; }
            stats.dropsInjected += 1;
            // terminate() drops the underlying TCP socket without a WS close frame —
// closer to a real chain-side "WS halt" than a graceful close(code, reason)
// would be. close() triggers the close-handshake codepath in PAPI which
// gives subscriptions a chance to drain cleanly; terminate() forces the
// abrupt-disconnect codepath that the existing reconnect logic targets.
try { clientWs.terminate(); } catch { /* socket already gone */ }
          }, dropEveryMs);
        }, initialDelayMs);
      }
    });

    // ws 8.x passes (data, isBinary) — preserve isBinary on send so the
    // far side decodes a text frame as text (and binary as binary). Without
    // this, JSON-RPC frames forwarded as binary surface as a Blob on Node
    // 25+ and PAPI's JSON.parse fails with "Unexpected token 'o',
    // \"[object Blob]\" is not valid JSON".
    const pendingClientFrames = [];
    clientWs.on("message", (data, isBinary) => {
      if (mode === "stale-finalized-head" && !isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === "chain_getFinalizedHead" && msg.id != null) {
            pendingFinalizedHeadIds.add(String(msg.id));
          }
        } catch { /* not JSON */ }
      }
      if (upstreamWs.readyState === WebSocket.OPEN) {
        try { upstreamWs.send(data, { binary: isBinary }); } catch { /* upstream gone, swallow */ }
      } else {
        pendingClientFrames.push({ data, isBinary });
      }
    });

    upstreamWs.on("message", (data, isBinary) => {
      if (mode === "stale-finalized-head" && !isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          const msgId = msg.id != null ? String(msg.id) : null;
          const inWindow = !staleWindowStart || Date.now() - staleWindowStart < staleDurationMs;
          if (msgId && pendingFinalizedHeadIds.has(msgId) && inWindow) {
            pendingFinalizedHeadIds.delete(msgId);
            if (!staleHash && msg.result) {
              staleHash = msg.result;
              staleWindowStart = Date.now();
            }
            if (staleHash) {
              stats.dropsInjected += 1;
              const faked = JSON.stringify({ ...msg, result: staleHash });
              try { clientWs.send(faked, { binary: false }); } catch { /* client gone */ }
              return;
            }
          }
        } catch { /* not JSON */ }
      }
      if (clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.send(data, { binary: isBinary }); } catch { /* client gone, swallow */ }
      }
    });

    clientWs.on("close", () => { cleanup(); try { upstreamWs.close(); } catch {} });
    upstreamWs.on("close", () => { cleanup(); try { clientWs.close(); } catch {} });
    clientWs.on("error", () => { cleanup(); try { upstreamWs.close(); } catch {} });
    upstreamWs.on("error", () => {
      stats.upstreamErrors += 1;
      cleanup();
      try { clientWs.close(); } catch {}
    });

    liveSockets.add(clientWs);
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    stats,
    async close() {
      for (const ws of liveSockets) {
        try { ws.close(); } catch {}
      }
      await new Promise((r) => server.close(r));
    },
  };
}
