import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5177",
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  webServer: [
    {
      command: "npm run dev:server",
      url: "http://127.0.0.1:4177/api/health",
      // The connect-speaker guide renders config.lanLmsHost, whose default is the machine's own
      // default-route IP. Pin it here (Playwright merges this over process.env) so the e2e
      // assertion checks the rendered value against a known host, not the runner's network.
      env: { LAN_LMS_HOST: "192.168.1.142" },
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    },
    {
      command: "npm run dev:client",
      url: "http://127.0.0.1:5177",
      reuseExistingServer: !process.env.CI,
      timeout: 20_000
    }
  ],
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1680, height: 945 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ]
});

