// Reads the built-in stacks without a build or node_modules: the policy table in
// assets/stack-policy.json and the descriptor inside each shipped copy in .trinity/.
// Signatures are not checked here; `npm run build` checks every shipped copy.
// For anything that deploys, use dist/stacks.js, which also refreshes from the published descriptor.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function readStackPolicy() {
  return JSON.parse(readFileSync(`${repoRoot}assets/stack-policy.json`, "utf8"));
}

/** The built-in id `value` is an id or alias of, case-insensitively; undefined when there is none. */
export function findBuiltInStackId(value, policy = readStackPolicy()) {
  const token = String(value).trim().toLowerCase();
  return Object.keys(policy.stacks).find(
    (id) => id === token || policy.stacks[id].aliases.some((alias) => alias.toLowerCase() === token),
  );
}

/** The descriptor a shipped copy carries: the payload of its signed envelope, or the copy itself. */
export function readShippedDescriptor(id) {
  const copy = JSON.parse(readFileSync(`${repoRoot}.trinity/${id}.json`, "utf8"));
  return "payload" in copy ? JSON.parse(Buffer.from(copy.payload, "base64").toString("utf8")) : copy;
}

/** Each built-in stack in policy order, with its policy entry and shipped descriptor. */
export function listShippedStacks(policy = readStackPolicy()) {
  return Object.entries(policy.stacks).map(([id, entry]) => ({ id, policy: entry, descriptor: readShippedDescriptor(id) }));
}

/** The chain with `role` in a descriptor, or undefined. */
export function findChain(descriptor, role) {
  return descriptor.chains.find((chain) => chain.role === role);
}
