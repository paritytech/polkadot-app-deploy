// Prints every value of each shipped stack descriptor, for the stack update pull request.
//
//   node scripts/stack-values.mjs > before.json
//   node scripts/stack-values.mjs --compare before.json   # the pull request body, in Markdown

import { readFileSync } from "node:fs";
import { listShippedStacks } from "../tools/lib/stack-copies.mjs";

// Array entries are keyed by their `role` or `kind` when unique, so a diff reads
// `chains.Bulletin.rpc` instead of `chains.3.rpc`.
function readEntryKey(entry, index, siblings) {
  for (const field of ["role", "kind"]) {
    const key = entry?.[field];
    const isUnique = siblings.filter((sibling) => sibling?.[field] === key).length === 1;
    if (typeof key === "string" && isUnique) return key;
  }
  return String(index);
}

function flattenValue(value, path, values) {
  if (Array.isArray(value)) {
    if (value.every((entry) => typeof entry !== "object" || entry === null)) {
      values[path] = value.join(", ");
      return;
    }
    value.forEach((entry, index) => flattenValue(entry, `${path}.${readEntryKey(entry, index, value)}`, values));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) flattenValue(entry, path ? `${path}.${key}` : key, values);
  } else {
    values[path] = String(value);
  }
}

function readValues() {
  return Object.fromEntries(
    listShippedStacks().map(({ id, descriptor }) => {
      const values = {};
      flattenValue(descriptor, "", values);
      return [id, values];
    }),
  );
}

function describeChanges(before, after) {
  const sections = Object.entries(after).map(([id, values]) => {
    const previous = before[id] ?? {};
    const keys = [...new Set([...Object.keys(previous), ...Object.keys(values)])];
    const changedKeys = keys.filter((key) => previous[key] !== values[key]);
    if (changedKeys.length === 0) return `**${id}**: no value changed.`;
    const lines = changedKeys.map(
      (key) => `- \`${key}\`: \`${previous[key] ?? "(none)"}\` -> \`${values[key] ?? "(none)"}\``,
    );
    return [`**${id}**`, "", ...lines].join("\n");
  });
  return [
    "The shipped stack copies in `.trinity/` now match the published descriptors. Changed values, before -> after:",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

const [mode, beforeFile] = process.argv.slice(2);
if (mode === "--compare" && beforeFile) {
  const before = JSON.parse(readFileSync(beforeFile, "utf8"));
  try {
    console.log(describeChanges(before, readValues()));
  } catch (error) {
    console.log(`The updated stack copies cannot be read:\n\n\`\`\`\n${error?.message ?? error}\n\`\`\``);
  }
} else if (mode === undefined) {
  console.log(JSON.stringify(readValues(), null, 2));
} else {
  console.error("usage: stack-values.mjs [--compare <before.json>]");
  process.exit(1);
}
