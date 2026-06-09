import { execSync, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { VERSION } from "./telemetry.js";

const REGISTRY_URL = "https://registry.npmjs.org/polkadot-app-deploy/latest";
const FETCH_TIMEOUT = 3000;

interface VersionInfo {
  latest: string;
  minimumFromRegistry: string | null;
}

export function checkNodeVersion(enginesNode: string, currentVersion: string): string | null {
  const match = enginesNode.match(/(\d+)/);
  if (!match) return null;
  const required = parseInt(match[1], 10);
  const actual = parseInt(currentVersion.replace(/^v/, "").split(".")[0], 10);
  if (actual < required) {
    return `polkadot-app-deploy requires Node.js ${enginesNode} (running ${currentVersion}).\n       Download a supported version at https://nodejs.org/`;
  }
  return null;
}

export function compareSemver(a: string, b: string): number {
  // Separate the core version (x.y.z) from any pre-release suffix (-rc.0 etc).
  // Without this, "0.6.9-rc.0".split(".") produces ["0","6","9-rc","0"] and
  // Number("9-rc") is NaN (coerced to 0) — so 0.6.9-rc.0 compared LESS than
  // 0.6.8 and the deploy-failure path suggested a "downgrade" to stable.
  const [coreA, preA] = a.split("-", 2);
  const [coreB, preB] = b.split("-", 2);
  const pa = coreA.split(".").map(Number);
  const pb = coreB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
  }
  // Same core version: semver says pre-release is lower precedence than stable.
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  return 0;
}

// A semver is a pre-release if it carries an identifier after a hyphen
// (e.g. "0.6.9-rc.0", "1.0.0-beta.2"). Stable versions have no hyphen.
export function isPreReleaseVersion(version: string): boolean {
  return version.includes("-");
}

// Returns a warning banner for pre-release versions, or null for stable versions.
// The banner is printed at CLI startup to make it impossible to miss that an RC
// is running.
export function preReleaseWarning(version: string): string | null {
  if (!isPreReleaseVersion(version)) return null;
  return [
    "",
    `⚠️  Running polkadot-app-deploy ${version} (release candidate).`,
    "   This version is not recommended for production deploys.",
    "   For stable:  npm install -g polkadot-app-deploy@latest",
    "",
  ].join("\n");
}

async function fetchJson(url: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchVersionInfo(): Promise<VersionInfo | null> {
  const registry = await fetchJson(REGISTRY_URL);
  if (!registry) return null;
  return {
    latest: registry.version ?? VERSION,
    minimumFromRegistry: registry.minimumVersion ?? null,
  };
}

export function handlePreflightVersionCheck(info: VersionInfo | null): "abort" | "nudge" | "ok" {
  if (!info) return "ok";
  if (info.minimumFromRegistry && compareSemver(VERSION, info.minimumFromRegistry) < 0) {
    console.error(`\n   polkadot-app-deploy ${VERSION} is no longer supported (minimum: ${info.minimumFromRegistry}).`);
    console.error(`   Please update: npm install -g polkadot-app-deploy@latest\n`);
    return "abort";
  }
  if (compareSemver(VERSION, info.latest) < 0) {
    console.error(`\n   A newer version of polkadot-app-deploy is available (${VERSION} → ${info.latest}).`);
    console.error(`   Run: npm install -g polkadot-app-deploy@latest\n`);
    return "nudge";
  }
  return "ok";
}

export function isInternalUser(cwd?: string): boolean {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo?.startsWith("paritytech/")) return true;
  const opts = { encoding: "utf-8" as const, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"], ...(cwd ? { cwd } : {}) };
  try {
    const remote = execSync("git remote get-url origin", opts).trim();
    if (remote.includes("paritytech/")) return true;
  } catch {}
  try {
    const email = execSync("git config user.email", opts).trim();
    if (email.endsWith("@parity.io")) return true;
  } catch {}
  return false;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && !process.env.CI);
}

export async function promptYesNo(question: string, input?: Readable): Promise<boolean> {
  const stdin = input ?? process.stdin;
  if (!input && !process.stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: process.stderr });
  let answered = false;
  return new Promise((resolve) => {
    rl.on("close", () => {
      if (!answered) { answered = true; resolve(false); }
    });
    rl.question(question, (answer) => {
      if (answered) return;
      const a = answer.trim().toLowerCase();
      if (a === "" || a === "y" || a === "yes") {
        answered = true; rl.close(); resolve(true);
      } else if (a === "n" || a === "no") {
        answered = true; rl.close(); resolve(false);
      } else {
        rl.question("   Please answer Y or N: ", (retry) => {
          if (answered) return;
          const r = retry.trim().toLowerCase();
          answered = true; rl.close();
          resolve(r === "" || r === "y" || r === "yes");
        });
      }
    });
  });
}

function updateAndRetry(): void {
  console.error("\n   Updating polkadot-app-deploy...");
  try {
    execSync("npm install -g polkadot-app-deploy@latest", { stdio: "inherit" });
    console.error("   Updated. Retrying deploy...\n");
    execFileSync(process.argv[0], process.argv.slice(1), { stdio: "inherit" });
    process.exit(0);
  } catch {
    console.error("   Update failed. Please run: npm install -g polkadot-app-deploy@latest");
    process.exit(1);
  }
}

export function classifyErrorArea(msg: string): string | null {
  if (/personhood|owned by|owner mismatch|reserved for original|domain|dotns|commit-reveal/i.test(msg)) return "area:dotns";
  if (/chunk|storage|authorized|authorization|pool|alice/i.test(msg)) return "area:storage";
  if (/ipfs|cid|pin|dag/i.test(msg)) return "area:ipfs";
  if (/connect|timeout|websocket|rpc|ECONNREFUSED|ENOTFOUND/i.test(msg)) return "area:network";
  return null;
}

export type VersionVerdict =
  | { action: "forced_update"; currentVersion: string; minimumVersion: string }
  | { action: "suggest_update"; currentVersion: string; latestVersion: string; internal: boolean }
  | { action: "bug_report"; internal: boolean }
  | { action: "none" };

export function assessVersion(
  currentVersion: string,
  info: VersionInfo,
  internal: boolean,
): VersionVerdict {
  if (info.minimumFromRegistry && compareSemver(currentVersion, info.minimumFromRegistry) < 0) {
    return { action: "forced_update", currentVersion, minimumVersion: info.minimumFromRegistry };
  }

  if (compareSemver(currentVersion, info.latest) < 0) {
    return { action: "suggest_update", currentVersion, latestVersion: info.latest, internal };
  }

  if (internal) {
    return { action: "bug_report", internal: true };
  }

  return { action: "none" };
}

export async function handleFailedDeploy(error: Error): Promise<void> {
  if (process.env.PAD_UPDATE_CHECK === "0") return;

  const info = await fetchVersionInfo();
  if (!info) return;

  // Defer isInternalUser() — only needed for suggest_update and bug_report paths.
  // assessVersion with internal=false first to check forced_update (no git spawn needed).
  let verdict = assessVersion(VERSION, info, false);
  if (verdict.action === "suggest_update" || verdict.action === "none") {
    const internal = isInternalUser();
    if (internal) verdict = assessVersion(VERSION, info, true);
  }

  switch (verdict.action) {
    case "forced_update":
      console.error(`\n   polkadot-app-deploy ${verdict.currentVersion} is no longer supported (minimum: ${verdict.minimumVersion}).`);
      console.error(`   Please update: npm install -g polkadot-app-deploy@latest\n`);
      break;

    case "suggest_update":
      if (isInteractive()) {
        const yes = await promptYesNo(`\n   polkadot-app-deploy ${verdict.currentVersion} → ${verdict.latestVersion} available. Update and retry? [Y/n] `);
        if (yes) updateAndRetry();
        else console.error(`   Skipped. Run: npm install -g polkadot-app-deploy@latest\n`);
      } else {
        console.error(`\n   A newer version of polkadot-app-deploy is available (${verdict.currentVersion} → ${verdict.latestVersion}).`);
        console.error(`   Run: npm install -g polkadot-app-deploy@latest\n`);
      }
      break;

    case "bug_report": {
      const { offerBugReport } = await import("./bug-report.js");
      await offerBugReport(error);
      break;
    }
  }
}
