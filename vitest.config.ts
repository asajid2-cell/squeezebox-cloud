import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    pool: "threads",
    globals: true,
    setupFiles: "./tests/setup.ts",
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"],
    // The library search/collection endpoints lazily ffprobe durations. In tests the
    // fixture paths don't exist, so probing only spawns failing ffprobe processes that
    // add CPU load and make the parallel suite flaky. Disable the probe budget under
    // test (duration display is covered by a dedicated frontend test + live checks).
    env: {
      LOCAL_SEARCH_DURATION_BUDGET_MS: "0",
      LOCAL_COLLECTION_DURATION_BUDGET_MS: "0"
    }
  }
});
