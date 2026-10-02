// E2E-only seam (#1672): a cross-process barrier between a deploy's chunk-nonce
// seed read and its first chunk submit. S9 runs two deploys from one signer and
// needs both to seed BEFORE either submits, so their chunk nonces collide and the
// collision-recovery path really runs. Without the barrier the second deploy
// usually seeds from a system_accountNextIndex that already counts the first
// deploy's pending txs, and the chunks never collide.
//
// Inert unless PAD_E2E_NONCE_SEED_BARRIER names a directory. There is
// no CLI flag for it, and nothing outside the E2E harness sets it.
//   PAD_E2E_NONCE_SEED_BARRIER             directory shared by the parties
//   PAD_E2E_NONCE_SEED_BARRIER_PARTIES     how many deploys to wait for (default 2)
//   PAD_E2E_NONCE_SEED_BARRIER_TIMEOUT_MS  max wait (default 120000)
// Each party writes `<pid>.seed` holding its seed, then polls until `parties`
// seed files exist or the timeout passes. It never throws: on a timeout the
// deploy carries on, and the log line says so (S9 then fails on its precondition).
import * as fs from "node:fs";
import * as path from "node:path";

export const NONCE_SEED_BARRIER_ENV = "PAD_E2E_NONCE_SEED_BARRIER";

export interface NonceSeedBarrierResult {
  met: boolean;
  /** Every party's seed seen in the directory, own included, sorted. */
  seeds: number[];
}

export async function awaitNonceSeedBarrier(opts: {
  dir: string;
  seed: number;
  parties?: number;
  timeoutMs?: number;
  pollMs?: number;
  id?: string;
}): Promise<NonceSeedBarrierResult> {
  const parties = opts.parties ?? 2;
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
  const pollMs = opts.pollMs ?? 200;
  fs.mkdirSync(opts.dir, { recursive: true });
  fs.writeFileSync(path.join(opts.dir, `${opts.id ?? process.pid}.seed`), String(opts.seed));
  const seedFiles = (): string[] => fs.readdirSync(opts.dir).filter((f) => f.endsWith(".seed"));
  const readSeeds = (files: string[]): number[] =>
    files.map((f) => Number(fs.readFileSync(path.join(opts.dir, f), "utf8"))).sort((a, b) => a - b);
  for (;;) {
    const files = seedFiles();
    if (files.length >= parties) return { met: true, seeds: readSeeds(files) };
    if (Date.now() >= deadline) return { met: false, seeds: readSeeds(files) };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

let used = false;

/**
 * The seam storeChunkedContent calls once it knows it will submit chunks. A no-op
 * unless NONCE_SEED_BARRIER_ENV is set, and only the first call per process waits:
 * a later storeChunkedContent call (a re-upload, a second phase) is never held.
 */
export async function e2eNonceSeedBarrier(seed: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = env[NONCE_SEED_BARRIER_ENV];
  if (!dir || used) return;
  used = true;
  const parties = Number(env[`${NONCE_SEED_BARRIER_ENV}_PARTIES`] || 2);
  const timeoutMs = Number(env[`${NONCE_SEED_BARRIER_ENV}_TIMEOUT_MS`] || 120_000);
  console.log(`   E2E nonce-seed barrier: seed ${seed}, waiting for ${parties} parties`);
  const r = await awaitNonceSeedBarrier({ dir, seed, parties, timeoutMs });
  console.log(r.met
    ? `   E2E nonce-seed barrier met: seeds [${r.seeds.join(", ")}]`
    : `   E2E nonce-seed barrier timed out after ${timeoutMs}ms: seeds [${r.seeds.join(", ")}]`);
}

/** Test-only: re-arm the once-per-process guard. */
export function __resetNonceSeedBarrierForTest(): void { used = false; }
