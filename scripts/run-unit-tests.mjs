#!/usr/bin/env node
// Discovers and runs the unit test suite, replacing a hand-maintained list of
// file paths in package.json's "test" script. A forgotten new test file
// used to fail silently (never wired in, never run in CI) — see the
// "test-suite wiring" guard in test/test.js, which imports
// collectUnitTestFiles from here so the two can never drift apart.
//
// Selection: every test/**/*.test.js file (any depth), plus test/test.js and
// any test/test-*.js file at the test/ ROOT ONLY (not recursive — a
// test/helpers/test-utils.js is a fixture, not a test file), EXCLUDING the
// E2E pair (test/e2e.test.js, test/e2e-reprove.test.js). Both self-skip
// unless E2E=1, but their top-level imports still execute at collection
// time, so they must stay out of the default run — they execute via
// `npm run test:e2e` and the e2e.yml workflow instead.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptsDir);
const testDir = path.join(repoRoot, "test");

// Referenced explicitly by name in .github/workflows/e2e.yml and
// scripts/e2e-pass.sh — that reference is what satisfies the wiring guard's
// "referenced by a workflow or script" branch for these two files. Do NOT
// treat this Set's own literal strings as satisfying that branch (the guard
// excludes this file from its corpus scan for exactly that reason).
const EXCLUDED_FILENAMES = new Set(["e2e.test.js", "e2e-reprove.test.js"]);

function isSelectableTestFile(filename, isRoot) {
  if (EXCLUDED_FILENAMES.has(filename)) return false;
  if (filename.endsWith(".test.js")) return true;
  if (!isRoot) return false;
  return filename === "test.js" || /^test-.*\.js$/.test(filename);
}

export function collectUnitTestFiles(root = testDir) {
  const results = [];
  const walk = (dir, isRoot) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, false);
        continue;
      }
      if (isSelectableTestFile(entry.name, isRoot)) results.push(full);
    }
  };
  walk(root, true);
  return results.sort();
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const files = collectUnitTestFiles().map((f) => path.relative(repoRoot, f));
  if (files.length === 0) {
    console.error(">> FAIL: run-unit-tests: no unit test files discovered under test/");
    process.exit(1);
  }
  const result = spawnSync(process.execPath, ["--test", ...files], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  process.exit(result.status ?? 1);
}
