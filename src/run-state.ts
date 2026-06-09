// Per-user run-state persistence so the NEXT invocation can detect an
// uncatchable SIGKILL (e.g. OOM) from the previous run. The previous run
// has no chance to write "crashed" — SIGKILL is uncatchable — so the only
// way to surface "your last deploy was probably OOM-killed" is by looking
// at a file the previous run left behind with status="running" and a high
// peak-RSS.
//
// This module is intentionally self-contained (no `./telemetry.js` import)
// to avoid an import cycle: telemetry.ts's `sampleMemory` calls into here
// via `writeRunState`.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import pkg from "../package.json";

export const VERSION: string = pkg.version;

export type RunStatus = "running" | "succeeded" | "failed" | "crashed";

export interface RunState {
  status: RunStatus;
  pid: number;
  startedAt: number;
  endedAt?: number;
  toolVersion: string;
  // Sanitised argv — positional args + presence-only flag summary. Never
  // carries `--mnemonic`, `--password`, or RPC URLs verbatim.
  argv: string[];
  lastPeakRssMb: number | null;
  lastStage: string | null;
  reason?: string;
}

// Platform-appropriate per-user state directory. Not configurable via CLI
// flag — the whole point is that the NEXT invocation finds the file, and
// a flag would require the user to know it. Users with a readonly HOME
// degrade gracefully (write failures swallowed).
export function resolveStateDir(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "bulletin-deploy");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "bulletin-deploy");
  }
  // Linux / other POSIX: XDG_STATE_HOME spec.
  const base = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
    ? process.env.XDG_STATE_HOME
    : path.join(os.homedir(), ".local", "state");
  return path.join(base, "bulletin-deploy");
}

export function stateFilePath(): string {
  return path.join(resolveStateDir(), "last-run.json");
}

// Load prior run state. Returns null on missing file, malformed JSON, or
// any filesystem error. Never throws — the caller relies on a null check,
// not exception handling, because a corrupt state file must not crash the
// deploy.
export function loadRunState(): RunState | null {
  try {
    const raw = fs.readFileSync(stateFilePath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as RunState;
  } catch {
    return null;
  }
}

// Atomic merge-over write: read-modify-write via tmp-file + rename so a
// crash mid-write leaves the previous (or no) file, never a half-written
// JSON that would fail the next load.
export function writeRunState(patch: Partial<RunState>): void {
  try {
    const dir = resolveStateDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = stateFilePath();
    let existing: Partial<RunState> = {};
    try {
      const raw = fs.readFileSync(file, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") existing = parsed as Partial<RunState>;
    } catch {
      // Missing or corrupt — start fresh.
    }
    const merged: Partial<RunState> = { ...existing, ...patch };
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(merged), { encoding: "utf-8" });
    fs.renameSync(tmp, file);
  } catch {
    // Readonly HOME on CI, permission errors, full disk — all non-fatal.
    // State persistence is a diagnostic aid; the deploy must proceed.
  }
}

// `process.kill(pid, 0)` returns without error if the process exists and
// we can signal it. ESRCH means the process is gone (can warn about it).
// EPERM means the process is alive but owned by another user (suppress
// warning — could be a concurrent deploy from another terminal).
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

// When to NOT warn about a stale "running"/"crashed" run:
// - Prev PID is still alive (likely a concurrent deploy in another terminal).
// - Prev tool version differs from this one (probably a version bump).
export function shouldSkipStaleWarning(prev: RunState): boolean {
  if (prev.pid && isPidAlive(prev.pid)) return true;
  if (prev.toolVersion !== VERSION) return true;
  return false;
}

// Threshold override: tests and advanced users can bump it via env var.
// Default 1800 MB — below the Node 22 default heap cap (~2 GB resident) so
// most OOM kills trip it, but above steady-state deploys (peak ~800 MB on
// medium apps) so healthy deploys don't trigger a false hint.
export function probablyOomRssMb(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) return override;
  const env = process.env.PAD_OOM_HINT_RSS_MB;
  const parsed = env != null ? Number(env) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 1800;
}

export function shouldShowOomHint(prev: RunState): boolean {
  if (prev.lastPeakRssMb == null) return false;
  return prev.lastPeakRssMb >= probablyOomRssMb();
}
