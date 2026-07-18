import { defineConfig } from "vitest/config";

// Each test file gets its own process: in-memory DBs stay isolated and
// module-level env assignments happen before src imports are evaluated.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { isolate: true } },
  },
});
