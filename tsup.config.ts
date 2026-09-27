import { defineConfig } from "tsup";

export default defineConfig({
  // Every src/**/*.ts file is a build entry (each gets its own dist/*.js +
  // dist/*.d.ts, matching the pre-glob hand-maintained list) except the
  // vendor unit tests, which are exercised via `npm run test:vendor`
  // (vitest) instead of being part of the published surface.
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: "esm",
  dts: true,
  clean: true,
  target: "node22",
  define: {
    // Injected at build time. Set SENTRY_DSN in CI publish workflow.
    // Empty string in source builds → Sentry init is skipped (no DSN).
    __SENTRY_DSN__: JSON.stringify(process.env.SENTRY_DSN ?? ""),
  },
});
