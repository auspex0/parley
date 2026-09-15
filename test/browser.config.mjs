import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: ["browser.mjs", "browser-policy.mjs"],
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../browser-failure",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
