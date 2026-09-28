#!/usr/bin/env node
// probe-env-health.mjs
//
// Tests whether a bulletin-deploy E2E environment is healthy by probing
// every external surface a deploy actually depends on:
//   1. Asset Hub RPC — WS + system_chain + state_call(ReviveApi.address)
//   2. Bulletin RPC  — WS + system_chain (Bulletin has no Revive; liveness only)
//   3. People RPC    — WS + system_chain (no Revive on People; liveness only).
//      ADVISORY ONLY (#1595 follow-up, reverted from gating; port of bulletin
//      PR #1596-follow-up): still probed and reported, but a People failure
//      does NOT flip the env's overall health. select-env gates every E2E
//      job in the workflow, including ones that never touch the People
//      chain — gating on it meant a People-only outage on the primary env
//      failed select-env outright, and on THIS repo (only one e2eEligible
//      env) failed EVERY job with no fallback target at all. Per-chain
//      fallback for the chains that DO need People now lives at the test
//      level instead (test/e2e-chain-calls.test.js's candidateEndpoints()/
//      connectChainWithFallback()).
//   4. Bulletin gateway (HTTP) — fetch the env's `ipfs` URL; any HTTP status
//      means the gateway server is up (404 at "/" is fine — the gateway
//      doesn't serve a root index but proves it's reachable).
//   5. DotNS contract presence (issue #1329 in bulletin-deploy) — a chain can
//      be RPC-live with zero deployable DotNS contracts. DotNS deploys
//      through a CREATE3 factory, so contract addresses are IDENTICAL across
//      every env and stable across a chain reset — a configured address can
//      point at empty space on a freshly reset chain. Code presence (not
//      address presence) is the only real signal, checked via a raw
//      state_getStorage read on pallet-revive's AccountInfoOf map for the
//      env's POP_RULES and DOTNS_REGISTRAR_CONTROLLER addresses. Deliberately
//      does NOT probe the DotNS protocol generation (startingPrice/
//      pricingVersion) — envs legitimately run different contract
//      generations and src/dotns-protocol.ts already owns that distinction;
//      probing a version-specific function here would wrongly fail a
//      healthy env.
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
import { fileURLToPath } from "node:url";

// The two DotNS contracts a deploy cannot proceed without: POP_RULES gates
// name classification/pricing, DOTNS_REGISTRAR_CONTROLLER handles
// commit/register. Both must have code on chain, not just a configured
// address (see the CREATE3 note above).
const DOTNS_CHECK_KEYS = ["POP_RULES", "DOTNS_REGISTRAR_CONTROLLER"];

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

// #1538 (bulletin-deploy) looked at replacing this hand-parse with the real
// src/environments.ts resolveEndpoints()/loadEnvironments() (which the
// comment below used to say it was manually matching). Deliberately NOT
// done: this function is invoked directly by .github/workflows/e2e.yml's
// `select-env` job (`node tools/probe-env-health.mjs --env "$env"`), which
// runs no `npm ci` and no `npm run build` before that call — a hard
// "zero npm deps, no build step" constraint documented in this file's own
// header. `dist/` (where resolveEndpoints lives once built) is gitignored
// and does not exist in that job's checkout. Importing it here would make
// `select-env` crash with "dist/environments.js not found" — no env would
// get selected, and the whole E2E pipeline goes dark. Do NOT "fix" this
// hand-parse without first adding a build step to `select-env` or otherwise
// removing the zero-build constraint.
// A drift-guard test (test/probe-env-health.test.js) runs under `npm test`,
// where `dist/` does exist, and will catch this hand-parse silently
// diverging from resolveEndpoints() for any e2eEligible env.
export function loadEnv(envId) {
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
  // Resolve every chain endpoint this probe touches. Asset Hub hosts the
  // Revive pallet (and therefore ReviveApi.address) and Bulletin hosts
  // content storage — both GATE env health below. People is resolved too
  // (advisory reporting only, see the module comment above) but is
  // deliberately NOT required here: an env with no people entry at all is
  // just "people not configured", reported the same as a live People probe
  // failure, not a config_error that would gate health. Match how
  // src/environments.ts::resolveEndpoints reads it (chains is an array of
  // chain objects, each with an `id` and an `endpoints` map keyed by env id)
  // — see the module-level comment above for why this stays a hand-parse
  // instead of importing resolveEndpoints itself.
  const pickWss = (chainId) => {
    const chain = (doc.chains || []).find((c) => c.id === chainId);
    const wss = chain?.endpoints?.[envId]?.wss;
    return Array.isArray(wss) ? wss[0] : wss;
  };
  const assetHubRpc = pickWss("asset-hub");
  const bulletinRpc = pickWss("bulletin");
  const peopleRpc = pickWss("people"); // advisory only — may be undefined
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
  return { entry, assetHubRpc, bulletinRpc, peopleRpc, gatewayUrl };
}

// Probe a single chain over WebSocket. Returns { ok: true, result } on success
// or { ok: false, kind, message } on failure. Does not exit the process —
// caller composes results from multiple chain probes.
// Storage key prefix for pallet-revive's `AccountInfoOf` map:
//   twox128("Revive") ++ twox128("AccountInfoOf")
// Hardcoded because this probe must stay dependency-free — no npm ci / npm
// run build precedes it in select-env's job. Node has no twox128, so the
// prefix is precomputed rather than derived at runtime. To re-derive:
//   xxhashAsU8a("Revive", 128) ++ xxhashAsU8a("AccountInfoOf", 128)
// from @polkadot/util-crypto. `test/probe-env-health.test.js` pins this value.
//
// The map uses the **Identity** hasher for its H160 key (verified against a
// live chain: contract addresses return data, EOAs and unused addresses
// return null), so the full key is simply PREFIX ++ <20-byte H160> — no
// per-key hashing, hence no crypto dependency.
const REVIVE_ACCOUNT_INFO_PREFIX =
  "735f040a5d490f1107ad9c56f5ca00d2ae37ff0591fdbbcd9c2406df7147a9dc";

function reviveAccountInfoKey(h160) {
  return "0x" + REVIVE_ACCOUNT_INFO_PREFIX + h160.replace(/^0x/, "").toLowerCase();
}

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
      for (const { id, method, params, errorKind, validateKind, validate } of calls) {
        const resp = await sendRpc(id, method, params);
        if (settled) return; // timed out mid-flight
        if (resp.error) return fail(errorKind, `${method}: ${resp.error.message}`);
        if (validate) {
          const err = validate(resp.result);
          // validateKind separates "the RPC itself failed" (errorKind) from
          // "the RPC answered and the answer proves the env is unusable".
          if (err) return fail(validateKind || errorKind, `${method}: ${err}`);
        }
        results[method] = resp.result;
      }
      clearTimeout(timer);
      settle({ ok: true, result: results });
    };
  });
}

// Config half of the DotNS readiness check (bulletin-deploy issue #1329): the
// env must declare the contracts a deploy needs. The on-chain half runs as
// extra `state_call`s on the SAME Asset Hub probe below (dotnsStorageCalls) —
// same connection, same timeout, no extra dependency.
function checkDotnsConfigured(contracts) {
  if (!contracts || Object.keys(contracts).length === 0) {
    return { ok: false, kind: "dotns_not_configured", message: "env has no contracts block — cannot support a DotNS deploy" };
  }
  const missingKeys = DOTNS_CHECK_KEYS.filter((k) => !contracts[k]);
  if (missingKeys.length > 0) {
    return { ok: false, kind: "dotns_not_configured", message: `env contracts block missing ${missingKeys.join(", ")}` };
  }
  return { ok: true };
}

// One state_getStorage per checked contract. A configured address proves
// nothing on its own: DotNS deploys through a CREATE3 factory, so addresses
// are identical across chains and stable across resets — a configured
// address can point at empty space on a freshly reset chain. `null` means no
// code at that address.
function dotnsStorageCalls(contracts, startId) {
  return DOTNS_CHECK_KEYS.map((key, i) => ({
    id: startId + i,
    method: "state_getStorage",
    params: [reviveAccountInfoKey(contracts[key])],
    errorKind: "dotns_probe_error",
    validateKind: "dotns_contract_missing",
    validate: (r) =>
      r === null || r === undefined
        ? `no contract code at ${contracts[key]} (${key}) — chain may have been reset`
        : null,
  }));
}

async function probe({ env, timeoutMs }) {
  const t0 = Date.now();
  const loaded = loadEnv(env);
  if (loaded.error) {
    fail(loaded.error.kind, loaded.error.message, Date.now() - t0);
  }
  const { assetHubRpc, bulletinRpc, peopleRpc, gatewayUrl } = loaded;

  // DotNS config check first — it needs no network, so a misconfigured env
  // fails before we open a socket.
  const dotnsConfig = checkDotnsConfigured(loaded.entry.contracts);
  if (!dotnsConfig.ok) fail(dotnsConfig.kind, dotnsConfig.message, Date.now() - t0);

  // 1. Asset Hub: WS + system_chain + ReviveApi.address (Revive lives here),
  //    plus one state_getStorage per DotNS contract to prove code presence.
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
      ...dotnsStorageCalls(loaded.entry.contracts, 3),
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

  // 3. People: WS + system_chain — ADVISORY ONLY (#1595 follow-up). Probed
  // and reported, but never gates env health (see the module comment above
  // for why gating on it was reverted). A missing config entry and a live
  // probe failure are reported identically as "DOWN" — from a health-gating
  // perspective they mean the same thing: this env cannot serve the People
  // chain right now.
  let peopleStatus = "not configured";
  if (peopleRpc) {
    const ppl = await probeChain({
      url: peopleRpc,
      timeoutMs,
      calls: [{ id: 1, method: "system_chain", params: [], errorKind: "rpc_error" }],
    });
    peopleStatus = ppl.ok ? ppl.result.system_chain : "DOWN";
    if (!ppl.ok) {
      console.error(`advisory: people ${ppl.kind} ${ppl.message} — not gating env health`);
    }
  } else {
    console.error(`advisory: people no RPC configured for env "${env}" — not gating env health`);
  }

  // 4. Gateway: HTTP fetch. Any HTTP response = gateway server up (a 404 at
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
    `healthy: ${env} (asset-hub=${ah.result.system_chain}, bulletin=${bul.result.system_chain}, people=${peopleStatus}, gateway=${gatewayStatus}, dotns=ok, ${duration}ms)`,
  );
  emitOutput("outcome", "healthy");
  emitOutput("people_status", peopleStatus);
  emitOutput("duration_ms", String(duration));
  process.exit(0);
}

// Only run the CLI when invoked directly (not when imported for tests, e.g.
// the loadEnv() drift-guard test in test/probe-env-health.test.js).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
}
