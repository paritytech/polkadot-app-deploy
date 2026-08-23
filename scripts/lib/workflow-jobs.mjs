// scripts/lib/workflow-jobs.mjs
//
// Shared GitHub Actions workflow-YAML job-block parser. Used by
// scripts/e2e-ensure-authorized.mjs (to derive the E2E signer account list
// from e2e.yml's job bodies) and by test/test.js's jobBlock() helper (used
// across ~20 workflow-safety-net assertions). Treats the YAML as text
// (regex over indentation) rather than parsing it, which is enough for the
// narrow "slice out one job's body" job this needs to do.
//
// This module exists because the script and the test file used to each
// carry their own hand-rolled version of this parser, and they had already
// diverged: the script's job-header regex required a leading letter
// (`[A-Za-z][A-Za-z0-9_-]*`) while the test file's accepted any word
// character or hyphen (`[\w-]+`). A job name valid under one regex and not
// the other would silently drop that job's block from whichever parser used
// the narrower one — for the authorization script, that means silently
// omitting a job's derivation-path accounts from the derived signer list,
// which is the exact "list drift" failure mode this whole script exists to
// prevent (see e2e-ensure-authorized.mjs's own header). One canonical
// regex, one export, both call sites import it — see #893-class-adjacent
// /simplify finding (2026-08).

// Blanks every full-line YAML comment (a line whose trimmed content starts
// with `#`) so prose mentioning field names like "derivation-path" or
// "poolIndex" never gets mistaken for a real value. Line count is preserved
// (comments become empty lines) so nothing downstream needs to re-index.
export function stripYamlCommentLines(text) {
  return text.split("\n").map((line) => (line.trim().startsWith("#") ? "" : line)).join("\n");
}

// Splits the `jobs:` section of a workflow file into per-job text blocks,
// keyed by job name. Job headers are exactly 2-space-indented `name:` lines
// directly under `jobs:` — every nested key (name, needs, if, strategy,
// ...) is indented 4+ spaces, and the only other 2-space bare `key:` lines
// in a workflow file are the `on:` trigger names (pull_request, push, ...),
// which live before `jobs:` and are excluded by slicing from the `jobs:`
// line onward.
export function extractJobBlocks(workflowYamlText) {
  const jobsIdx = workflowYamlText.indexOf("\njobs:\n");
  if (jobsIdx === -1) {
    throw new Error(
      "workflow file: could not find a top-level 'jobs:' key on its own line — file shape changed, " +
      "extractJobBlocks needs updating before any caller can trust a derived job block.",
    );
  }
  const body = workflowYamlText.slice(jobsIdx + 1);
  const headerRe = /^ {2}([A-Za-z][A-Za-z0-9_-]*):[ \t]*$/gm;
  const headers = [];
  let m;
  while ((m = headerRe.exec(body))) headers.push({ name: m[1], start: m.index });
  const blocks = new Map();
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].start;
    const end = i + 1 < headers.length ? headers[i + 1].start : body.length;
    blocks.set(headers[i].name, body.slice(start, end));
  }
  return blocks;
}

// Convenience single-job lookup on top of extractJobBlocks, with a
// descriptive throw when the job isn't found — the shape test/test.js's
// jobBlock() wrapper and any other single-job caller wants.
export function getJobBlock(workflowYamlText, jobName) {
  const blocks = extractJobBlocks(workflowYamlText);
  if (!blocks.has(jobName)) {
    throw new Error(`workflow has no ${jobName} job`);
  }
  return blocks.get(jobName);
}
