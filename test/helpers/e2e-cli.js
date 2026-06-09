import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const CLI_PATH = path.resolve(process.cwd(), "bin/polkadot-app-deploy");

// Per-run forensic log so --quiet mode still leaves a trail when a leg fails.
// Path: e2e-reports/<scenario>-<signer>-<merkle>.log (mirrors the JUnit XML).
// Returns null in non-driver contexts (scenario/signer/merkle env unset).
function openLog() {
  const scenario = process.env.E2E_SCENARIO;
  const signer = process.env.E2E_SIGNER;
  const merkle = process.env.E2E_MERKLE;
  if (!scenario || !signer || !merkle) return null;
  const dir = path.resolve(process.cwd(), "e2e-reports");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${scenario}-${signer}-${merkle}.log`);
  const stream = fs.createWriteStream(logPath, { flags: "w" });
  return { stream, path: logPath };
}

export function runBulletinDeploy({ args = [], env = {}, timeoutMs = 15 * 60 * 1000 } = {}) {
  const quiet = process.env.E2E_QUIET === "1";
  const log = openLog();
  return new Promise((resolve) => {
    if (log) {
      log.stream.write(`$ polkadot-app-deploy ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(" ")}\n`);
      log.stream.write(`# started: ${new Date().toISOString()}\n`);
    }
    const started = Date.now();
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      if (log) log.stream.write(s);
      if (!quiet) process.stdout.write(s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      if (log) log.stream.write(s);
      if (!quiet) process.stderr.write(s);
    });

    const term = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const kill = setTimeout(() => child.kill("SIGKILL"), timeoutMs + 5_000);

    child.on("close", (code, signal) => {
      clearTimeout(term);
      clearTimeout(kill);
      const exit = code ?? (signal ? 128 : 1);
      if (log) {
        log.stream.write(`# exit: ${exit} (signal=${signal ?? "none"})  durationMs=${Date.now() - started}\n`);
        log.stream.end();
      }
      resolve({ code: exit, stdout, stderr, durationMs: Date.now() - started, logPath: log?.path ?? null });
    });
  });
}
