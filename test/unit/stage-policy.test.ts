import { describe, expect, it } from "vitest";

import { deploymentHostname, deploymentStagePolicy } from "../../infra/stage-policy.js";

describe("deployment stage policy", () => {
  it.each([
    ["prod", { environment: "production", persistent: true }],
    ["staging", { environment: "staging", persistent: true }],
    ["dev_jani", { environment: "development", persistent: false }],
    ["dev_unknown", { environment: "development", persistent: false }],
    ["dev_jani-local", { environment: "development", persistent: false }],
  ] as const)("maps the accepted stage %s before provider operations", (stage, expected) => {
    expect(deploymentStagePolicy(stage)).toEqual(expected);
  });

  it.each(["dev", "production", "prod-typo", "pr-42", "staging_copy"])(
    "rejects the syntactically valid but unsupported stage %s",
    (stage) => {
      expect(() => deploymentStagePolicy(stage)).toThrow(`Unsupported deployment stage "${stage}"`);
    },
  );

  it.each(["api.example.com", "staging-api.example.com", "api.xn--bcher-kva.example"])(
    "accepts the custom hostname %s",
    (hostname) => {
      expect(deploymentHostname(hostname)).toBe(hostname);
    },
  );

  it.each([
    "",
    "localhost",
    "HTTPS://api.example.com",
    "api.example.com/",
    "api_example.com",
    "-api.example.com",
    "api-.example.com",
    "api..example.com",
    "api.example.123",
    "workers.dev",
    "hono-playground.workers.dev",
    `api.${"a".repeat(64)}.example`,
  ])("rejects the invalid or direct Cloudflare hostname %s", (hostname) => {
    expect(() => deploymentHostname(hostname)).toThrow("Invalid WORKER_DOMAIN");
  });
});
