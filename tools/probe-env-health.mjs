#!/usr/bin/env node
// probe-env-health.mjs
//
// Tests whether a bulletin-deploy E2E environment is healthy by probing
// every external surface a deploy actually depends on:
//   1. Asset Hub RPC — WS + system_chain + state_call(ReviveApi.address)
//   2. Bulletin RPC  — WS + system_chain (Bulletin has no Revive; liveness only)
//   3. Bulletin gateway (HTTP) — fetch the env's `ipfs` URL; any HTTP status
//      means the gateway server is up (404 at "/" is fine — the gateway
//      doesn't serve a root index but proves it's reachable).
// Read-only — no extrinsics submitted. Designed to be invoked from
// .github/workflows/e2e.yml's `select-env` job.
//
// Usage:
//   node tools/probe-env-health.mjs --env <id> [--timeout-ms 30000]
//
// Exit codes:
//   0 — healthy
//   non-zero — unhealthy (outcome classified to stderr + GITHUB_OUTPUT)

import fs from "node:fs";
import path from "node:path";

// Alice (//Alice derivation) — 32-byte SS58 pubkey hex.
// Substrate address: 5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY
const ALICE_PUBKEY_HEX = "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

function parseArgs(argv) {
  const args = { env: null, timeoutMs: 30000 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--env") args.env = argv[++i];
    else if (argv[i] === "--timeout-ms") args.timeoutMs = parseInt(argv[++i], 10);
  }
  return args;
}

function emitOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) fs.appendFileSync(out, `${key}=${value}\n`);
}

function fail(kind, message, durationMs) {
  console.error(`unhealthy: ${kind} ${message}`);
  emitOutput("outcome", kind);
  emitOutput("error", message.slice(0, 200));
  emitOutput("duration_ms", String(durationMs));
  process.exit(1);
}

function loadEnv(envId) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(path.resolve("assets/environments.json"), "utf-8"));
  } catch (e) {
    return { error: { kind: "config_error", message: `assets/environments.json: ${e.message}` } };
  }
  const entry = (doc.environments || []).find((e) => e.id === envId);
  if (!entry) {
    const available = (doc.environments || []).map((e) => e.id).join(", ");
    return {
      error: {
        kind: "unknown_env",
        message: `env "${envId}" not in environments.json. Available envs: ${available}`,
      },
    };
  }
  // Resolve both chain endpoints. Asset Hub hosts the Revive pallet (and
  // therefore ReviveApi.address); the Bulletin chain hosts content storage.
  // A healthy E2E env needs both reachable. Match how
  // src/environments.ts::resolveEndpoints reads it (chains is an array of
  // chain objects, each with an `id` and an `endpoints` map keyed by env id).
  const pickWss = (chainId) => {
    const chain = (doc.chains || []).find((c) => c.id === chainId);
    const wss = chain?.endpoints?.[envId]?.wss;
    return Array.isArray(wss) ? wss[0] : wss;
  };
  const assetHubRpc = pickWss("asset-hub");
  const bulletinRpc = pickWss("bulletin");
  const gatewayUrl = entry.ipfs;
  if (!assetHubRpc) {
    return { error: { kind: "config_error", message: `no asset-hub RPC for env "${envId}"` } };
  }
  if (!bulletinRpc) {
    return { error: { kind: "config_error", message: `no bulletin RPC for env "${envId}"` } };
  }
  if (!gatewayUrl) {
    return { error: { kind: "config_error", message: `no gateway (ipfs) URL for env "${envId}"` } };
  }
  return { entry, assetHubRpc, bulletinRpc, gatewayUrl };
}

// Probe a single chain over WebSocket. Returns { ok: true, result } on success
// or { ok: false, kind, message } on failure. Does not exit the process —
// caller composes results from multiple chain probes.
async function probeChain({ url, calls, timeoutMs }) {
  return new Promise((resolve) => {
    let ws;
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch {}
      resolve(v);
    };
    const timer = setTimeout(
      () => settle({ ok: false, kind: "timeout", message: `no response within ${timeoutMs}ms (rpc=${url})` }),
      timeoutMs,
    );
    const fail = (kind, message) => { clearTimeout(timer); settle({ ok: false, kind, message }); };

    try {
      ws = new WebSocket(url);
    } catch (e) {
      return fail("ws_connect_error", `cannot construct WebSocket to ${url}: ${e.message}`);
    }
    ws.onerror = (e) => fail("ws_connect_error", `${url}: ${e?.message || "ws error"}`);

    ws.onopen = async () => {
      const sendRpc = (id, method, params) =>
        new Promise((res) => {
          const handler = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.id !== id) return;
            ws.onmessage = null;
            res(msg);
          };
          ws.onmessage = handler;
          ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
        });

      const results = {};
      for (const { id, method, params, errorKind, validate } of calls) {
        const resp = await sendRpc(id, method, params);
        if (settled) return; // timed out mid-flight
        if (resp.error) return fail(errorKind, `${method}: ${resp.error.message}`);
        if (validate) {
          const err = validate(resp.result);
          if (err) return fail(errorKind, `${method}: ${err}`);
        }
        results[method] = resp.result;
      }
      clearTimeout(timer);
      settle({ ok: true, result: results });
    };
  });
}

async function probe({ env, timeoutMs }) {
  const t0 = Date.now();
  const loaded = loadEnv(env);
  if (loaded.error) {
    fail(loaded.error.kind, loaded.error.message, Date.now() - t0);
  }
  const { assetHubRpc, bulletinRpc, gatewayUrl } = loaded;

  // 1. Asset Hub: WS + system_chain + ReviveApi.address (Revive lives here).
  const ah = await probeChain({
    url: assetHubRpc,
    timeoutMs,
    calls: [
      { id: 1, method: "system_chain", params: [], errorKind: "rpc_error" },
      {
        id: 2,
        method: "state_call",
        params: ["ReviveApi_address", ALICE_PUBKEY_HEX],
        errorKind: "runtime_call_error",
        validate: (r) =>
          typeof r !== "string" || !r.startsWith("0x") || r.length < 4
            ? `unexpected response: ${r}`
            : null,
      },
    ],
  });
  if (!ah.ok) fail(ah.kind, `asset-hub ${ah.message}`, Date.now() - t0);

  // 2. Bulletin: WS + system_chain (no Revive on Bulletin; just liveness).
  const bul = await probeChain({
    url: bulletinRpc,
    timeoutMs,
    calls: [{ id: 1, method: "system_chain", params: [], errorKind: "rpc_error" }],
  });
  if (!bul.ok) fail(bul.kind, `bulletin ${bul.message}`, Date.now() - t0);

  // 3. Gateway: HTTP fetch. Any HTTP response = gateway server up (a 404 at
  // "/" is fine — gateways route by CID, not by a root index). Only network
  // errors (DNS, refused, timeout) classify as unhealthy.
  let gatewayStatus;
  try {
    const ac = new AbortController();
    const tg = setTimeout(() => ac.abort(), timeoutMs);
    const resp = await fetch(gatewayUrl, { method: "GET", signal: ac.signal, redirect: "manual" });
    clearTimeout(tg);
    gatewayStatus = resp.status;
  } catch (e) {
    fail("gateway_error", `gateway ${gatewayUrl}: ${e?.message || e}`, Date.now() - t0);
  }

  const duration = Date.now() - t0;
  console.log(
    `healthy: ${env} (asset-hub=${ah.result.system_chain}, bulletin=${bul.result.system_chain}, gateway=${gatewayStatus}, ${duration}ms)`,
  );
  emitOutput("outcome", "healthy");
  emitOutput("duration_ms", String(duration));
  process.exit(0);
}

const args = parseArgs(process.argv);
if (!args.env) {
  console.error("usage: probe-env-health.mjs --env <id> [--timeout-ms N]");
  process.exit(2);
}
probe(args).catch((e) => {
  console.error(`unhealthy: unknown ${e?.message || e}`);
  emitOutput("outcome", "unknown");
  emitOutput("error", String(e?.message || e).slice(0, 200));
  process.exit(1);
});
