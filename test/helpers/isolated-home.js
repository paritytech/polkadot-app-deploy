// test/helpers/isolated-home.js — shared "point HOME/XDG_STATE_HOME/etc at a
// fresh tmpdir" helper for tests that exercise src/run-state.ts's
// resolveStateDir() (last-run.json, DotNS commitment records, ...) without
// touching the real machine's OS state dir. Two call shapes share this one
// implementation instead of being retyped per test file:
//   - setupIsolatedHome() for beforeEach/afterEach-style tests.
//   - withIsolatedHome(fn) for tests that stub methods in-process and want
//     a single wrapped call (fn may be sync or async).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Points HOME (and the other platform-specific vars resolveStateDir()
// consults) at a fresh tmpdir. Returns { tmp, restore } — call restore()
// exactly once, however the test ends (success, failure, or an async
// tail), to put the env vars and filesystem back.
export function setupIsolatedHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-isolated-home-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  };
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.LOCALAPPDATA = path.join(tmp, "AppData", "Local");
  process.env.XDG_STATE_HOME = path.join(tmp, ".local", "state");

  const restore = () => {
    for (const [name, prev] of Object.entries(saved)) {
      // process.env.X = undefined would set the literal string "undefined"
      // rather than unset the var — use delete when there was nothing to
      // restore (e.g. XDG_STATE_HOME is unset on most machines).
      if (prev === undefined) delete process.env[name];
      else process.env[name] = prev;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { tmp, restore };
}

// Callback-style wrapper for tests that stub methods on an in-process
// object rather than spawning a child process. `fn` may be sync or async —
// for an async `fn`, `restore()` runs only once its returned promise
// SETTLES, not merely once fn(tmp) returns a pending promise. That
// distinction matters: a bare `try { return fn(tmp) } finally { restore() }`
// would run `restore()` at fn's first `await` (whenever the synchronous
// prologue suspends), not at its actual completion — everything in the test
// body after that first await would then run against the REAL machine home
// directory instead of the isolated tmp one, and the tmp dir would already
// be deleted underneath it.
export function withIsolatedHome(fn) {
  const { tmp, restore } = setupIsolatedHome();
  let result;
  try {
    result = fn(tmp);
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return result.finally(restore);
  }
  restore();
  return result;
}
