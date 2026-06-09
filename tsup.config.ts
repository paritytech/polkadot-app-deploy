import { defineConfig } from "tsup";

export default defineConfig({
  define: {
    // Injected at build time. Set SENTRY_DSN in CI publish workflow.
    // Empty string in source builds → Sentry init is skipped (no DSN).
    __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN ?? ""),
  },
});
