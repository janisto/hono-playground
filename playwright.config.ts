import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = 8788;
const baseURL = `http://${host}:${port}`;
const { CI } = process.env;
const isCI = Boolean(CI);

export default defineConfig({
  testDir: "./test/e2e",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: isCI ? "github" : "list",
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "node test/e2e/server.mjs",
    url: `${baseURL}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
