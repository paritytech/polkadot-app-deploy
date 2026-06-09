// test/helpers/e2e-failure.js
//
// Helpers that turn raw CLI failures (stdout/stderr, non-zero exits, regex
// misses) into structured, human-readable test failure messages of the form:
//
//   >> FAIL: <scenario>: <one-sentence cause>
//      expected ... / wrote ... / seen tail ...
//      hint: ...
//
// Used by test/e2e.test.js (sweep introduced in #529). See
// docs-internal/superpowers/specs/2026-05-22-e2e-error-messages-design.md
// for the rule the helper enforces.

/**
 * Substring → (class, summary) classification table for deploy-CLI stderr.
 * Ordering matters: the FIRST match wins, so list more-specific patterns first.
 * Patterns mirror the production telemetry classifier in src/telemetry.ts and
 * tools/release-retry-wrapper.mjs (when that file lands via #534).
 */
const FLAKE_PATTERNS = [
  { needle: "requires Node.js >=22", class: "node_version_drift", summary: "Runner has Node v18 in PATH — setup-node@v6 didn't take. parity-default runner env regression; rerun on a fresh runner." },
  { needle: "received a shutdown signal", class: "runner_shutdown", summary: "Runner process killed mid-job. Pure CI infra flake; rerun." },
  { needle: "Invalid: Stale", class: "nonce_stale", summary: "Asset Hub tx Invalid (Stale) — nonce race on shared signer account; usually clears on retry." },
  { needle: '"type": "Stale"', class: "nonce_stale", summary: 'Asset Hub tx Invalid/Stale (papi 2.x JSON format) — nonce race on shared signer account; usually clears on retry.' },
  { needle: "ChainHead disjointed", class: "chainhead_disjointed", summary: "Substrate RPC reorg / chain-head subscription dropped; usually clears on retry." },
  { needle: "max reconnections", class: "connection_lost", summary: "WS reconnect budget exhausted — chain RPC or Bulletin endpoint is flaky right now." },
  { needle: "Connection lost", class: "connection_lost", summary: "WS connection dropped mid-deploy; usually clears on retry." },
  { needle: "Account mapping did not take effect", class: "account_mapping_race", summary: "Revive auto-account-mapping tx didn't land before the next call; transient." },
  { needle: "fetchManifestRoundtrip failed", class: "gateway_timeout", summary: "IPFS gateway couldn't serve the deployed CID within budget. Often a Bulletin→IPFS bridge issue rather than gateway-down; check tools/.find-bulletin-chunk.mjs to confirm bytes are on chain." },
  { needle: "Contract execution would revert", class: "contract_revert", summary: "Revive dry-run rejected the call. Read the revert data — often a domain-state or PoP-status mismatch, not a flake." },
  { needle: "Contract reverted (flags=1)", class: "contract_revert", summary: "Revive call reverted on chain. flags=1 = execution revert; data field carries the selector." },
  { needle: "Not connected. Call connect() first", class: "post_disconnect_async_leak", summary: "Late async callback in bulletin-deploy fired a chain read after disconnect() returned. Observed in S-ext-signer's npm-install path when setContenthash actually broadcasts a tx (rather than taking the 'already set' fast-path). Almost always passes on retry. Suspected source: post-tx verification or WS subscription cleanup landing after the test exits. Follow-up investigation needed." },
];

/**
 * Classify a stderr blob into a known cause class with a one-sentence summary.
 *
 * @param {string} stderr
 * @returns {{ class: string, summary: string }}
 */
export function classifyDeployStderr(stderr) {
  const haystack = String(stderr ?? "");
  for (const { needle, class: cls, summary } of FLAKE_PATTERNS) {
    if (haystack.includes(needle)) return { class: cls, summary };
  }
  return {
    class: "unknown",
    summary: "Unrecognized failure — no known flake-class pattern matched. Read the stderr tail and consider whether to add this pattern to FLAKE_PATTERNS in test/helpers/e2e-failure.js.",
  };
}

/**
 * Pick the most-relevant lines from a stdout/stderr blob for failure context.
 *
 * Rules (in order):
 *   1. Drop blank or whitespace-only lines.
 *   2. Drop lines inside a banner block (between two lines matching
 *      /^[=]{8,}$/ or starting with "==========").
 *   3. If `keywords` is non-empty, return lines containing ANY keyword
 *      (case-insensitive substring match), up to `maxLines`. If none match,
 *      fall back to the last `maxLines` lines (post step 1/2).
 *
 * @param {string} text
 * @param {{ keywords?: string[], maxLines?: number }} options
 * @returns {string[]}
 */
export function pickContextLines(text, { keywords = [], maxLines = 8 } = {}) {
  if (!text) return [];
  const raw = String(text).split(/\r?\n/);

  // Pass 1: strip banner blocks. A banner line is one matching ^=+$ (≥8 =).
  // Toggle "in banner" on entering, off on exiting (banner blocks are paired).
  // If the text ends with an unclosed banner (odd number of separators), the
  // trailing block is treated as real content — flush the pending buffer.
  const stripped = [];
  let inBanner = false;
  let bannerBuffer = []; // lines collected while inBanner; flushed if banner never closes
  for (const line of raw) {
    const isSep = /^={8,}$/.test(line.trim());
    if (isSep) {
      if (!inBanner) {
        // Entering a banner — start collecting into the buffer.
        bannerBuffer = [];
        inBanner = true;
      } else {
        // Closing a banner — discard the buffered lines.
        bannerBuffer = [];
        inBanner = false;
      }
      continue;
    }
    if (inBanner) {
      if (line.trim() !== "") bannerBuffer.push(line);
      continue;
    }
    if (line.trim() === "") continue;
    stripped.push(line);
  }
  // If still inside a banner at EOF, the separator was unpaired — treat the
  // buffered lines as real content rather than silently dropping them.
  if (inBanner) stripped.push(...bannerBuffer);

  if (keywords.length > 0) {
    const lower = keywords.map((k) => k.toLowerCase());
    const hits = stripped.filter((l) =>
      lower.some((k) => l.toLowerCase().includes(k))
    );
    if (hits.length > 0) return hits.slice(-maxLines);
  }
  return stripped.slice(-maxLines);
}

/**
 * Internal: format a multi-line failure block.
 *
 * @param {string} headline — the "S-X: cause" part after ">> FAIL: ".
 * @param {string[]} sections — extra indented lines (already formatted).
 * @returns {string}
 */
function formatBlock(headline, sections) {
  const lines = [`>> FAIL: ${headline}`, ...sections.filter(Boolean)];
  return lines.join("\n");
}

/**
 * Internal: format the "seen tail" indented section. Returns "" (empty) when
 * there's nothing meaningful to show; `formatBlock`'s sections.filter(Boolean)
 * then drops the whole section rather than emitting a placeholder line.
 */
function formatSeenTail(context, keywords) {
  const lines = pickContextLines(context, { keywords, maxLines: 8 });
  if (lines.length === 0) return "";
  return ["   seen tail:", ...lines.map((l) => `     ${l.trim()}`)].join("\n");
}

/**
 * Asserts the CLI run succeeded. On failure, throws a structured Error.
 *
 * @param {{ code: number, stdout: string, stderr: string }} result
 * @param {{ scenario: string, step?: string }} ctx
 */
export function assertDeploySucceeded(result, { scenario, step = "deploy" }) {
  if (result.code === 0) return;
  const { class: cls, summary } = classifyDeployStderr(result.stderr);
  const headline = `${scenario} ${step}: ${cls} (exit ${result.code})`;
  const sections = [
    `   ${summary}`,
    formatSeenTail(result.stderr, ["Error", "Stale", "ChainHead", "Connection", "mapping", "revert", "shutdown", "Node.js"]),
  ];
  throw new Error(formatBlock(headline, sections));
}

/**
 * Asserts a stdout blob matches a pattern. On miss, throws a structured Error.
 *
 * @param {string} stdout
 * @param {RegExp} pattern
 * @param {{ scenario: string, what: string, hint?: string }} ctx
 */
export function assertStdoutMatches(stdout, pattern, { scenario, what, hint }) {
  if (pattern.test(String(stdout ?? ""))) return;
  const headline = `${scenario}: ${what}`;
  const keywords = extractKeywords(pattern);
  const sections = [
    `   expected stdout line matching ${pattern}`,
    formatSeenTail(stdout, keywords),
    hint ? `   hint: ${hint}` : "",
  ];
  throw new Error(formatBlock(headline, sections));
}

/**
 * Run a regex against text; return the match on hit, throw structured on miss.
 * Replaces the inline `parseDeployedCid` / `parseChunkSkipRateFromOutput` /
 * `parseMirrorUrl` pattern in test/e2e.test.js.
 *
 * @param {string} text
 * @param {{ pattern: RegExp, scenario: string, what: string, hint?: string }} ctx
 * @returns {RegExpMatchArray}
 */
export function parseLineOrExplain(text, { pattern, scenario, what, hint }) {
  const m = String(text ?? "").match(pattern);
  if (m) return m;
  const headline = `${scenario}: ${what}`;
  const keywords = extractKeywords(pattern);
  const sections = [
    `   pattern ${pattern} did not match`,
    formatSeenTail(text, keywords),
    hint ? `   hint: ${hint}` : "",
  ];
  throw new Error(formatBlock(headline, sections));
}

/**
 * Asserts an on-chain value matches what the CLI wrote. Throws structured on differ.
 *
 * @param {string} actual — what the chain holds now
 * @param {string} expected — what the CLI wrote / what we asked for
 * @param {{ scenario: string, label: string }} ctx
 */
export function assertOnChainMatches(actual, expected, { scenario, label }) {
  if (actual === expected) return;
  const headline = `${scenario}: on-chain contenthash mismatch on ${label}.dot`;
  const sections = [
    `   wrote:  ${expected}`,
    `   chain:  ${actual}`,
    `   likely cause: setContenthash silently failed, or a concurrent writer overrode the value.`,
  ];
  throw new Error(formatBlock(headline, sections));
}

/**
 * Throw a structured failure for an in-test custom check that doesn't fit the
 * named asserts above (e.g. "chunk-skip rate < 60 %").
 *
 * @param {{ scenario: string, message: string, context?: string, keywords?: string[], hint?: string }} args
 */
export function failWith({ scenario, message, context = "", keywords = [], hint }) {
  const headline = `${scenario}: ${message}`;
  const sections = [
    context ? formatSeenTail(context, keywords) : "",
    hint ? `   hint: ${hint}` : "",
  ];
  throw new Error(formatBlock(headline, sections));
}

/**
 * Internal: extract a few alpha tokens from a regex source for use as
 * keywords in pickContextLines. e.g. /Probed:\s+\d+ chunks/ → ["Probed", "chunks"].
 */
function extractKeywords(pattern) {
  const src = pattern.source;
  const tokens = src.match(/[A-Za-z]{4,}/g) ?? [];
  return tokens.slice(0, 3);
}
