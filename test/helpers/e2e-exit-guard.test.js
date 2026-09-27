import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { HARNESS_GUARD_MARKER, NO_RETRY_EXIT_CODE } from "../../tools/release-retry-wrapper.mjs";

const GUARD = new URL("./e2e-exit-guard.js", import.meta.url).href;

function run(body, { track = true } = {}) {
  const script = `import { trackTimers, armExitGuard } from ${JSON.stringify(GUARD)};`
    + (track ? " trackTimers();" : "") + ` ${body}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  const stderr = r.stderr ?? "";
  return {
    status: r.status,
    // Only the guard's own report, so a failure message stays readable.
    report: stderr.split("\n").filter((l) => l.startsWith(HARNESS_GUARD_MARKER) || /^ {3,}\S/.test(l)).join("\n"),
    stderr,
  };
}

describe("e2e exit guard", () => {
  test("names a leaked interval with its creation site", () => {
    const r = run("setInterval(() => {}, 5000); armExitGuard(300);");
    assert.equal(r.status, NO_RETRY_EXIT_CODE, `>> FAIL: exit guard: a leaked interval must exit ${NO_RETRY_EXIT_CODE}, got ${r.status}`);
    assert.match(r.report, new RegExp(HARNESS_GUARD_MARKER.replace(/[>]/g, "\\$&")),
      `>> FAIL: exit guard: the report must open with the harness marker; got:\n${r.report}`);
    assert.match(r.report, /setInterval\(5000ms\) created at:/,
      `>> FAIL: exit guard: a leaked interval must be named with its creation stack; got:\n${r.report}`);
  });

  test("names a leaked long timeout", () => {
    const r = run("setTimeout(() => {}, 120000); armExitGuard(300);");
    assert.equal(r.status, NO_RETRY_EXIT_CODE, `>> FAIL: exit guard: a leaked long timeout must exit ${NO_RETRY_EXIT_CODE}, got ${r.status}`);
    assert.match(r.report, /setTimeout\(120000ms\) created at:/,
      `>> FAIL: exit guard: a timeout at or above 1s must be tracked; got:\n${r.report}`);
  });

  test("reports the whole handle list rather than truncating it", () => {
    // process.exit does not flush an async write to a pipe.
    const r = run("for (let i = 0; i < 400; i++) setInterval(() => {}, 5000 + i); armExitGuard(300);");
    const named = [...r.report.matchAll(/setInterval\(\d+ms\) created at:/g)].length;
    assert.equal(named, 400, `>> FAIL: exit guard: all 400 leaked intervals must be reported, got ${named}`);
  });

  test("keeps a timer it cannot inspect, rather than dropping the only suspect", () => {
    // A live interval whose hasRef throws, the shape a library that wraps timers
    // produces. Treating that as "not referenced" would drop the only suspect.
    const r = run(`const t = setInterval(() => {}, 5000);`
      + ` t.hasRef = () => { throw new Error("uninspectable"); };`
      + ` armExitGuard(300);`);
    assert.equal(r.status, NO_RETRY_EXIT_CODE,
      `>> FAIL: exit guard: an uninspectable timer must still exit ${NO_RETRY_EXIT_CODE}, got ${r.status}`);
    assert.match(r.report, /setInterval\(5000ms\) created at:/,
      `>> FAIL: exit guard: a timer whose hasRef throws must stay in the report; got:\n${r.report}`);
  });

  test("keeps every line when the reader stalls", async () => {
    // A non-blocking pipe returns short or raises EAGAIN mid-report.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { trackTimers, armExitGuard } from ${JSON.stringify(GUARD)};`
      + ` trackTimers();`
      + ` for (let i = 0; i < 400; i++) setInterval(() => {}, 5000 + i);`
      + ` armExitGuard(200);`], { stdio: ["ignore", "ignore", "pipe"] });
    let out = "";
    // Stall inside the handler rather than with pause()/resume(): the stream stays
    // in flowing mode, and libuv cannot read the pipe while this callback runs, so
    // every chunk costs the child a full pipe to write into.
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    child.stderr.on("data", (c) => { out += c; Atomics.wait(sleeper, 0, 0, 50); });
    // Bounded, so a regression here fails this test instead of hanging the job.
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(">> FAIL: exit guard: the child never exited while the reader lagged"));
      }, 30_000);
      child.on("close", () => { clearTimeout(timer); resolve(); });
    });
    const named = [...out.matchAll(/created at:/g)].length;
    assert.equal(named, 400,
      `>> FAIL: exit guard: a stalled reader lost report lines, got ${named} of 400`);
    assert.ok(out.includes(HARNESS_GUARD_MARKER),
      ">> FAIL: exit guard: the marker the retry wrapper keys on must survive a stalled reader");
  });

  test("names the leak rather than itself when the grace period is tracked", async () => {
    // A grace above the 1 s threshold, so the guard's own timer is a candidate.
    const r = run("setInterval(() => {}, 5000); armExitGuard(1200);");
    assert.match(r.report, /setInterval\(5000ms\) created at:/,
      `>> FAIL: exit guard: the leaked interval must be named; got:\n${r.report}`);
    assert.doesNotMatch(r.report, /setTimeout\(1200ms\) created at:/,
      `>> FAIL: exit guard: the guard's own timer must not be reported as the leak; got:\n${r.report}`);
  });

  test("stays silent and lets a clean process exit 0", () => {
    const r = run("armExitGuard(300);");
    assert.equal(r.status, 0, `>> FAIL: exit guard: a clean process must exit 0, got ${r.status}`);
    assert.equal(r.stderr, "", `>> FAIL: exit guard: must print nothing on a clean exit; got:\n${r.report}`);
  });

  test("a stack frame reaches the report, so a broken creation site fails these tests", () => {
    // stackTraceLimit = 0 makes the guard emit an empty stack.
    const r = run("setInterval(() => {}, 5000); armExitGuard(300);");
    assert.match(r.report, /created at:\n\s+at /,
      `>> FAIL: exit guard: the creation stack must reach the report; got:\n${r.report}`);
    const blind = run("Error.stackTraceLimit = 0; setInterval(() => {}, 5000); armExitGuard(300);");
    assert.doesNotMatch(blind.report, /created at:\n\s+at /,
      ">> FAIL: exit guard: these tests cannot detect a missing creation stack");
  });

  test("names a leaked listening server with its port, and never reports our own stdio", () => {
    const r = run(`const net = await import("node:net");`
      + ` const srv = net.createServer(); srv.listen(0, "127.0.0.1", () => armExitGuard(300));`);
    assert.equal(r.status, NO_RETRY_EXIT_CODE, `>> FAIL: exit guard: a leaked server must exit ${NO_RETRY_EXIT_CODE}, got ${r.status}`);
    assert.match(r.report, /handle Server listening on 127\.0\.0\.1:\d+/,
      `>> FAIL: exit guard: a listening server must be named with its address and port; got:\n${r.report}`);
    // A piped stdio socket answers address() with {}, which read as a server.
    assert.doesNotMatch(r.report, /listening on undefined/,
      `>> FAIL: exit guard: our own stdio must not be reported as a listening server; got:\n${r.report}`);
    assert.doesNotMatch(r.report, /handle Socket\b/,
      `>> FAIL: exit guard: our own stdio sockets must be filtered out; got:\n${r.report}`);
  });

  test("names the host a leaked outbound socket connected to, not only its IP", () => {
    // Several hosts can share one IP, so the report must name the host.
    const r = run(`const net = await import("node:net");`
      + ` const srv = net.createServer();`
      + ` srv.listen(0, "127.0.0.1", () => {`
      + `   net.connect({ host: "localhost", port: srv.address().port, family: 4 }, () => armExitGuard(300));`
      + ` });`);
    assert.equal(r.status, NO_RETRY_EXIT_CODE, `>> FAIL: exit guard: a leaked socket must exit ${NO_RETRY_EXIT_CODE}, got ${r.status}`);
    assert.match(r.report, /handle Socket -> localhost 127\.0\.0\.1:\d+/,
      `>> FAIL: exit guard: a leaked outbound socket must be named with the host it dialled; got:\n${r.report}`);
  });

  test("a guard failure is not classified as a retryable flake", () => {
    // A deterministic leak must not be retried (#1393).
    const r = run(`process.stderr.write("Connection lost\\n"); setInterval(() => {}, 5000); armExitGuard(300);`);
    assert.equal(r.status, NO_RETRY_EXIT_CODE,
      `>> FAIL: exit guard: must exit ${NO_RETRY_EXIT_CODE}, the code the retry wrapper treats as fail-fast, got ${r.status}`);
  });
});
