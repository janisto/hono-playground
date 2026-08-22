import { readdir } from "node:fs/promises";
import path from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

import { COMPATIBILITY_DATE, RATE_LIMITS } from "./infra/config.ts";

const readDrizzleMigrations = async () => {
  const root = path.join(import.meta.dirname, "drizzle");
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory() && /^[0-9]+_/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const migrations = await Promise.all(
    directories.map(async (directory) => {
      const nested = await readD1Migrations(path.join(root, directory));
      return nested.map((migration) => ({
        ...migration,
        name: `${directory}/${migration.name}`,
      }));
    }),
  );
  return migrations.flat();
};

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: COMPATIBILITY_DATE,
        compatibilityFlags: ["enable_request_signal", "request_signal_passthrough"],
        d1Databases: ["DB"],
        versionMetadata: "CF_VERSION_METADATA",
        ratelimits: {
          PUBLIC_RATE_LIMITER: {
            namespace_id: "test-public",
            simple: RATE_LIMITS.public,
          },
          PROFILE_READ_RATE_LIMITER: {
            namespace_id: "test-profile-read",
            simple: RATE_LIMITS.profileRead,
          },
          PROFILE_WRITE_RATE_LIMITER: {
            namespace_id: "test-profile-write",
            simple: RATE_LIMITS.profileWrite,
          },
        },
        bindings: {
          TEST_MIGRATIONS: await readDrizzleMigrations(),
          ENVIRONMENT: "test",
          MAX_REQUEST_SIZE_BYTES: 1_000_000,
          RATE_LIMIT_MODE: "workers-binding",
          ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
          ACCESS_AUD: "test-audience",
          PUBLIC_ORIGIN: "https://worker.example",
          RATE_LIMIT_KEY_HMAC_KEY: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          AUDIT_SUBJECT_HMAC_KEY: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      },
    })),
  ],
  test: {
    allowOnly: false,
    setupFiles: ["./test/deny-outbound-fetch.ts", "./test/apply-migrations.ts"],
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary", "html"],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
  },
});
