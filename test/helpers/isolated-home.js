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
import { fileURLToPath, pathToFileURL } from "node:url";
import { readShippedDescriptor } from "../../tools/lib/stack-copies.mjs";

/** A local port nothing listens on: a connect there fails at once. */
export const UNREACHABLE_ENDPOINT = "ws://127.0.0.1:1";

const NO_NETWORK_PRELOAD = pathToFileURL(fileURLToPath(new URL("./no-network.mjs", import.meta.url))).href;

/**
 * Writes the built-in stack `id` as a descriptor file in `dir`, with each chain served only at
 * `urlFor(role)` (an unreachable local port by default), and returns its path. The file is
 * unsigned, so it loads as a custom testnet stack without any fetch.
 */
export function writeLocalStack(dir, { id = "paseo-next-v2", urlFor = () => UNREACHABLE_ENDPOINT } = {}) {
  const descriptor = readShippedDescriptor(id);
  const file = path.join(dir, `${id}-local-stack.json`);
  fs.writeFileSync(file, JSON.stringify({ ...descriptor, chains: descriptor.chains.map((chain) => ({ ...chain, rpc: [urlFor(chain.role)] })) }));
  return file;
}

/** Shell variables that select a network, an endpoint or a signer; tests never inherit them. */
const INHERITED_SELECTION_VARIABLES = ["PAD_ENV", "PAD_ENV_FILE", "PAD_STACK", "BULLETIN_RPC", "DOTNS_RPC", "MNEMONIC", "DOTNS_MNEMONIC"];

/**
 * The environment for a spawned CLI or tool: HOME and the state, config and cache dirs inside
 * `home`, PAD_STACK set to a local stack in `home`, no inherited stack, RPC, signer
 * or telemetry settings, and test/helpers/no-network.mjs preloaded so a connection to anything
 * but localhost fails. `extra` overrides; an `undefined` value removes the variable.
 */
export function createCliTestEnv(home, extra = {}) {
  const env = { ...process.env };
  const stackFile = writeLocalStack(home);
  for (const name of INHERITED_SELECTION_VARIABLES) delete env[name];
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    PAD_STACK: stackFile,
    PAD_UPDATE_CHECK: "0",
    PAD_TELEMETRY: "0",
    SENTRY_DSN: "",
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${NO_NETWORK_PRELOAD}`.trim(),
  });
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

// Points HOME (and the other platform-specific vars resolveStateDir()
// consults) at a fresh tmpdir, and unsets the inherited network, endpoint
// and signer variables. Returns { tmp, restore } — call restore()
// exactly once, however the test ends (success, failure, or an async
// tail), to put the env vars and filesystem back.
export function setupIsolatedHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-isolated-home-"));
  const homeVariables = {
    HOME: tmp,
    USERPROFILE: tmp,
    LOCALAPPDATA: path.join(tmp, "AppData", "Local"),
    XDG_STATE_HOME: path.join(tmp, ".local", "state"),
  };
  const saved = Object.fromEntries([...Object.keys(homeVariables), ...INHERITED_SELECTION_VARIABLES].map((name) => [name, process.env[name]]));
  Object.assign(process.env, homeVariables);
  for (const name of INHERITED_SELECTION_VARIABLES) delete process.env[name];

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
