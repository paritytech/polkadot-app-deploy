import { execSync, execFileSync } from "node:child_process";
import * as os from "node:os";
import pkg from "../package.json";
import { VERSION, getCurrentSentryTraceId, resolveIssueRepoSlug } from "./telemetry.js";
import { classifyErrorArea, isInteractive, promptYesNo } from "./version-check.js";

const ISSUE_REPO = resolveIssueRepoSlug(pkg.repository);

interface DeployContext {
  domain?: string;
  repo?: string;
  branch?: string;
  signerMode?: string;
  chunkCount?: number;
  totalSize?: string;
  rpc?: string;
  deployTag?: string;
  cliFlags?: string;
  ci?: { runUrl?: string; workflow?: string; job?: string; sha?: string };
}

let _deployContext: DeployContext = {};

export function setDeployContext(ctx: Partial<DeployContext>): void {
  _deployContext = { ..._deployContext, ...ctx };
}

function hasGhCli(): boolean {
  try {
    execSync("gh --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const LOG_TAIL_BYTES = 32 * 1024;
let _logBuffer = "";
let _logCaptureInstalled = false;

// Ring-buffer wrapper around console.log/error/warn so the bug-report body can
// include the last ~32KB of output. Install once at CLI entry. Idempotent.
export function installLogCapture(): void {
  if (_logCaptureInstalled) return;
  _logCaptureInstalled = true;
  const append = (args: unknown[]): void => {
    const line = args.map((a) => typeof a === "string" ? a : safeStringify(a)).join(" ") + "\n";
    _logBuffer += line;
    if (_logBuffer.length > LOG_TAIL_BYTES * 2) {
      _logBuffer = _logBuffer.slice(_logBuffer.length - LOG_TAIL_BYTES);
    }
  };
  const wrap = <K extends "log" | "error" | "warn">(key: K): void => {
    const orig = console[key].bind(console);
    console[key] = (...a: unknown[]): void => { append(a); orig(...a); };
  };
  wrap("log");
  wrap("error");
  wrap("warn");
}

function safeStringify(v: unknown): string {
  try {
    if (v instanceof Error) return v.stack || v.message;
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Tail of captured output, scrubbed and truncated. Empty string if nothing
// captured (e.g. capture never installed, or deploy produced no logs).
export function getCapturedTail(): string {
  if (!_logBuffer) return "";
  const tail = _logBuffer.length > LOG_TAIL_BYTES
    ? "… [truncated]\n" + _logBuffer.slice(_logBuffer.length - LOG_TAIL_BYTES)
    : _logBuffer;
  return scrubSecrets(tail);
}

// Redact values that could be secrets before embedding in a public issue.
// Parity-internal users still file on a public repo; a pasted mnemonic is
// unrecoverable once indexed.
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  // --mnemonic "word word ..." / --mnemonic word-word-word (next arg)
  out = out.replace(/(--mnemonic(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, "$1<REDACTED>");
  // --password "..." — same shape, different flag
  out = out.replace(/(--password(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, "$1<REDACTED>");
  // MNEMONIC=... / PASSWORD=... env-var dumps (quoted or bare)
  out = out.replace(/\b(MNEMONIC|PASSWORD|BULLETIN_MNEMONIC|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|SENTRY_AUTH_TOKEN)=([^\s]+)/gi, "$1=<REDACTED>");
  // GitHub PATs: classic ghp_*, app ghs_*, fine-grained github_pat_*
  out = out.replace(/\b(ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{20,}\b/g, "<REDACTED_TOKEN>");
  out = out.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<REDACTED_TOKEN>");
  // BIP-39-style mnemonic runs: 12 or 24 lowercase words in a row. Catches
  // pastes that don't go through a flag (e.g. user echoing their env).
  out = out.replace(/\b(?:[a-z]{3,10}\s+){11}[a-z]{3,10}\b/g, "<REDACTED_MNEMONIC>");
  // basic-auth creds baked into URLs: scheme://user:pass@host
  out = out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^:@\s]+:[^@\s]+@/gi, "$1<REDACTED>@");
  return out;
}

// Summarise which flags were passed without ever leaking their values.
// Presence-only for --mnemonic/--password/--derivation-path/--rpc; values
// for safe flags (--pool-size, --tag, --js-merkle, --gh-pages-mirror).
export function buildCliFlagsSummary(flags: Record<string, unknown>): string {
  const parts: string[] = [];
  if (flags.jsMerkle) parts.push("--js-merkle");
  if (flags.ghPagesMirror) parts.push("--gh-pages-mirror");
  if (flags.publish) parts.push("--publish");
  if (flags.unpublish) parts.push("--unpublish");
  if (flags.failOnPublishError) parts.push("--fail-on-publish-error");
  if (flags.poolSize != null) parts.push(`--pool-size ${String(flags.poolSize)}`);
  if (typeof flags.tag === "string" && flags.tag) parts.push(`--tag ${flags.tag}`);
  if (flags.mnemonic) parts.push("--mnemonic <set>");
  if (flags.password) parts.push("--password <set>");
  if (flags.derivationPath) parts.push("--derivation-path <set>");
  if (typeof flags.rpc === "string" && flags.rpc) parts.push("--rpc <set>");
  return parts.join(" ");
}

export function buildReportBody(error: Error): string {
  const lines = [
    "## Environment",
    "",
    `- **polkadot-app-deploy**: ${VERSION}`,
    `- **Node.js**: ${process.version}`,
    `- **OS**: ${os.platform()} ${os.arch()} ${os.release()}`,
    "",
    "## Error",
    "",
    "```",
    scrubSecrets(error.stack || error.message),
    "```",
    "",
  ];

  const ctx = _deployContext;
  const traceId = getCurrentSentryTraceId();
  const hasCtx = ctx.domain || ctx.repo || ctx.rpc || ctx.cliFlags || ctx.ci?.runUrl || traceId;
  if (hasCtx) {
    lines.push("## Deploy Context", "");
    if (ctx.domain) lines.push(`- **Domain**: ${ctx.domain}`);
    if (ctx.repo) lines.push(`- **Repo**: ${ctx.repo}`);
    if (ctx.branch) lines.push(`- **Branch**: ${ctx.branch}`);
    if (ctx.signerMode) lines.push(`- **Signer mode**: ${ctx.signerMode}`);
    if (ctx.chunkCount != null) lines.push(`- **Chunks**: ${ctx.chunkCount}`);
    if (ctx.totalSize) lines.push(`- **Total size**: ${ctx.totalSize}`);
    if (ctx.rpc) lines.push(`- **RPC**: ${ctx.rpc}`);
    if (ctx.deployTag) lines.push(`- **Deploy tag**: ${ctx.deployTag}`);
    if (ctx.cliFlags) lines.push(`- **CLI flags**: \`${ctx.cliFlags}\``);
    if (traceId) lines.push(`- **Sentry trace**: ${traceId}`);
    lines.push("");
  }

  if (ctx.ci?.runUrl) {
    lines.push("## CI", "");
    lines.push(`- **Run**: ${ctx.ci.runUrl}`);
    if (ctx.ci.workflow) lines.push(`- **Workflow**: ${ctx.ci.workflow}`);
    if (ctx.ci.job) lines.push(`- **Job**: ${ctx.ci.job}`);
    if (ctx.ci.sha) lines.push(`- **SHA**: ${ctx.ci.sha}`);
    lines.push("");
  }

  const tail = getCapturedTail();
  if (tail) {
    lines.push("## Log tail", "", "<details><summary>Last ~32 KB of stdout/stderr (secrets scrubbed)</summary>", "", "```", tail.trimEnd(), "```", "", "</details>", "");
  }

  return lines.join("\n");
}

export function buildTitle(error: Error): string {
  const msg = error.message.slice(0, 60);
  return `[deploy-bug] ${msg}`;
}

export function buildLabels(error: Error): string[] {
  const labels = ["bug", "auto-report"];
  const area = classifyErrorArea(error.message);
  if (area) labels.push(area);
  return labels;
}

// gh issue create prints the new issue URL on stdout. Capture it so we can
// apply labels as a follow-up step if the labeled-create failed.
export function createGhIssue(title: string, body: string, labels: string[]): string {
  const args = [
    "issue", "create",
    "--repo", ISSUE_REPO,
    "--title", title,
    ...labels.flatMap((l) => ["--label", l]),
    "--body-file", "-",
  ];
  const out = execFileSync("gh", args, { input: body, stdio: ["pipe", "pipe", "inherit"] });
  return out.toString("utf8").trim();
}

// Best-effort: apply `bug` + `auto-report` to an issue that was created
// without labels. Never throws — the fallback issue already exists, this is
// just to keep dashboards sortable.
function applyCoreLabels(issueUrl: string): boolean {
  try {
    execFileSync(
      "gh",
      ["issue", "edit", issueUrl, "--add-label", "bug", "--add-label", "auto-report"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * True for deploy failures caused by user input rather than a code defect, so
 * the bug-report prompt is NOT offered for them (#63). Scoped to DotNS name
 * validation: a malformed or reserved label ("Invalid domain label …",
 * "… reserves base names of N chars …") is something the user fixes by choosing
 * a different name — filing it as a bug just creates noise. The actionable error
 * message has already been printed to the user. Exported for unit testing.
 */
export function isUserInputError(error: Error): boolean {
  const msg = error?.message ?? "";
  return /Invalid domain label|reserves base names of/i.test(msg);
}

export async function offerBugReport(error: Error): Promise<void> {
  if (!isInteractive()) return;
  // #63: user-input errors (e.g. an invalid/reserved DotNS label) are not bugs —
  // don't offer to file one. The actionable guidance was already printed.
  if (isUserInputError(error)) return;

  const yes = await promptYesNo("\n   This looks like a bug. Open an issue with debug info? [Y/n] ");
  if (!yes) return;

  const title = buildTitle(error);
  const body = buildReportBody(error);
  const labels = buildLabels(error);

  if (!hasGhCli()) {
    console.error("\n   gh CLI not found. Debug info below — paste into a new issue:\n");
    console.error(`   https://github.com/${ISSUE_REPO}/issues/new\n`);
    printFallback(title, body, labels);
    return;
  }

  try {
    const url = createGhIssue(title, body, labels);
    console.error(`   Issue created: ${url}`);
    return;
  } catch {
    // First attempt failed — retry without labels so at least the issue lands.
  }

  try {
    console.error("   Retrying without labels...");
    const url = createGhIssue(title, body, []);
    const applied = applyCoreLabels(url);
    if (applied) {
      console.error(`   Issue created: ${url} (labels applied after retry)`);
    } else {
      console.error(`   Issue created: ${url} (labels could not be applied; please add 'bug' and 'auto-report' manually)`);
    }
  } catch {
    console.error("   Failed to create issue. Debug info below:\n");
    printFallback(title, body, labels);
  }
}

function printFallback(title: string, body: string, labels: string[]): void {
  console.error(`   Title: ${title}`);
  console.error(`   Labels: ${labels.join(", ")}\n`);
  console.error(body);
}
