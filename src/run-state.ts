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
import * as crypto from "node:crypto";
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

// os.homedir() throws ERR_SYSTEM_ERROR when HOME is unset and the current
// UID has no /etc/passwd entry (containers run with --user) — #1412 code
// review found this reachable. Falls back to os.tmpdir(), which never
// consults the passwd database (it reads TMPDIR/TMP/TEMP, falling back to a
// fixed path). A state file landing under /tmp instead of the real home is
// a degraded-but-working outcome — this whole module is a diagnostic/resume
// aid, never a deploy requirement.
function homedirOrFallback(): string {
  try {
    return os.homedir();
  } catch {
    return os.tmpdir();
  }
}

// Platform-appropriate per-user state directory. Not configurable via CLI
// flag — the whole point is that the NEXT invocation finds the file, and
// a flag would require the user to know it. Users with a readonly HOME
// degrade gracefully (write failures swallowed).
//
// This function itself never throws (see homedirOrFallback above) — every
// caller below ALSO resolves it via a path thunk inside its own try, as a
// second, independent layer: relying on every future call site remembering
// that discipline would be the same class of mistake that caused #1412 in
// the first place, so this function is hardened directly rather than
// leaving that discipline as the only guarantee.
export function resolveStateDir(): string {
  if (process.platform === "darwin") {
    return path.join(homedirOrFallback(), "Library", "Application Support", "polkadot-app-deploy");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(homedirOrFallback(), "AppData", "Local");
    return path.join(base, "polkadot-app-deploy");
  }
  // Linux / other POSIX: XDG_STATE_HOME spec.
  const base = process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
    ? process.env.XDG_STATE_HOME
    : path.join(homedirOrFallback(), ".local", "state");
  return path.join(base, "polkadot-app-deploy");
}

export function stateFilePath(): string {
  return path.join(resolveStateDir(), "last-run.json");
}

// Reads a JSON file, returning null on any failure — missing file,
// malformed JSON, permission error. Never throws: callers rely on a null
// check, not exception handling, because a corrupt state file must not
// crash the deploy. Shared by loadRunState and loadCommitmentRecord — both
// want exactly this "never throw, null on any problem" contract.
//
// Takes a PATH THUNK, not a path string: resolving the path (stateFilePath/
// commitmentStateFilePath, both of which call resolveStateDir() and
// therefore os.homedir()) must happen INSIDE the try below, not as an
// argument expression evaluated by the caller before this function is even
// entered. os.homedir() throws ERR_SYSTEM_ERROR when HOME is unset and the
// current UID has no /etc/passwd entry (containers run with --user) — code
// review on #1412 found this was reachable and crashed register() before
// the fix, since `readJsonSafe(stateFilePath())` evaluates stateFilePath()
// eagerly, outside any try.
function readJsonSafe<T>(pathThunk: () => string): T | null {
  try {
    return parseJsonRecord<T>(fs.readFileSync(pathThunk(), "utf-8"));
  } catch {
    return null;
  }
}

// Parses a JSON object, returning null for anything that isn't a non-null
// object (including a bare string/number/array or malformed JSON, which
// JSON.parse itself throws on — caught by this function's own try so
// callers get one uniform null-on-any-parse-problem contract). Shared by
// readJsonSafe (which also needs the READ to succeed) and
// pruneStaleCommitmentRecords (which needs to tell "couldn't even read the
// file" apart from "read it, but it's not valid JSON" — see that function).
function parseJsonRecord<T>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? (parsed as T) : null;
  } catch {
    return null;
  }
}

// Unlinks a file, swallowing any error (already gone, permission denied) —
// never fatal, since every call site here is best-effort cleanup, not a
// deploy requirement.
function tryUnlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Already gone, or a permission error — nothing more to do.
  }
}

// Atomic write: tmp-file + rename, so a crash mid-write leaves the previous
// (or no) file, never a half-written JSON that would fail the next load.
// Returns false (never throws) on any failure — readonly HOME, permission
// error, full disk, ENOTDIR — since everything in this module is a
// diagnostic/resume aid, never a deploy requirement. Shared by writeRunState
// (after its own read-modify-merge) and writeCommitmentRecord (a plain
// full-replace, no merge).
//
// Same path-thunk reasoning as readJsonSafe above — path resolution happens
// inside the try, not in the caller's argument expression.
function writeJsonAtomic(pathThunk: () => string, data: unknown, options?: { mode?: number }): boolean {
  let tmp: string | undefined;
  try {
    const file = pathThunk();
    // 0700, not the default 0755: filenames under this directory embed the
    // PENDING label for an in-flight commit-reveal (commitment-<key>.json,
    // where key includes the label) — exactly what commit-reveal exists to
    // keep confidential until reveal. A world/group-readable directory
    // listing would leak that label to anyone who can `ls` it, even without
    // read access to the files themselves.
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: "utf-8", ...(options?.mode !== undefined ? { mode: options.mode } : {}) });
    fs.renameSync(tmp, file);
    tmp = undefined; // Renamed successfully — nothing left to clean up.
    return true;
  } catch {
    if (tmp !== undefined) {
      // The tmp file can hold the SAME plaintext secret as the final file
      // (writeFileSync succeeded, renameSync failed) — never leave it
      // behind under a predictable name just because the atomic swap
      // itself failed. Best-effort: if this also fails, pruneStaleCommitmentRecords
      // sweeps orphaned commitment-*.tmp files by mtime as a backstop.
      tryUnlink(tmp);
    }
    return false;
  }
}

// Load prior run state. Returns null on missing file, malformed JSON, or
// any filesystem error. Never throws.
export function loadRunState(): RunState | null {
  return readJsonSafe<RunState>(stateFilePath);
}

// Merge-over write: read-modify-write, then an atomic tmp-file + rename.
export function writeRunState(patch: Partial<RunState>): void {
  const existing = readJsonSafe<Partial<RunState>>(stateFilePath) ?? {};
  writeJsonAtomic(stateFilePath, { ...existing, ...patch });
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

// ---------------------------------------------------------------------------
// DotNS commitment resume state (issue #1412)
//
// A deploy that dies between DotNS `commit` and `register` abandons an
// on-chain commitment it can never reveal again — the reveal preimage
// includes a `secret` that only ever lived in memory. This record persists
// enough to resume: the commit-reveal `secret` plus the exact registration
// tuple it was committed with, so a later invocation can skip straight to
// waiting out `minCommitmentAge` and revealing, instead of paying a fresh
// commit fee and re-waiting from zero.
//
// SENSITIVITY: `secret` here is the commit-reveal preimage, not an account
// credential — see the issue's own follow-up comment (bulletin #1412)
// for the full reasoning. It cannot be used to steal the name (the `owner`
// field is baked into the commitment hash and the contract pays out to
// whoever the tuple names), only to reveal the label early or front-run the
// reveal on the SAME label. That is a narrow, commitment-window-bounded
// exposure — bounded by chain-enforced `maxCommitmentAge` — not an at-rest
// account-security concern, so this is written plaintext rather than
// encrypted (encryption would need a credential to derive a key from, which
// the phone/SSO signer path does not have). Mitigated by:
//   - 0600 file permission, applied at CREATE time (the `mode` option on
//     writeFileSync), never as a follow-up chmod — no window where the file
//     is briefly more permissive.
//   - A dedicated file PER (environment, tld, owner, label) — see
//     commitmentKey — so two different callers, or the same caller
//     targeting two envs OR TWO DIFFERENT LABELS, never clobber each
//     other's in-flight commitment. Keying on label matters as much as
//     owner: the same signer committing to label A, then (before A
//     registers) starting a separate deploy to label B, must not have B's
//     write or clear touch A's still-resumable record.
//   - Written under `resolveStateDir()`, the same per-user OS state
//     directory as `last-run.json` — NOT under the deployed build directory.
//     This module has no awareness of any build/publish path, so there is no
//     code path by which this file could end up inside `.bulletin-deploy/`
//     (the manifest directory that DOES get uploaded — see src/manifest.ts).
//   - Cleared on successful registration, and discarded (never blindly
//     reused) the moment it's found to be for a different label/owner, or
//     to have gone stale on-chain (see DotNS.resolveResumableCommitment in
//     src/dotns.ts, which owns all chain-dependent validity checks — this
//     module is intentionally chain-agnostic, pure file I/O only).

export interface DotnsCommitmentRecord {
  savedAt: number;
  environmentId: string;
  tld: string;
  // The ABI-profile discriminator (DotnsAbiProfile in dotns-protocol.ts) the
  // registration tuple was built for. A resumed commitment must be re-read
  // against the SAME profile that produced it.
  protocol: string;
  label: string;
  // EVM address — the committed tuple's `owner` field, not secret material.
  owner: string;
  reserved: boolean;
  // The commit-reveal secret. See the module doc comment above.
  secret: string;
  // Present only on profiles where needsPricingBeforeCommit is true.
  // Serialized as decimal strings (bigint has no native JSON representation).
  maxPrice?: string;
  pricingVersion?: string;
  // The bytes32 commitment hash already submitted on-chain.
  commitment: string;
  // #1659: a random id per written record, so a process clears or replaces
  // only the record it wrote or resumed (compare-and-replace below). Records
  // written before #1659 have none; commitmentRecordKey gives them a stable
  // key from their commitment hash.
  recordId?: string;
}

const COMMITMENT_FILE_MODE = 0o600;

function sanitizeKeyComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

// Keyed by (environmentId, tld, owner, label) — not a single shared file
// like last-run.json, and NOT owner-only — so a deploy for one
// caller/env/label never discards or reuses a different caller/env/label's
// in-flight commitment on the same machine. Label matters as much as owner
// here: see the module doc comment above.
function commitmentKey(environmentId: string, tld: string, owner: string, label: string): string {
  return `${sanitizeKeyComponent(environmentId)}_${sanitizeKeyComponent(tld)}_${sanitizeKeyComponent(owner.toLowerCase())}_${sanitizeKeyComponent(label)}`;
}

export function commitmentStateFilePath(environmentId: string, tld: string, owner: string, label: string): string {
  return path.join(resolveStateDir(), `commitment-${commitmentKey(environmentId, tld, owner, label)}.json`);
}

// #1659: one lock per record key, held for a whole commitAndRegister, so two
// processes committing the same (env, tld, owner, label) never interleave
// their resolve / persist / clear on the one record file.
export function commitmentLockFilePath(environmentId: string, tld: string, owner: string, label: string): string {
  return path.join(resolveStateDir(), `commitment-${commitmentKey(environmentId, tld, owner, label)}.lock`);
}

// The identity compare-and-replace and compare-and-unlink check against.
export function commitmentRecordKey(record: DotnsCommitmentRecord | null): string | null {
  if (!record) return null;
  return typeof record.recordId === "string" ? record.recordId : `legacy:${record.commitment}`;
}

// Fallback for the chain's `maxCommitmentAge` when a live read of it fails.
// Lives here (not in src/dotns.ts, where it's actually used) because
// dotns.ts already imports this module for commitment-record persistence —
// importing the other way would create a cycle (this module is deliberately
// self-contained; see the note on VERSION above). dotns.ts's
// waitForCommitmentAge and resolveResumableCommitment both fall back to
// this exact value when maxCommitmentAge() can't be read live; keeping one
// named constant stops the two from drifting independently.
export const FALLBACK_MAX_COMMITMENT_AGE_SECONDS = 86_400;

// Pruning ceiling for abandoned commitment records (#1412 triage). The
// chain's own `maxCommitmentAge` decides when a commitment is provably dead
// on-chain, but that value isn't knowable from this offline, chain-agnostic
// module — it lives on the DotNS contract and varies per deployment.
// `savedAt` is written BEFORE the commit tx is even submitted, so a
// record's on-disk age is always >= its true on-chain commitment age —
// pruning at exactly FALLBACK_MAX_COMMITMENT_AGE_SECONDS risks deleting a
// record the chain would still call valid. Double it: a full extra day of
// headroom over the fallback while still bounding how long an abandoned
// label's plaintext secret can sit on disk (see the SENSITIVITY note above
// `DotnsCommitmentRecord`). ASSUMPTION this relies on: every environment's
// real on-chain `maxCommitmentAge` is <= 48h. If a future environment ever
// configures a longer window, this ceiling would need to grow with it —
// resolveResumableCommitment's own live on-chain expiry check (in
// src/dotns.ts) is the actual source of truth for validity either way, so
// getting this wrong only costs an extra fresh-commit fee, never a bad
// resume; it is not a correctness gate.
const COMMITMENT_RECORD_MAX_AGE_MS = 2 * FALLBACK_MAX_COMMITMENT_AGE_SECONDS * 1000; // 48h

// Scans resolveStateDir() for every commitment-*.json file and deletes any
// that fails to PARSE as JSON (a real, permanent failure — the file can
// never become readable later) or whose savedAt is older than
// COMMITMENT_RECORD_MAX_AGE_MS. Deliberately does NOT delete a file this
// sweep merely failed to READ (EACCES, EMFILE, a rename/unlink race with a
// concurrent process) — that's a transient condition, not evidence the
// record is stale, and a later sweep gets another chance at it. Also
// removes orphaned `commitment-*.tmp` files (left behind when
// writeJsonAtomic's rename step itself fails, after the file already held
// the plaintext secret) by mtime, since they can't be parsed as a
// DotnsCommitmentRecord the same way.
//
// Called from loadCommitmentRecord (not also from writeCommitmentRecord —
// every production write is preceded by a load in the same
// commitAndRegister call, via resolveResumableCommitment in src/dotns.ts,
// so a second sweep moments later on write would just re-scan the same
// files for no benefit) so an abandoned record for ANY key gets cleaned up
// on the next commitment activity for any other key, not just its own.
// Never throws: resolving the state dir and listing it both happen inside
// the same try below, so even os.homedir() throwing degrades to a no-op,
// same posture as every other function here.
function pruneStaleCommitmentRecords(nowMs: number = Date.now()): void {
  let dir: string;
  let entries: string[];
  try {
    dir = resolveStateDir();
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith("commitment-")) continue;
    const file = path.join(dir, entry);
    if (entry.endsWith(".json")) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf-8");
      } catch {
        continue; // Transient read failure — not evidence of staleness.
      }
      // Genuinely malformed JSON (parseJsonRecord returns null) is a real,
      // permanent parse failure — distinct from the read failure above,
      // which is why this isn't just one readJsonSafe(() => file) call.
      const record = parseJsonRecord<DotnsCommitmentRecord>(raw);
      const isStale = record === null || typeof record.savedAt !== "number" || nowMs - record.savedAt > COMMITMENT_RECORD_MAX_AGE_MS;
      if (isStale) tryUnlink(file);
    } else if (entry.endsWith(".tmp") || entry.endsWith(".lock") || entry.endsWith(".stale")) {
      // .lock / .stale (#1659): a lock left by a SIGKILLed deploy. A live
      // holder's lock is never this old (the lock lives for one deploy), and
      // tryAcquireCommitmentLock takes over a dead holder's lock long before.
      // Their filenames embed the label, so they must not linger either.
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        continue; // Already gone, or unreadable — nothing to do.
      }
      if (nowMs - mtimeMs > COMMITMENT_RECORD_MAX_AGE_MS) tryUnlink(file);
    }
  }
}

// Never throws — same posture as loadRunState. A missing, corrupt, or
// unreadable record must never block a deploy; it just means no resume.
export function loadCommitmentRecord(environmentId: string, tld: string, owner: string, label: string): DotnsCommitmentRecord | null {
  pruneStaleCommitmentRecords();
  return readJsonSafe<DotnsCommitmentRecord>(() => commitmentStateFilePath(environmentId, tld, owner, label));
}

// Atomic write (tmp + rename) with the file created 0600 from the start.
// Returns false on any failure (readonly HOME, permission error, full disk,
// ENOTDIR) so the caller can log a one-line warning — but the caller must
// NEVER treat a false return as fatal: losing the ability to resume
// degrades to today's behaviour (a fresh commit), which is always safe.
export function writeCommitmentRecord(record: DotnsCommitmentRecord): boolean {
  return writeJsonAtomic(() => commitmentStateFilePath(record.environmentId, record.tld, record.owner, record.label), record, { mode: COMMITMENT_FILE_MODE });
}

// #1659 compare-and-replace: writes only when the record on disk is still the
// one the caller resolved (`expectedKey`, null = no record). The caller holds
// the commitment lock, so nothing else writes between this read and the
// rename; the compare is what stops a process from overwriting a record it
// never looked at (another process's, or one it could not verify).
export function replaceCommitmentRecord(record: DotnsCommitmentRecord, expectedKey: string | null): boolean {
  const current = readJsonSafe<DotnsCommitmentRecord>(() => commitmentStateFilePath(record.environmentId, record.tld, record.owner, record.label));
  if (commitmentRecordKey(current) !== expectedKey) return false;
  return writeCommitmentRecord(record);
}

// Compare-and-unlink (#1659): removes the record only when it is still the one
// the caller resolved or wrote (`expectedKey`, see commitmentRecordKey), so a
// process never deletes a record another process wrote meanwhile.
export function clearCommitmentRecord(environmentId: string, tld: string, owner: string, label: string, expectedKey: string | null): void {
  try {
    const current = readJsonSafe<DotnsCommitmentRecord>(() => commitmentStateFilePath(environmentId, tld, owner, label));
    if (commitmentRecordKey(current) !== expectedKey) return;
    tryUnlink(commitmentStateFilePath(environmentId, tld, owner, label));
  } catch {
    // commitmentStateFilePath itself can throw (resolveStateDir() — see the
    // path-thunk note on readJsonSafe above); tryUnlink only guards the
    // unlink call itself, so this outer try is what keeps THIS function's
    // own never-throw contract intact.
  }
}

// ---------------------------------------------------------------------------
// #1659: the commitment lock.
//
// O_EXCL create of commitment-<key>.lock (0600, no secret: pid, host, a random
// token, createdAt). A holder is STALE, and its lock is taken over, when it
// ran on this host and its pid is gone (a SIGKILLed or crashed deploy), when
// the lock is older than the record pruning ceiling, or when the file is
// unreadable garbage older than a minute (a crash mid-write). Taking over
// renames the stale file to a unique name first, so of two processes breaking
// the same stale lock only one wins the rename; the loser re-reads.

export interface CommitmentLockHolder {
  pid: number;
  host: string;
  token: string;
  createdAt: number;
}

export type CommitmentLockResult =
  // token null: the lock could not be written (readonly HOME, unresolvable
  // state dir). Resume is impossible then too, so the deploy runs unlocked,
  // exactly as before #1659.
  | { token: string | null; heldBy?: undefined; release: () => void }
  | { token?: undefined; heldBy: CommitmentLockHolder; release?: undefined };

const LOCK_GARBAGE_GRACE_MS = 60_000;

function isStaleLock(holder: CommitmentLockHolder | null, mtimeMs: number, nowMs: number): boolean {
  if (!holder || typeof holder.pid !== "number" || typeof holder.createdAt !== "number") {
    return nowMs - mtimeMs > LOCK_GARBAGE_GRACE_MS;
  }
  if (nowMs - holder.createdAt > COMMITMENT_RECORD_MAX_AGE_MS) return true;
  return holder.host === os.hostname() && !isPidAlive(holder.pid);
}

const NO_LOCK: CommitmentLockResult = { token: null, release: () => {} };

export function tryAcquireCommitmentLock(environmentId: string, tld: string, owner: string, label: string, nowMs: number = Date.now()): CommitmentLockResult {
  let file: string;
  try {
    file = commitmentLockFilePath(environmentId, tld, owner, label);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    return NO_LOCK;
  }
  const token = crypto.randomBytes(16).toString("hex");
  const mine: CommitmentLockHolder = { pid: process.pid, host: os.hostname(), token, createdAt: nowMs };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { encoding: "utf-8", flag: "wx", mode: COMMITMENT_FILE_MODE });
      return { token, release: () => releaseCommitmentLock(file, token) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") return NO_LOCK;
    }
    let raw: string;
    let mtimeMs: number;
    try {
      raw = fs.readFileSync(file, "utf-8");
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue; // Released between our create and our read: try again.
    }
    const holder = parseJsonRecord<CommitmentLockHolder>(raw);
    if (!isStaleLock(holder, mtimeMs, nowMs)) {
      return { heldBy: holder ?? { pid: 0, host: "unknown", token: "", createdAt: mtimeMs } };
    }
    const grabbed = `${file}.${process.pid}.${token}.stale`;
    try {
      fs.renameSync(file, grabbed);
    } catch {
      continue; // Someone else broke it first.
    }
    let grabbedRaw = "";
    try { grabbedRaw = fs.readFileSync(grabbed, "utf-8"); } catch { /* treat as ours */ }
    if (grabbedRaw !== raw) {
      // We moved a FRESH lock someone created after our read. Put it back
      // (link fails if yet another lock appeared) and report it as held.
      try { fs.linkSync(grabbed, file); } catch { /* the newer lock stands */ }
      tryUnlink(grabbed);
      const fresh = parseJsonRecord<CommitmentLockHolder>(grabbedRaw);
      if (fresh) return { heldBy: fresh };
      continue;
    }
    tryUnlink(grabbed);
  }
  return NO_LOCK;
}

function releaseCommitmentLock(file: string, token: string): void {
  try {
    const holder = parseJsonRecord<CommitmentLockHolder>(fs.readFileSync(file, "utf-8"));
    if (holder?.token === token) tryUnlink(file);
  } catch {
    // Already gone or unreadable: nothing of ours to remove.
  }
}
