// Child process for test/socket-leak.test.js (#1675). Runs ONE connection
// scenario through the real dist/ factories, prints the handles still active,
// then returns WITHOUT calling process.exit. The parent asserts that the process
// exits by itself, which is what an in-process library caller of deploy() needs.
import { createClient } from "polkadot-api";
import { getWsProvider } from "../../dist/ws.js";
import { fetchPreviousManifest } from "../../dist/manifest-fetch.js";
import { fetchManifestRoundtrip } from "../../dist/manifest-roundtrip.js";
import { DotNS } from "../../dist/dotns.js";

const [kind, wsBase] = process.argv.slice(2);
const httpBase = wsBase.replace(/^ws/, "http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

const cases = {
  // papi client lifecycles (every src/ client is built on src/ws.ts getWsProvider)
  "connect-then-destroy": async () => { const c = createClient(getWsProvider(`${wsBase}/ok`)); await sleep(500); c.destroy(); },
  "destroy-during-connect": async () => { const c = createClient(getWsProvider(`${wsBase}/hold/1500`)); await sleep(200); c.destroy(); },
  "destroy-during-reconnect": async () => { const c = createClient(getWsProvider(`${wsBase}/drop/${kind}`)); await sleep(900); c.destroy(); },
  "connect-timeout-then-destroy": async () => { const c = createClient(getWsProvider(`${wsBase}/hold/1500`, { timeout: 300 })); await sleep(2500); c.destroy(); },
  "stale-heartbeat-then-destroy": async () => { const c = createClient(getWsProvider(`${wsBase}/ok`, { heartbeatTimeout: 400 })); await sleep(1500); c.destroy(); },
  // fetchNonce's raw WebSocket, closed mid-handshake by its own timeout
  "raw-ws-close-during-connect": async () => { const ws = new WebSocket(`${wsBase}/hold/1500`); await sleep(200); ws.close(); },
  // gateway HTTP
  "gateway-head-keepalive": async () => { await fetch(`${httpBase}/head`, { method: "HEAD" }); },
  "manifest-fetch-gateway-504": async () => { await fetchPreviousManifest(CID, { gateway: httpBase, timeoutMs: 2000 }); },
  "manifest-roundtrip-gateway-504": async () => { await fetchManifestRoundtrip(CID, { gateway: httpBase, budgetMs: 500, pollIntervalMs: 100 }); },
  // Level 2: the real DotNS Asset Hub client lifecycle with papi's REAL default
  // connect timeout (5s). recreateReviveClient is the one place connect() and the
  // setContenthash read-back build their client; disconnect() is the S7a teardown.
  "dotns-client-default-timeout": async () => { const d = new DotNS(); d["recreateReviveClient"](`${wsBase}/hold/6000`); await sleep(7000); d.disconnect(); },
};

const run = cases[kind];
if (!run) throw new Error(`unknown case ${kind}`);
await run();
await sleep(300);
console.log(`RESOURCES ${JSON.stringify(process.getActiveResourcesInfo())}`);
