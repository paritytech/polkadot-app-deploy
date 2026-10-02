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
export const FLAKE_PATTERNS = [
  { needle: "requires Node.js >=22", class: "node_version_drift", summary: "Runner has Node v18 in PATH — setup-node@v6 didn't take. parity-default runner env regression; rerun on a fresh runner." },
  { needle: "received a shutdown signal", class: "runner_shutdown", summary: "Runner process killed mid-job. Pure CI infra flake; rerun." },
  { needle: "Invalid: Stale", class: "nonce_stale", summary: "Asset Hub tx Invalid (Stale) — nonce race on shared signer account; usually clears on retry." },
  { needle: '"type": "Stale"', class: "nonce_stale", summary: 'Asset Hub tx Invalid/Stale (papi 2.x JSON format) — nonce race on shared signer account; usually clears on retry.' },
  { needle: "ChainHead disjointed", class: "chainhead_disjointed", summary: "Substrate RPC reorg / chain-head subscription dropped; usually clears on retry." },
  { needle: "max reconnections", class: "connection_lost", summary: "WS reconnect budget exhausted — chain RPC or Bulletin endpoint is flaky right now." },
  { needle: "Connection lost", class: "connection_lost", summary: "WS connection dropped mid-deploy; usually clears on retry." },
  { needle: "Account auto-mapping did not take effect", class: "account_mapping_race", summary: "Revive auto-account-mapping tx didn't land before the next call; transient." },
  { needle: "fetchManifestRoundtrip failed", class: "gateway_timeout", summary: "IPFS gateway couldn't serve the deployed CID within budget. Often a Bulletin→IPFS bridge issue rather than gateway-down; check tools/.find-bulletin-chunk.mjs to confirm bytes are on chain." },
  { needle: "Contract execution would revert", class: "contract_revert", summary: "Revive dry-run rejected the call. Read the revert data — often a domain-state or PoP-status mismatch, not a flake." },
  { needle: "Contract reverted (flags=1)", class: "contract_revert", summary: "Revive call reverted on chain. flags=1 = execution revert; data field carries the selector." },
  { needle: "Code presence at this address could not be verified", class: "code_presence_unverifiable", summary: "The runtime code-presence query at a DotNS contract address failed, so a missing contract and a live one are indistinguishable. Transient RPC; release-retry-wrapper retries it." },
  { needle: "All promises were rejected", class: "all_endpoints_failed", summary: "Promise.any exhausted: every RPC endpoint failed the nonce lookup (WS error/timeout) in the same window; transient network, passes on retry (#1627)." },
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
  if (result.code === 0) {
    // A Kubo leg that fell back to JS exits 0 but no longer tests Kubo.
    if (process.env.E2E_MERKLE === "kubo") {
      const out = String(result.stdout ?? "");
      if (/Kubo merkleize failed/.test(String(result.stderr ?? ""))) {
        throw new Error(formatBlock(`${scenario} ${step}: Kubo leg fell back to the JS merkleizer`, [formatSeenTail(result.stderr, ["Kubo"])]));
      }
      // Without ipfs on PATH the Kubo branch is never entered, so there is no
      // fallback line to find and the leg would pass having run JS.
      if (!/Merkleizing \(Kubo/.test(out)) {
        throw new Error(formatBlock(`${scenario} ${step}: Kubo leg never ran the Kubo merkleizer`, [formatSeenTail(out, ["Merkleizing"])]));
      }
    }
    return;
  }
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
  const headline = `${scenario}: on-chain contenthash mismatch on ${label}`;
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

/**
 * Classify an owned-label scenario's output to tell FIXTURE DRIFT apart from a
 * product regression.
 *
 * Both surface identically at the exit-code level ("expected 78, got 0"), but
 * they demand opposite responses: drift needs a fixture re-registration, a
 * regression needs a code fix. Reporting only the exit code is what let a
 * scenario like this sit red for a week in practice — it read like a product
 * bug, so it was repeatedly dismissed.
 *
 * Drift has two shapes after a testnet re-genesis:
 *   1. `missing`  — the registration was wiped; the CLI reports the label as
 *                   available and happily deploys.
 *   2. `drifted`  — a later run found it free and the deploy signer registered
 *                   it to ITSELF, so it is owned, just by the wrong account.
 *
 * The ownership line ("Domain <label>.<tld> is already owned by 0x...") decides.
 * Without it, only the domain's own "<label>.<tld> is available" line means
 * missing. The bare words "is available" also appear in the update notice
 * ("A newer version of ... is available") — see bulletin #1398/#1333.
 *
 * @param {object} o
 * @param {string} o.output          combined stdout+stderr from the deploy
 * @param {string} o.expectedOwner   0x-prefixed H160 the fixture must belong to
 * @param {string} [o.label]         full domain, e.g. "e2eownedns03.paseo"; anchors the availability match
 * @returns {{kind: "missing"|"drifted"|"ok", owner: string|null}}
 */
export function classifyFixtureState({ output, expectedOwner, label }) {
  const want = String(expectedOwner).toLowerCase();
  const text = String(output ?? "");
  const owned = text.match(/is already owned by (0x[0-9a-fA-F]{40})/);
  if (owned) {
    return owned[1].toLowerCase() === want
      ? { kind: "ok", owner: owned[1] }
      : { kind: "drifted", owner: owned[1] };
  }
  const subject = label ? escapeRegExp(String(label)) : "[A-Za-z0-9-]+\\.[A-Za-z0-9.-]+";
  if (new RegExp(`(?:^|\\s)${subject} is available\\b`, "i").test(text)) return { kind: "missing", owner: null };
  return { kind: "ok", owner: null };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The fix for a fixture held by `owner`. This repo ships no
 * fixture-registration tool (unlike bulletin-deploy's
 * `tools/register-test-fixture.mjs`), so every remedy here is an admin
 * action rather than a script to run — but the three-way distinction still
 * matters: unowned and funder-held are both repairable by an admin transfer,
 * while third-party-held is not repairable at all (nobody can seize it), so
 * the honest remedy is a fresh fixture label.
 */
export function fixtureRemedy({ label, envLabel, expectedOwner, owner, funder }) {
  if (!owner) {
    return {
      fix: `ask the chain admin to register ${label} to ${expectedOwner} on env "${envLabel}"`,
      hint: `the name is unowned — likely a registry reset from a DotNS redeploy. This repo ships no fixture-registration tool, so the registration needs to be done manually. Rerun the scenario after.`,
    };
  }
  if (funder && owner.toLowerCase() === String(funder).toLowerCase()) {
    return {
      fix: `ask the chain admin to transfer ${label} from the funder (${owner}) to ${expectedOwner} on env "${envLabel}"`,
      hint: `${owner} is the funder — likely an earlier drifted run registered it to itself. This repo ships no fixture-registration tool, so the transfer needs to be done manually. Rerun the scenario after.`,
    };
  }
  return {
    fix: `pick a different fixture label on env "${envLabel}"`,
    hint: `${owner} is neither ${expectedOwner} nor the funder${funder ? ` (${funder})` : ""} — a third party holds this name and it cannot be seized.`,
  };
}

/**
 * Fixture-presence PRECHECK (bulletin #1378/#1341): verify a pre-provisioned
 * E2E fixture is owned by the expected third party BEFORE the scenario runs
 * its main assertion, from a direct on-chain `ownerOf` read (e.g. via the
 * DotNS client's `checkOwnership(label, expectedOwner)`) — not inferred after
 * the fact from CLI text the way `assertFixtureNotDrifted` below does. The
 * two helpers are complementary: this one stops the scenario early with a
 * clear diagnosis; `assertFixtureNotDrifted` stays as a belt-and-suspenders
 * check on the deploy's own output, in case the fixture drifts in the window
 * between this precheck and the deploy actually running.
 *
 * Distinguishes three states:
 *   - owned by `expectedOwner`   — returns normally, scenario proceeds.
 *   - unowned (`owner === null`) — throws: the registry was almost certainly
 *     reset (a DotNS redeploy wipes registrations; CREATE3 keeps every
 *     contract address identical, so nothing else signals the reset).
 *   - owned by a third address   — throws: names who actually holds it.
 *
 * Fails LOUDLY rather than skipping. A silently-skipped scenario produces a
 * green nightly that tested nothing — the same failure class #1367/#1331
 * exist to catch. An actionable failure costs a moment of operator
 * attention; a silent skip costs a false sense of coverage.
 *
 * Takes the ownership result rather than a live client so it can be unit
 * tested with a fake `{ owned, owner }` value instead of touching chain
 * state (see test/helpers/e2e-helpers.test.js).
 *
 * NOTE — this repo (unlike bulletin-deploy) ships no fixture-registration
 * tool (no `tools/register-test-fixture.mjs`), so `fixtureRemedy` above
 * points at an admin action rather than a script to run.
 *
 * @param {object} o
 * @param {{owned: boolean, owner: string|null}} o.ownership — result of dotns.checkOwnership(label, expectedOwner)
 * @param {string} o.label         bare label being checked (no TLD), e.g. "e2eownedns03"
 * @param {string} o.tld           resolved TLD, e.g. "paseo"
 * @param {string} o.expectedOwner 0x-prefixed H160 the fixture must belong to
 * @param {string} o.scenario      scenario name for the >> FAIL: header
 * @param {string} o.envLabel      env id, used to build the repair-command hint
 * @param {string} [o.funder]      0x H160 of the funder (root Alice)
 */
export function assertFixtureOwnership({ ownership, label, tld, expectedOwner, scenario, envLabel, funder }) {
  const want = String(expectedOwner).toLowerCase();
  if (ownership.owner && ownership.owner.toLowerCase() === want) return;

  const holder = funder && ownership.owner && ownership.owner.toLowerCase() === String(funder).toLowerCase()
    ? "the funder holds it, so an earlier run registered it to itself"
    : "a third party holds it";
  const cause = ownership.owner
    ? `${label}.${tld} is owned by ${ownership.owner} on env "${envLabel}", expected ${expectedOwner}: ${holder}`
    : `${label}.${tld} is UNOWNED on env "${envLabel}" — the registry was probably reset by a DotNS redeploy (CREATE3 keeps every contract address identical, so nothing else signals it)`;
  const { fix, hint } = fixtureRemedy({ label, envLabel, expectedOwner, owner: ownership.owner, funder });

  failWith({
    scenario,
    message: `fixture precheck failed: ${cause}. Fix: ${fix}`,
    hint,
  });
}

/**
 * Checks the deploy output for fixture drift after the deploy ran and fails
 * with the matching fix. Returns the classification without failing when the
 * output shows no drift, so the caller's exit-code check reports the failure.
 *
 * @param {string} o.output         combined stdout+stderr from the deploy
 * @param {string} o.label          bare label, e.g. "e2eownedns03"
 * @param {string} o.tld            e.g. "paseo"
 * @param {string} o.expectedOwner  0x H160 the fixture must belong to
 * @param {string} [o.funder]       0x H160 of the funder (root Alice)
 * @param {string} o.scenario       scenario name for the >> FAIL: header
 * @param {string} o.envLabel       env id, used in the fix command
 * @returns {{kind: "missing"|"drifted"|"ok", owner: string|null}}
 */
export function assertFixtureNotDrifted({ output, label, tld, expectedOwner, funder, scenario, envLabel }) {
  const domain = `${label}.${tld}`;
  const fixture = classifyFixtureState({ output, expectedOwner, label: domain });
  if (fixture.kind === "ok") return fixture;

  const notARegression = "This is a test-fixture problem, not a polkadot-app-deploy regression.";

  if (fixture.kind === "missing") {
    // The CLI found the name free and registered it to the deploy signer. The
    // output does not say who that is; the precheck reads ownerOf, so rerun.
    failWith({
      scenario,
      message:
        `fixture drift on env "${envLabel}": ${domain} was unregistered when the deploy started and is now ` +
        `owned by the deploy signer, not ${expectedOwner}. ${notARegression} ` +
        `Fix: rerun this scenario; the precheck above names the holder and the repair`,
      context: output,
      keywords: [`${domain} is available`, "already owned", "Domain"],
      hint:
        "this repo ships no fixture-registration tool — ask the chain admin to register/transfer the fixture, " +
        "then rerun.",
    });
  }

  const { fix, hint } = fixtureRemedy({ label, envLabel, expectedOwner, owner: fixture.owner, funder });
  failWith({
    scenario,
    message:
      `fixture drift on env "${envLabel}": ${domain} is owned by ${fixture.owner}, not ${expectedOwner}. ` +
      `${notARegression} Fix: ${fix}`,
    context: output,
    keywords: ["already owned", "Domain"],
    hint,
  });
}
