// Fails when a shipped stack copy in .trinity is past its expiresAt and warns when one is past its
// validUntil. Kept out of the build so an outdated copy does not break `npm ci`.
import { assertShippedStacksUnexpired } from "../dist/stacks.js";

try {
  for (const warning of assertShippedStacksUnexpired()) {
    console.log(process.env.GITHUB_ACTIONS === "true" ? `::warning title=Shipped stack copy stale::${warning}` : `warning: ${warning}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
