// If the harness is still alive after the suite finished, name what holds the
// event loop open and fail fast instead of running into the job timeout (#1393).

import * as fs from "node:fs";
import { HARNESS_GUARD_MARKER, NO_RETRY_EXIT_CODE } from "../../tools/release-retry-wrapper.mjs";

// WeakRef so a fired timer's callback, and whatever it captured, stays collectable.
const tracked = new Map();
let nextId = 0;

// Records where long timers were created so a leaked one can be traced. Blind to
// timers armed before this runs and to sub-second timeouts that re-arm themselves;
// both still show up by type. The threshold keeps stack capture off the hot path.
export function trackTimers() {
  for (const name of ["setTimeout", "setInterval"]) {
    const orig = globalThis[name];
    if (orig.__e2eTracked) continue;
    const wrapped = function (fn, ms, ...args) {
      const timer = orig(fn, ms, ...args);
      if (typeof timer === "object" && (name === "setInterval" || ms >= 1000)) {
        tracked.set(nextId++, {
          name, ms, ref: new WeakRef(timer),
          stack: new Error().stack.split("\n").slice(2, 6).join("\n    "),
        });
      }
      return timer;
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(orig));
    wrapped.__e2eTracked = true;
    globalThis[name] = wrapped;
  }
}

/** Arms an unref'd timer, so it only fires if something else keeps the process alive. */
export function armExitGuard(graceMs = 30_000) {
  const guard = setTimeout(() => {
    // writeSync because process.exit does not flush an async write, and a loop
    // because a non-blocking pipe returns short or raises EAGAIN. Bounded, so a
    // reader that never drains cannot hang the thing built to break a hang.
    const deadline = Date.now() + 10_000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const write = (line) => {
      const buf = Buffer.from(line + "\n");
      let written = 0;
      while (written < buf.length) {
        try {
          const n = fs.writeSync(2, buf, written, buf.length - written);
          if (n <= 0) return;
          written += n;
        } catch (err) {
          if (err?.code !== "EAGAIN" || Date.now() > deadline) return;
          Atomics.wait(sleeper, 0, 0, 1);
        }
      }
    };
    write(`${HARNESS_GUARD_MARKER} process still alive ${graceMs / 1000}s after the suite finished; something holds the event loop open.`);
    // Each section is independent: one unreadable handle must not lose the rest.
    try { write(`   active resources: ${process.getActiveResourcesInfo().join(", ")}`); } catch {}
    // The streams, not their _handle: _getActiveHandles returns Socket wrappers.
    const ownStdio = new Set([process.stdout, process.stderr, process.stdin].filter(Boolean));
    for (const h of safely(() => process._getActiveHandles?.() ?? [])) {
      if (ownStdio.has(h)) continue;
      write(`   handle ${safely(() => describeHandle(h), "undescribable")}`);
    }
    for (const r of safely(() => process._getActiveRequests?.() ?? [])) {
      write(`   request ${safely(() => r?.constructor?.name, "unknown")}`);
    }
    for (const [id, meta] of tracked) {
      const timer = meta.ref.deref();
      // Fallback true: a timer we cannot inspect is still a suspect.
      if (!timer || timer._destroyed || !safely(() => timer.hasRef(), true)) { tracked.delete(id); continue; }
      write(`   ${meta.name}(${meta.ms}ms) created at:\n    ${meta.stack}`);
    }
    // node --test normalises this to 1, so the wrapper keys on the marker there;
    // the code still matters outside the test runner.
    process.exit(NO_RETRY_EXIT_CODE);
  }, graceMs);
  guard.unref();
}

function safely(fn, fallback = []) {
  try { return fn(); } catch { return fallback; }
}

function describeHandle(h) {
  const type = h?.constructor?.name ?? typeof h;
  if (h.remoteAddress) return `${type} -> ${h.remoteAddress}:${h.remotePort}`;
  if (h.pid) return `${type} pid=${h.pid} ${(h.spawnargs ?? []).join(" ")}`;
  // A piped stdio socket answers address() with {}, which reads as a server.
  const addr = safely(() => h.address?.(), null);
  if (addr && addr.port != null) return `${type} listening on ${addr.address}:${addr.port}`;
  if (h.localPort) return `${type} local port ${h.localPort}`;
  if (h.fd !== undefined) return `${type} fd=${h.fd}`;
  return type;
}
