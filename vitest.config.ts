import { defineConfig } from "vitest/config";

// `npm test` runs test/unit (no database). `npm run test:integration` runs test/integration (needs Postgres).
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Integration tests talk to a real database; give them more than the 5 s default.
    testTimeout: 20_000,
  },
});
