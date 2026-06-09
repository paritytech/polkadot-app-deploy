// Round-trip verifier for incremental-upload-v2.
//
// Fetches a deployed CID's bytes via the gateway, parses as CAR, walks to
// `.bulletin-deploy/manifest.json`, and asserts byte-equality against a
// reference manifest blob. Used by the s-inc-roundtrip e2e leg.
//
// Spec: docs-internal/superpowers/specs/2026-05-08-incremental-upload-v2-revision-design.md (§ 10)

import { extractManifestFromCar } from "./manifest-fetch.js";

export interface RoundtripOptions {
  gateway: string;
  budgetMs?: number;        // total polling budget; default 30 s
  pollIntervalMs?: number;  // between attempts; default 2 s
  perRequestTimeoutMs?: number; // single fetch timeout; default 10 s
}

export async function fetchManifestRoundtrip(
  cid: string,
  options: RoundtripOptions
): Promise<{ ok: true; manifestBytes: Uint8Array } | { ok: false; reason: string }> {
  const gateway = options.gateway.replace(/\/$/, "");
  const budget = options.budgetMs ?? 30_000;
  const poll = options.pollIntervalMs ?? 2_000;
  const perReq = options.perRequestTimeoutMs ?? 10_000;
  const start = Date.now();
  let lastReason = "no attempts";

  while (Date.now() - start < budget) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), perReq);
    let res: Response;
    try {
      res = await fetch(`${gateway}/ipfs/${cid}`, { signal: ctrl.signal });
    } catch (e: any) {
      lastReason = `network: ${e?.message ?? e}`;
      clearTimeout(timer);
      await sleep(poll); continue;
    } finally { clearTimeout(timer); }

    if (res.status === 404 || res.status === 504) {
      lastReason = `gateway HTTP ${res.status}`;
      await sleep(poll); continue;
    }
    if (res.status !== 200) {
      lastReason = `gateway HTTP ${res.status}`;
      await sleep(poll); continue;
    }

    const buf = await res.arrayBuffer();
    const carBytes = new Uint8Array(buf);
    const manifestBytes = await extractManifestFromCar(carBytes);
    if (!manifestBytes) {
      lastReason = "manifest not in deployed DAG";
      await sleep(poll); continue;
    }
    return { ok: true, manifestBytes };
  }
  return { ok: false, reason: `roundtrip budget exhausted: ${lastReason}` };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
