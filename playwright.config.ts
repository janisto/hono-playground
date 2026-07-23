import { defineConfig, devices } from "@playwright/test";

const host = "127.0.0.1";
const port = 8787;
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
    command:
      "pnpm exec wrangler dev --local --ip 127.0.0.1 --port 8787 --log-level error --show-interactive-dev-session=false --persist-to .wrangler/state/e2e --var ENVIRONMENT:test --var RATE_LIMIT_MODE:none",
    url: `${baseURL}/health`,
    timeout: 120_000,
    reuseExistingServer: !isCI,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      WRANGLER_REGISTRY_PATH: ".wrangler/registry/e2e",
      WRANGLER_WRITE_LOGS: "false",
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
