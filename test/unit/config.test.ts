import { describe, expect, it } from "vitest";

import { parseAccessVerifierConfig } from "../../src/auth/access.js";
import { AccessConfigurationError } from "../../src/auth/types.js";
import { parseRuntimeConfig, requireHmacSecret } from "../../src/core/config.js";
import { AppError } from "../../src/core/errors.js";
import type { RuntimeBindings } from "../../src/core/types.js";

const STRONG_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  DEPLOYMENT_PROFILE: "workers-dev-demo",
  LOG_LEVEL: "error",
  MANAGED_OAUTH_ENABLED: "false",
  RATE_LIMIT_MODE: "none",
} satisfies RuntimeBindings;

const expectConfigurationFailure = (operation: () => unknown): void => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      status: 500,
      code: "internal_error",
      detail: "Internal Server Error",
      operatorCode: "runtime_configuration_invalid",
    });
    return;
  }
  throw new Error("Expected configuration failure");
};

describe("runtime configuration", () => {
  it("parses the explicit supported test configuration", () => {
    expect(parseRuntimeConfig(TEST_BINDINGS)).toEqual({
      environment: "test",
      deploymentProfile: "workers-dev-demo",
      logLevel: "error",
      maximumRequestBytes: 1_000_000,
      managedOauthEnabled: false,
      rateLimitMode: "none",
    });
  });

  it("requires deployment truth values and rejects impossible topology combinations", () => {
    for (const name of ["ENVIRONMENT", "DEPLOYMENT_PROFILE", "RATE_LIMIT_MODE"] as const) {
      const candidate: RuntimeBindings = { ...TEST_BINDINGS };
      delete candidate[name];
      expectConfigurationFailure(() => parseRuntimeConfig(candidate));
    }
    expectConfigurationFailure(() =>
      parseRuntimeConfig({
        ...TEST_BINDINGS,
        RATE_LIMIT_MODE: "workers-binding+waf",
      }),
    );
    expect(
      parseRuntimeConfig({
        ...TEST_BINDINGS,
        DEPLOYMENT_PROFILE: "custom-domain-production",
        RATE_LIMIT_MODE: "workers-binding+waf",
      }).rateLimitMode,
    ).toBe("workers-binding+waf");
  });

  it.each([
    [{ ENVIRONMENT: "invalid" }, "invalid environment"],
    [{ DEPLOYMENT_PROFILE: "invalid" }, "invalid deployment profile"],
    [{ LOG_LEVEL: "verbose" }, "invalid log level"],
    [{ RATE_LIMIT_MODE: "invalid" }, "invalid rate-limit mode"],
    [{ MANAGED_OAUTH_ENABLED: "yes" }, "invalid boolean"],
    [{ MAX_REQUEST_SIZE_BYTES: "0" }, "zero request limit"],
    [{ MAX_REQUEST_SIZE_BYTES: "1.5" }, "fractional request limit"],
    [{ MAX_REQUEST_SIZE_BYTES: "10000001" }, "oversized request limit"],
    [{ MAX_REQUEST_SIZE_BYTES: "not-a-number" }, "non-numeric request limit"],
    [
      { ENVIRONMENT: "production", LOG_LEVEL: "debug", RATE_LIMIT_MODE: "workers-binding" },
      "production debug",
    ],
    [{ ENVIRONMENT: "production", RATE_LIMIT_MODE: "none" }, "production limiter disabled"],
    [
      {
        ENVIRONMENT: "production",
        RATE_LIMIT_MODE: "workers-binding",
        MAX_REQUEST_SIZE_BYTES: "999999",
      },
      "production request limit drift",
    ],
  ])("rejects invalid common configuration: $1", (overrides, _caseName) => {
    expectConfigurationFailure(() => parseRuntimeConfig({ ...TEST_BINDINGS, ...overrides }));
  });

  it("requires a canonical visible-ASCII Access verifier configuration", () => {
    expect(
      parseAccessVerifierConfig({
        teamDomain: "https://team.cloudflareaccess.com",
        audience: "visible-audience",
      }),
    ).toEqual({
      issuer: "https://team.cloudflareaccess.com",
      audience: "visible-audience",
      jwksUrl: new URL("https://team.cloudflareaccess.com/cdn-cgi/access/certs"),
    });
    for (const overrides of [
      { teamDomain: "https://tëam.cloudflareaccess.com", audience: "audience" },
      { teamDomain: "https://team.cloudflareaccess.com/path", audience: "audience" },
      { teamDomain: "https://team.cloudflareaccess.com", audience: "audience\nvalue" },
      { teamDomain: "https://team.cloudflareaccess.com", audience: "audience-🙂" },
    ]) {
      expect(() => parseAccessVerifierConfig(overrides)).toThrow(AccessConfigurationError);
      try {
        parseAccessVerifierConfig(overrides);
      } catch (error) {
        expect(error).toMatchObject({
          status: 500,
          operatorCode: "access_verifier_configuration_invalid",
        });
      }
    }
  });
});

describe("HMAC secret format", () => {
  it("decodes one canonical lowercase 64-hex value to 32 key bytes", () => {
    const decoded = requireHmacSecret(STRONG_KEY);

    expect(decoded).toBeInstanceOf(Uint8Array);
    expect(decoded).toHaveLength(32);
    expect(Array.from(decoded, (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      STRONG_KEY,
    );
  });

  it.each([
    undefined,
    "",
    "a".repeat(64),
    "0123456789abcdef".repeat(4),
    STRONG_KEY.toUpperCase(),
    "replace-with-a-random-local-rate-limit-key",
  ])("rejects missing, malformed, or obviously repeated key material", (value) => {
    expectConfigurationFailure(() => requireHmacSecret(value));
  });
});
