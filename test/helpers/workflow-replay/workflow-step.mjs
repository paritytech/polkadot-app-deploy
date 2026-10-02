// Replays one step of a GitHub workflow: extracts its `run: |` block (and
// `if:`/`env:` text, plus the enclosing job's `env:`) by step name,
// substitutes `${{ expr }}` from a map, and runs it under bash with
// curl-stub.cjs first on PATH as `curl`.
// Plain line scanning, no YAML dependency: the workflows in this repo use a
// consistent "- name:" / "run: |" block layout, and the scanner throws when a
// step does not fit it rather than guessing.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const indent = (l) => l.match(/^ */)[0].length;
const blank = (l) => l.trim() === "";

const cache = new Map();
const readLines = (p) => {
  if (!cache.has(p)) cache.set(p, fs.readFileSync(p, "utf8").split("\n"));
  return cache.get(p);
};

// The key's block among lines[from, to): the key sits at exactly `keyIndent`;
// its body is every following blank line or line indented deeper than it.
function keyBlock(lines, from, to, keyIndent, key) {
  const i = lines.slice(from, to).findIndex((l) => indent(l) === keyIndent && l.trimStart().startsWith(`${key}:`));
  if (i < 0) return null;
  const at = from + i;
  const inline = lines[at].trim().slice(key.length + 1).trim();
  let end = at + 1;
  while (end < to && (blank(lines[end]) || indent(lines[end]) > keyIndent)) end++;
  return { inline, lines: lines.slice(at + 1, end) };
}

const envMap = (b) => {
  const env = {};
  for (const l of b ? b.lines : []) {
    const m = l.trim().match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
};

// The job's own line range: header `  <id>:` (indent 2) to the next indent-2 line.
function jobRange(lines, jobId) {
  const start = lines.findIndex((l) => l === `  ${jobId}:`);
  if (start < 0) throw new Error(`job not found: ${jobId}`);
  let end = start + 1;
  while (end < lines.length && (blank(lines[end]) || indent(lines[end]) > 2)) end++;
  return { start, end };
}

export function extractStep(workflowPath, stepName) {
  const lines = readLines(workflowPath);
  const hits = lines.flatMap((l, i) => (l.trim() === `- name: ${stepName}` ? [i] : []));
  if (hits.length !== 1) throw new Error(`expected exactly one step named "${stepName}", found ${hits.length}`);
  const start = hits[0];
  const d = indent(lines[start]);
  const k = d + 2; // the step's own keys sit two columns right of its "- "
  let end = start + 1;
  while (end < lines.length && (blank(lines[end]) || indent(lines[end]) > d)) end++;

  const run = keyBlock(lines, start + 1, end, k, "run");
  if (!run || run.inline !== "|") throw new Error(`step "${stepName}": expected a \`run: |\` block`);
  const first = run.lines.find((l) => !blank(l));
  const depth = first === undefined ? 0 : indent(first); // YAML: the first non-blank line sets the block indent
  const runText = run.lines.map((l) => l.slice(depth)).join("\n");

  const ifb = keyBlock(lines, start + 1, end, k, "if");
  const ifText = ifb ? [ifb.inline, ...ifb.lines.map((l) => l.trim())].filter((x) => x && !/^>[-+]?$/.test(x)).join(" ") : "";
  const env = envMap(keyBlock(lines, start + 1, end, k, "env"));

  // The enclosing job: nearest job header (indent 2) above the step.
  let h = start;
  while (h >= 0 && !(indent(lines[h]) === 2 && /^ {2}[\w-]+:\s*$/.test(lines[h]))) h--;
  if (h < 0) throw new Error(`step "${stepName}": no enclosing job header`);
  const stepsAt = lines.findIndex((l, i) => i > h && l === "    steps:");
  const jobEnv = envMap(keyBlock(lines, h + 1, stepsAt < 0 ? start : stepsAt, 4, "env"));
  return { run: runText, if: ifText, env, jobEnv };
}

// The job's `needs: [a, b]` as an array.
export function jobNeeds(workflowPath, jobId) {
  const lines = readLines(workflowPath);
  const { start, end } = jobRange(lines, jobId);
  const b = keyBlock(lines, start + 1, end, 4, "needs");
  const m = b && b.inline.match(/^\[(.*)\]$/);
  if (!m) throw new Error(`job ${jobId}: expected an inline \`needs: [...]\` list`);
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

export function substitute(text, exprs) {
  return text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => {
    if (!(e in exprs)) throw new Error(`no value for \${{ ${e} }}`);
    return exprs[e];
  });
}

// Runs fn(dir) with a fresh scratch directory that is always removed.
export function withScratch(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Runs the step; returns { status, stdout, stderr, calls, summary } where calls
// are the curl invocations (parsed from CURL_LOG) and summary is what the step
// wrote to $GITHUB_STEP_SUMMARY.
export function runStep(step, { exprs = {}, env = {}, rules = [] } = {}) {
  return withScratch("formal-ci-step-", (dir) => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.symlinkSync(path.join(here, "curl-stub.cjs"), path.join(bin, "curl"));
    const rulesFile = path.join(dir, "rules.json");
    fs.writeFileSync(rulesFile, JSON.stringify(rules));
    const log = path.join(dir, "curl.log");
    fs.writeFileSync(log, "");
    const summaryFile = path.join(dir, "summary.md");
    fs.writeFileSync(summaryFile, "");
    const resolvedEnv = {};
    for (const [k, v] of Object.entries({ ...step.jobEnv, ...step.env })) resolvedEnv[k] = substitute(v, exprs);
    // Steps scribble on /tmp/<name> (runner-local scratch); point those path
    // tokens at this replay's own directory so replays never share files or
    // need /tmp. The marker keeps the check below independent of where os.tmpdir() lives.
    const MARK = "@@SCRATCH@@/";
    const script = substitute(step.run, exprs).replace(/(?<![\w.:/-])\/tmp\//g, MARK);
    if (script.includes("/tmp/")) throw new Error("step still references /tmp/ after the rewrite; extend the rewrite");
    const r = spawnSync("bash", ["-e", "-c", script.replaceAll(MARK, `${dir}/`)], {
      encoding: "utf8",
      cwd: dir,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: process.env.HOME,
        CURL_LOG: log,
        CURL_RULES: rulesFile,
        GITHUB_STEP_SUMMARY: summaryFile,
        ...resolvedEnv,
        ...env,
      },
    });
    const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, summary: fs.readFileSync(summaryFile, "utf8") };
  });
}
