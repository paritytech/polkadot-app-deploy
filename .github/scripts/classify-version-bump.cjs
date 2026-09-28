#!/usr/bin/env node
"use strict";

// Shared classifier (#195 / see also the Unit-Tests-gating follow-up): is a
// package.json/package-lock.json diff a pure version-field bump, or does it
// touch dependencies/devDependencies/overrides/peerDependencies (or the
// resolved lockfile tree) too?
//
// version-only iff a package file changed AND nothing but `.version` (plus
// the lockfile's top-level `.version` and `.packages[""].version`) differs
// between base and head.
//
// Shared by e2e.yml's detect-deps-change job (gates the heavy chain-E2E
// jobs) and tests.yml's classify job (gates Unit Tests) so the two workflows
// can never classify the same diff differently.
//
// CLI usage (invoked by both workflows, after they've fetched both refs'
// content via the GitHub Contents API — see each workflow's `fetch()` step):
// reads base_pkg.json, head_pkg.json, base_lock.json, head_lock.json from
// the current directory (each may be empty/absent — an empty file means
// "file did not exist at that ref") and appends `is_version_only=<bool>` to
// $GITHUB_OUTPUT (if set).

const fs = require("fs");

function loadJSON(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function stripVersionFields(obj, isLockfile) {
  if (!obj || typeof obj !== "object") return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  delete clone.version;
  if (isLockfile && clone.packages && typeof clone.packages === "object" &&
      clone.packages[""] && typeof clone.packages[""] === "object") {
    delete clone.packages[""].version;
  }
  return clone;
}

// Pure function over the four parsed objects (each null if the file did not
// exist / failed to parse at that ref).
function classifyVersionBump({ basePkg, headPkg, baseLock, headLock }) {
  // Did either file change at all (including a pure version bump)?
  const anyPackageFileChanged =
    JSON.stringify(basePkg) !== JSON.stringify(headPkg) ||
    JSON.stringify(baseLock) !== JSON.stringify(headLock);

  const strippedBasePkg = stripVersionFields(basePkg, false);
  const strippedHeadPkg = stripVersionFields(headPkg, false);
  const strippedBaseLock = stripVersionFields(baseLock, true);
  const strippedHeadLock = stripVersionFields(headLock, true);

  // Is there any diff left once version fields are stripped out?
  const nonVersionDiff =
    JSON.stringify(strippedBasePkg) !== JSON.stringify(strippedHeadPkg) ||
    JSON.stringify(strippedBaseLock) !== JSON.stringify(strippedHeadLock);

  // version-only iff something changed AND the only thing that changed was
  // a version field. Neither-file-touched (ordinary source PR) must NOT
  // count as version-only, or every consumer gating on this would skip for
  // a normal source change too.
  return anyPackageFileChanged && !nonVersionDiff;
}

module.exports = { classifyVersionBump, loadJSON, stripVersionFields };

function main() {
  const basePkg = loadJSON("base_pkg.json");
  const headPkg = loadJSON("head_pkg.json");
  const baseLock = loadJSON("base_lock.json");
  const headLock = loadJSON("head_lock.json");

  const isVersionOnly = classifyVersionBump({ basePkg, headPkg, baseLock, headLock });

  console.log(`is_version_only=${isVersionOnly}`);
  console.log(`deps_changed=${!isVersionOnly}`); // logged only, for debugging — not exposed as a separate output

  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    fs.appendFileSync(out, `is_version_only=${isVersionOnly}\n`);
  }
}

if (require.main === module) {
  main();
}
