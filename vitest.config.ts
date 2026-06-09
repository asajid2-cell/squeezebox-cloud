import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    pool: "threads",
    globals: true,
    setupFiles: "./tests/setup.ts",
    exclude: ["node_modules/**", "dist/**", "tests/e2e/**"]
  }
});
