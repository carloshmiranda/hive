import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for automated QA testing
 * Integrated with Hive's webapp-testing skill
 */
export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./qa-results/test-results",
  fullyParallel: false, // single-threaded in CI prevents flakiness
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  /* Enhanced reporting for QA integration */
  reporter: [
    ["html", { outputFolder: "./qa-results/playwright-report" }],
    ["json", { outputFile: "./qa-results/results.json" }],
    ["line"]
  ],
  use: {
    baseURL: process.env.QA_BASE_URL || process.env.BASE_URL || "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    /* Capture video on failure for debugging */
    video: "retain-on-failure",
  },
  timeout: 30_000,
  /* Configure projects for browser testing */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  /* Run local dev server before tests if not in CI */
  webServer: process.env.CI ? undefined : {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
