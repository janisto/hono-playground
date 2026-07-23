import { describe, expect, it } from "vitest";

import {
  getDeploymentOpenApiDocument,
  STANDALONE_SCHEMA_REGISTRY,
} from "../../src/openapi/artifacts.js";
import { decorateOpenApiForDeployment } from "../../src/openapi/deployment.js";

type TestObject = Record<string, unknown> & {
  CloudflareAccessCookie?: unknown;
  CloudflareAccessOAuth?: unknown;
  ExistingScheme?: unknown;
  authorizationUrl?: unknown;
  components?: unknown;
  description?: unknown;
  paths?: unknown;
  security?: unknown;
  securitySchemes?: unknown;
  tokenUrl?: unknown;
};
type BaseDocument = {
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
  info: { title: string; version: string };
  openapi: string;
  paths: {
    "/health": { get: Record<string, unknown> };
    "/v1/profile": {
      delete: Record<string, unknown>;
      get: Record<string, unknown>;
      patch: Record<string, unknown>;
      post: Record<string, unknown>;
    };
  };
  security: Record<string, never[]>[];
};

const object = (value: unknown): TestObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected object");
  }
  return value as TestObject;
};

const baseDocument = (): BaseDocument => ({
  openapi: "3.1.0",
  info: { title: "Hono Playground", version: "0.1.0" },
  components: {
    schemas: { HealthResponse: { type: "object" } },
    securitySchemes: { ExistingScheme: { type: "http", scheme: "basic" } },
  },
  security: [{ LegacyRoot: [] }],
  paths: {
    "/health": {
      get: { operationId: "getHealth", responses: {}, security: [{ LegacyOperation: [] }] },
    },
    "/v1/profile": {
      get: { operationId: "getProfile", responses: {}, security: [{ LegacyOperation: [] }] },
      post: { operationId: "createProfile", responses: {} },
      patch: { operationId: "updateProfile", responses: {} },
      delete: { operationId: "deleteProfile", responses: {} },
    },
  },
});

const operation = (
  document: TestObject,
  path: "/health" | "/v1/profile",
  method: "delete" | "get" | "patch" | "post",
): TestObject => object(object(object(document.paths)[path])[method]);

const securitySchemes = (document: TestObject): TestObject =>
  object(object(document.components).securitySchemes);

describe("deployment OpenAPI decoration", () => {
  it("builds immutable deployment and standalone artifacts once at module initialization", () => {
    const options = {
      deploymentProfile: "custom-domain-production",
      managedOauthEnabled: true,
      rateLimitMode: "workers-binding+waf",
    } as const;
    const first = getDeploymentOpenApiDocument(options);
    const second = getDeploymentOpenApiDocument(options);

    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(STANDALONE_SCHEMA_REGISTRY.size).toBe(11);
    expect(() =>
      getDeploymentOpenApiDocument({
        deploymentProfile: "workers-dev-demo",
        managedOauthEnabled: false,
        rateLimitMode: "workers-binding+waf",
      }),
    ).toThrow("Unsupported OpenAPI deployment variant");
  });

  it("describes whole-Worker Access at the root for workers.dev without mutating the base", () => {
    const base = baseDocument();
    const before = structuredClone(base);
    const decorated = object(
      decorateOpenApiForDeployment(base, {
        deploymentProfile: "workers-dev-demo",
        managedOauthEnabled: false,
        rateLimitMode: "workers-binding",
      }),
    );

    expect(base).toEqual(before);
    expect(decorated).toMatchObject({
      "x-cloudflare-deployment-profile": "workers-dev-demo",
      "x-cloudflare-edge-access-scope": "worker",
      "x-cloudflare-rate-limit-mode": "workers-binding",
      security: [{ CloudflareAccessCookie: [] }],
    });
    expect(operation(decorated, "/health", "get").security).toBeUndefined();
    expect(operation(decorated, "/v1/profile", "get").security).toBeUndefined();

    const schemes = securitySchemes(decorated);
    expect(schemes.ExistingScheme).toEqual({ type: "http", scheme: "basic" });
    expect(schemes.CloudflareAccessCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "CF_Authorization",
    });
    expect(schemes.CloudflareAccessOAuth).toBeUndefined();
    expect(JSON.stringify(decorated)).not.toContain("Cf-Access-Jwt-Assertion");
    expect(Object.isFrozen(decorated)).toBe(true);
    expect(Object.isFrozen(object(decorated.paths))).toBe(true);
  });

  it("uses cookie-or-opaque-Managed-OAuth only on profile operations for a custom domain", () => {
    const decorated = object(
      decorateOpenApiForDeployment(baseDocument(), {
        deploymentProfile: "custom-domain-production",
        managedOauthEnabled: true,
        rateLimitMode: "workers-binding+waf",
      }),
    );
    const expectedSecurity = [{ CloudflareAccessCookie: [] }, { CloudflareAccessOAuth: [] }];

    expect(decorated.security).toBeUndefined();
    expect(decorated).toMatchObject({
      "x-cloudflare-deployment-profile": "custom-domain-production",
      "x-cloudflare-edge-access-scope": "profile-path",
      "x-cloudflare-rate-limit-mode": "workers-binding+waf",
    });
    expect(operation(decorated, "/health", "get").security).toBeUndefined();
    for (const method of ["get", "post", "patch", "delete"] as const) {
      expect(operation(decorated, "/v1/profile", method).security).toEqual(expectedSecurity);
    }

    const oauth = object(securitySchemes(decorated).CloudflareAccessOAuth);
    expect(oauth).toMatchObject({
      type: "http",
      scheme: "bearer",
      "x-cloudflare-managed-oauth": true,
    });
    expect(oauth.description).toMatch(/opaque, user-based/i);
    expect(oauth.description).toMatch(/WWW-Authenticate/);
    expect(oauth.description).toMatch(/RFC 9728/);
    expect(oauth.description).toMatch(/RFC 8414/);
    expect(oauth.authorizationUrl).toBeUndefined();
    expect(oauth.tokenUrl).toBeUndefined();
  });

  it("removes stale Managed OAuth metadata when the live option is disabled", () => {
    const base = baseDocument();
    base.components.securitySchemes = {
      ...base.components.securitySchemes,
      CloudflareAccessOAuth: { type: "http", scheme: "bearer" },
    };
    const decorated = object(
      decorateOpenApiForDeployment(base, {
        deploymentProfile: "custom-domain-production",
        managedOauthEnabled: false,
        rateLimitMode: "workers-binding",
      }),
    );

    expect(securitySchemes(decorated).CloudflareAccessOAuth).toBeUndefined();
    expect(operation(decorated, "/v1/profile", "get").security).toEqual([
      { CloudflareAccessCookie: [] },
    ]);
  });

  it("rejects modeling the Access-injected assertion as client input", () => {
    const base = baseDocument();
    base.paths["/v1/profile"].get = {
      ...base.paths["/v1/profile"].get,
      parameters: [
        {
          name: "Cf-Access-Jwt-Assertion",
          in: "header",
          required: true,
          schema: { type: "string" },
        },
      ],
    };

    expect(() =>
      decorateOpenApiForDeployment(base, {
        deploymentProfile: "workers-dev-demo",
        managedOauthEnabled: false,
        rateLimitMode: "workers-binding",
      }),
    ).toThrow("must not be client input");
  });

  it("rejects unsupported options and documents without profile operations", () => {
    expect(() =>
      decorateOpenApiForDeployment(baseDocument(), {
        deploymentProfile: "invalid" as "workers-dev-demo",
        managedOauthEnabled: false,
        rateLimitMode: "workers-binding",
      }),
    ).toThrow("Unsupported deployment profile");

    expect(() =>
      decorateOpenApiForDeployment(baseDocument(), {
        deploymentProfile: "workers-dev-demo",
        managedOauthEnabled: false,
        rateLimitMode: "workers-binding+waf",
      }),
    ).toThrow("cannot truthfully advertise");

    const withoutProfile = baseDocument();
    delete (withoutProfile.paths as Partial<typeof withoutProfile.paths>)["/v1/profile"];
    expect(() =>
      decorateOpenApiForDeployment(withoutProfile, {
        deploymentProfile: "custom-domain-production",
        managedOauthEnabled: false,
        rateLimitMode: "workers-binding",
      }),
    ).toThrow("no operations at /v1/profile");
  });
});
