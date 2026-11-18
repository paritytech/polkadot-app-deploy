// Fails the build when a shipped stack copy in .trinity does not verify against its link's key,
// lacks a required field, or has no valid policy entry. Dates are checked by
// scripts/check-stacks-current.mjs, outside the build.
import { assertShippedStacks, BUILT_IN_STACK_IDS, readShippedStack } from "../dist/stacks.js";

try {
  assertShippedStacks();
  for (const id of BUILT_IN_STACK_IDS) {
    const { descriptor } = readShippedStack(id);
    console.log(`stack ${id}: descriptor ${descriptor.id}, sequence ${descriptor.sequence}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
