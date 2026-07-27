import { describe, expect, it } from "vitest";

import { isRateLimitNamespaceId } from "../../infra/config.ts";
import { deploymentHostname, deploymentStagePolicy, deploymentTraceSamplingRate } from "../../infra/stage-policy.ts";

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

  it("uses full trace sampling outside production and bounded production sampling", () => {
    expect(deploymentTraceSamplingRate("development")).toBe(1);
    expect(deploymentTraceSamplingRate("staging")).toBe(1);
    expect(deploymentTraceSamplingRate("production")).toBe(0.01);
  });

  it.each(["1", "42", "9007199254740993"])("accepts a positive decimal rate-limit namespace ID: %s", (namespaceId) => {
    expect(isRateLimitNamespaceId(namespaceId)).toBe(true);
  });

  it.each(["", "0", "-1", "+1", "01", "1.0", " 1", "1 "])(
    "rejects an invalid rate-limit namespace ID: %s",
    (namespaceId) => {
      expect(isRateLimitNamespaceId(namespaceId)).toBe(false);
    },
  );

  it.each(["hono-playground.dev", "staging.hono-playground.dev", "api.staging.hono-playground.dev"])(
    "accepts the owned custom hostname %s",
    (hostname) => {
      expect(deploymentHostname(hostname)).toBe(hostname);
    },
  );

  it.each([
    "",
    "localhost",
    "HTTPS://staging.hono-playground.dev",
    "staging.hono-playground.dev/",
    "api_example.com",
    "-api.hono-playground.dev",
    "api-.hono-playground.dev",
    "api..hono-playground.dev",
    "api.hono-playground.123",
    "example.com",
    "hono-playground.dev.example.com",
    "api.hono-playground.dev.example.com",
    "workers.dev",
    "hono-playground.workers.dev",
    `api.${"a".repeat(64)}.hono-playground.dev`,
  ])("rejects the invalid or unowned hostname %s", (hostname) => {
    expect(() => deploymentHostname(hostname)).toThrow("Invalid WORKER_DOMAIN");
  });
});
