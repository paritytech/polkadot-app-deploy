import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const GH_PAGES_MIRROR_MAX_BYTES = 100 * 1024 * 1024;
export const GH_PAGES_MIRROR_DIR = "bulletin";
export const GH_PAGES_MIRROR_BRANCH = "gh-pages";

export interface MirrorInput {
  domain: string;
  carBytes: Uint8Array;
  cid: string;
  toolVersion: string;
  bulletinRpc: string;
  encrypted: boolean;
  deployedAt?: string;
  sourceCommit?: string;
  sourceRepo?: string;
  repoPath?: string;
  githubToken?: string;
}

export interface MirrorResult {
  url: string;
  owner: string;
  repo: string;
  carPath: string;
  manifestPath: string;
}

export interface MirrorManifest {
  domain: string;
  cid: string;
  toolVersion: string;
  deployedAt: string;
  encrypted: boolean;
  bulletinRpc: string;
  sourceRepo?: string;
  sourceCommit?: string;
}

export class MirrorSkipped extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "MirrorSkipped";
  }
}

export interface FreshnessPollResult {
  verified: boolean;
  attempts: number;
  durationMs: number;
  lastCid: string | null;
  lastStatus: number;
}

/**
 * Poll the mirror's manifest URL until its `cid` field equals the expected
 * value. Pages is CDN-backed — a fresh commit may return HTTP 200 for
 * several seconds to a few minutes while Fastly still serves stale bytes,
 * so we can't just 200-check. Matching the manifest CID proves the edge
 * has picked up the current deploy; the sibling .car URL is then guaranteed
 * fresh for the same commit.
 *
 * Non-fatal to the deploy — returns `{ verified: false }` if the poll times
 * out so the caller can log a warning without aborting a deploy whose
 * on-chain state is already good.
 */
export async function pollMirrorFreshness(
  mirrorUrl: string,
  expectedCid: string,
  opts: { timeoutMs?: number; intervalMs?: number; fetchFn?: typeof fetch } = {},
): Promise<FreshnessPollResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 10_000;
  const fetchFn = opts.fetchFn ?? fetch;
  const manifestUrl = mirrorUrl.replace(/\.car$/, ".json");
  const started = Date.now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let lastCid: string | null = null;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const res = await fetchFn(manifestUrl, { redirect: "follow", cache: "no-store" });
      lastStatus = res.status;
      if (res.status === 200) {
        const m = await res.json() as { cid?: string };
        if (m.cid === expectedCid) {
          return { verified: true, attempts, durationMs: Date.now() - started, lastCid: m.cid, lastStatus };
        }
        lastCid = m.cid ?? null;
      }
    } catch {
      // swallow transient fetch errors; keep polling until the deadline
    }
    if (Date.now() + intervalMs >= deadline) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return { verified: false, attempts, durationMs: Date.now() - started, lastCid, lastStatus };
}

export function parseGitRemoteUrl(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const ssh = trimmed.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = trimmed.match(/^https?:\/\/(?:[^@]*@)?[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

export function resolveOwnerRepo(repoPath: string): { owner: string; repo: string } | null {
  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo && envRepo.includes("/")) {
    const [owner, repo] = envRepo.split("/");
    if (owner && repo) return { owner, repo };
  }
  try {
    const url = execSync("git config --get remote.origin.url", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return parseGitRemoteUrl(url);
  } catch {
    return null;
  }
}

export function resolveSourceCommit(repoPath: string): string | undefined {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoPath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

// "myapp.dot" or "myapp" → "myapp.dot"; guards the filename against directory
// traversal and ensures a consistent, human-typable name on disk.
export function normalizeDomainFilename(domain: string): string {
  const label = domain.endsWith(".dot") ? domain.slice(0, -4) : domain;
  if (!/^[a-z0-9-]+$/.test(label)) {
    throw new Error(`Invalid domain label for mirror filename: ${JSON.stringify(domain)}`);
  }
  return `${label}.dot`;
}

export function mirrorUrl(owner: string, repo: string, domainFilename: string): string {
  return `https://${owner}.github.io/${repo}/${GH_PAGES_MIRROR_DIR}/${domainFilename}.car`;
}

export function buildManifest(input: Omit<MirrorInput, "carBytes" | "repoPath" | "githubToken">): MirrorManifest {
  return {
    domain: normalizeDomainFilename(input.domain),
    cid: input.cid,
    toolVersion: input.toolVersion,
    deployedAt: input.deployedAt ?? new Date().toISOString(),
    encrypted: input.encrypted,
    bulletinRpc: input.bulletinRpc,
    sourceRepo: input.sourceRepo,
    sourceCommit: input.sourceCommit,
  };
}

function runGit(args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  return execSync(`git ${args.join(" ")}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  }).trim();
}

// Identity + signing config for the auto-bot commit on gh-pages. Author is
// explicitly bulletin-deploy@noreply (not a person), so signing the commit
// with the developer's GPG key would misrepresent authorship; force-disable
// signing here so a developer's `commit.gpgsign=true` global config doesn't
// trigger a pinentry prompt mid-deploy. Exported for unit tests.
export const MIRROR_BOT_GIT_OVERRIDES: readonly string[] = [
  "-c", "user.email=bulletin-deploy@noreply.github.com",
  "-c", "user.name=bulletin-deploy",
  "-c", "commit.gpgsign=false",
];

// Keep remote URLs token-free in logs and error messages; tokens otherwise
// leak into CI logs whenever git prints the remote on failure.
function pushRemoteUrl(owner: string, repo: string, token?: string): string {
  const authedOwner = token ? `x-access-token:${token}@github.com` : "github.com";
  return `https://${authedOwner}/${owner}/${repo}.git`;
}

export async function mirrorToGitHubPages(input: MirrorInput): Promise<MirrorResult> {
  const repoPath = input.repoPath ?? process.cwd();
  const ownerRepo = resolveOwnerRepo(repoPath);
  if (!ownerRepo) {
    throw new MirrorSkipped("no GitHub repo detected (GITHUB_REPOSITORY unset and no github.com remote)");
  }
  if (input.carBytes.length > GH_PAGES_MIRROR_MAX_BYTES) {
    const mb = (input.carBytes.length / 1024 / 1024).toFixed(1);
    // Check happens before any network call so we never push a file we
    // know GitHub will reject. Bigger apps simply don't get the Pages
    // speed-up and fall back to Bulletin / IPFS gateways. A GitHub
    // Releases fallback (2 GB ceiling) is tracked as a follow-up in the
    // gh-pages-mirror design doc.
    throw new MirrorSkipped(`CAR is ${mb} MB, exceeds GitHub's 100 MB single-file soft limit. Pages can't host this CAR — the on-chain deploy still succeeds and hosts will fall back to Bulletin.`);
  }

  const domainFilename = normalizeDomainFilename(input.domain);
  const { owner, repo } = ownerRepo;
  const sourceCommit = input.sourceCommit ?? resolveSourceCommit(repoPath);
  const sourceRepo = input.sourceRepo ?? `${owner}/${repo}`;
  const manifest = buildManifest({ ...input, sourceCommit, sourceRepo });

  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), "bulletin-mirror-"));
  const token = input.githubToken ?? process.env.GITHUB_TOKEN;

  try {
    // Fetch just the gh-pages ref if it exists, then lay down a worktree on it.
    // If it doesn't exist, we create an orphan branch inside the worktree so
    // the first deploy seeds a clean history (otherwise git worktree add with a
    // missing branch fails).
    let branchExists = false;
    try {
      execSync(`git ls-remote --exit-code --heads origin ${GH_PAGES_MIRROR_BRANCH}`, {
        cwd: repoPath,
        stdio: ["ignore", "ignore", "ignore"],
      });
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      // Update only the remote-tracking ref (`refs/remotes/origin/gh-pages`)
      // and check out a detached worktree from it. An explicit refspec like
      // `gh-pages:gh-pages` would try to update a local branch, which fails
      // with "non-fast-forward" as soon as anybody has checked out the
      // branch locally with divergent history (e.g. a prior smoke test).
      // Committing on a detached HEAD and pushing `HEAD:gh-pages` side-
      // steps that entirely — we never touch a local branch ref.
      runGit(["fetch", "origin", GH_PAGES_MIRROR_BRANCH, "--depth=1"], repoPath);
      runGit(["worktree", "add", "--detach", workTree, `origin/${GH_PAGES_MIRROR_BRANCH}`], repoPath);
    } else {
      runGit(["worktree", "add", "--detach", workTree, "HEAD"], repoPath);
      runGit(["checkout", "--orphan", GH_PAGES_MIRROR_BRANCH], workTree);
      runGit(["rm", "-rf", "--quiet", "."], workTree);
    }

    const mirrorDir = path.join(workTree, GH_PAGES_MIRROR_DIR);
    fs.mkdirSync(mirrorDir, { recursive: true });
    const carPath = path.join(mirrorDir, `${domainFilename}.car`);
    const manifestPath = path.join(mirrorDir, `${domainFilename}.json`);
    fs.writeFileSync(carPath, input.carBytes);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    runGit([...MIRROR_BOT_GIT_OVERRIDES, "add", GH_PAGES_MIRROR_DIR], workTree);
    const status = runGit(["status", "--porcelain"], workTree);
    if (status.length === 0) {
      // Identical content; skip empty commit but still report the URL.
      return {
        url: mirrorUrl(owner, repo, domainFilename),
        owner, repo,
        carPath: path.posix.join(GH_PAGES_MIRROR_DIR, `${domainFilename}.car`),
        manifestPath: path.posix.join(GH_PAGES_MIRROR_DIR, `${domainFilename}.json`),
      };
    }
    runGit(
      [
        ...MIRROR_BOT_GIT_OVERRIDES,
        "commit",
        "-m", `"mirror(bulletin): ${domainFilename} @ ${input.cid.slice(0, 12)}"`,
      ],
      workTree,
    );
    runGit(["push", pushRemoteUrl(owner, repo, token), `HEAD:${GH_PAGES_MIRROR_BRANCH}`], workTree);

    return {
      url: mirrorUrl(owner, repo, domainFilename),
      owner, repo,
      carPath: path.posix.join(GH_PAGES_MIRROR_DIR, `${domainFilename}.car`),
      manifestPath: path.posix.join(GH_PAGES_MIRROR_DIR, `${domainFilename}.json`),
    };
  } finally {
    try { runGit(["worktree", "remove", "--force", workTree], repoPath); } catch { /* best-effort */ }
    try { fs.rmSync(workTree, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
