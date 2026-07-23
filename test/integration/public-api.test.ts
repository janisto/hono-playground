import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import type { RuntimeBindings } from "../../src/core/types.js";
import { DOCS_ASSETS } from "../../src/generated/docs-assets.js";
import { STANDALONE_SCHEMA_NAMES } from "../../src/openapi/standalone.js";

const ORIGIN = "https://api.example.test";
const RATE_LIMIT_KEY = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const ALLOW_LIMITER = {
  limit: () => Promise.resolve({ success: true }),
} as unknown as RateLimit;
const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  DEPLOYMENT_PROFILE: "workers-dev-demo",
  LOG_LEVEL: "error",
  MANAGED_OAUTH_ENABLED: "false",
  RATE_LIMIT_MODE: "none",
} satisfies RuntimeBindings;

const CUSTOM_DOMAIN_BINDINGS = {
  ...TEST_BINDINGS,
  DEPLOYMENT_PROFILE: "custom-domain-production",
  MANAGED_OAUTH_ENABLED: "true",
  RATE_LIMIT_MODE: "workers-binding+waf",
  RATE_LIMIT_KEY_HMAC_KEY: RATE_LIMIT_KEY,
  PUBLIC_RATE_LIMITER: ALLOW_LIMITER,
} satisfies RuntimeBindings;

const CORS_HEADERS = [
  "Access-Control-Allow-Credentials",
  "Access-Control-Allow-Headers",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Origin",
  "Access-Control-Expose-Headers",
  "Access-Control-Max-Age",
] as const;

const app = createApp();

const request = (
  path: string,
  init: RequestInit = {},
  bindings: RuntimeBindings = TEST_BINDINGS,
): Promise<Response> =>
  Promise.resolve(app.request(new Request(`${ORIGIN}${path}`, init), undefined, bindings));

interface JsonObject {
  [key: string]: unknown;
  readonly $schema?: unknown;
  readonly CloudflareAccessCookie?: unknown;
  readonly CloudflareAccessOAuth?: unknown;
  readonly components?: unknown;
  readonly description?: unknown;
  readonly errors?: unknown;
  readonly headers?: unknown;
  readonly info?: unknown;
  readonly items?: unknown;
  readonly openapi?: unknown;
  readonly operationId?: unknown;
  readonly paths?: unknown;
  readonly responses?: unknown;
  readonly schemas?: unknown;
  readonly security?: unknown;
  readonly securitySchemes?: unknown;
  readonly servers?: unknown;
  readonly total?: unknown;
}

const object = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
};

const jsonObject = async (response: Response): Promise<JsonObject> =>
  object(await response.json(), "JSON response");

const expectNoCors = (response: Response): void => {
  for (const header of CORS_HEADERS) {
    expect(response.headers.has(header)).toBe(false);
  }
};

const expectSecurityHeaders = (response: Response, documentation = false): void => {
  expect(response.headers.get("X-Request-ID")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(response.headers.get("Permissions-Policy")).toContain("geolocation=()");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.has("Strict-Transport-Security")).toBe(false);
  const csp = response.headers.get("Content-Security-Policy");
  if (documentation) {
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
  } else {
    expect(csp).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  }
  expectNoCors(response);
};

const postJson = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("application-public response contract", () => {
  it.each([
    {
      label: "health",
      path: "/health",
      init: {},
      contentType: "application/json",
      schemaLink: '</schemas/HealthResponse.json>; rel="describedBy"',
      documentation: false,
    },
    {
      label: "hello GET",
      path: "/v1/hello",
      init: {},
      contentType: "application/json",
      schemaLink: '</schemas/Greeting.json>; rel="describedBy"',
      documentation: false,
    },
    {
      label: "hello POST",
      path: "/v1/hello",
      init: postJson({ name: "Jani" }),
      contentType: "application/json",
      schemaLink: '</schemas/Greeting.json>; rel="describedBy"',
      documentation: false,
    },
    {
      label: "items",
      path: "/v1/items?limit=100",
      init: {},
      contentType: "application/json",
      schemaLink: '</schemas/ItemList.json>; rel="describedBy"',
      documentation: false,
    },
    {
      label: "OpenAPI",
      path: "/openapi.json",
      init: {},
      contentType: "application/json",
      schemaLink: null,
      documentation: false,
    },
    {
      label: "standalone schema",
      path: "/schemas/Greeting.json",
      init: {},
      contentType: "application/schema+json",
      schemaLink: '</schemas/Greeting.json>; rel="describedBy"',
      documentation: false,
    },
    {
      label: "documentation HTML",
      path: "/api-docs",
      init: {},
      contentType: "text/html",
      schemaLink: null,
      documentation: true,
    },
  ])("applies common headers, schema links, and no CORS to $label", async (contract) => {
    const response = await request(contract.path, contract.init);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(contract.contentType);
    expectSecurityHeaders(response, contract.documentation);
    if (contract.contentType.includes("json") || contract.documentation) {
      expect(response.headers.get("Vary")).toBe("Accept");
    } else {
      expect(response.headers.has("Vary")).toBe(false);
    }
    if (contract.schemaLink === null) {
      expect(response.headers.has("Link")).toBe(false);
    } else {
      expect(response.headers.get("Link")).toBe(contract.schemaLink);
    }
  });

  it("returns exact health and default greeting representations", async () => {
    const health = await request("/health");
    const hello = await request("/v1/hello");

    expect(await health.json()).toEqual({ status: "healthy" });
    expect(await hello.json()).toEqual({ message: "Hello, World!" });
  });
});

describe("hello operations", () => {
  it.each([
    ["en", "Hello"],
    ["fi", "Hei"],
    ["es", "Hola"],
    ["fr", "Bonjour"],
    ["de", "Hallo"],
  ])("uses the %s greeting", async (language, greeting) => {
    const response = await request("/v1/hello", postJson({ name: "Jani", language }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: `${greeting}, Jani!` });
  });

  it("counts the name bound in Unicode code points and preserves the value", async () => {
    const name = "😀".repeat(100);
    const response = await request("/v1/hello", postJson({ name, language: "fi" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: `Hei, ${name}!` });
  });

  it("rejects 101 Unicode code points without echoing the name", async () => {
    const name = "😀".repeat(101);
    const response = await request("/v1/hello", postJson({ name }));
    const body = await jsonObject(response);

    expect(response.status).toBe(422);
    expect(body.errors).toEqual([
      { location: "body.name", message: "String should have at most 100 characters" },
    ]);
    expect(JSON.stringify(body)).not.toContain(name);
    expect(response.headers.get("Link")).toBe(
      '</schemas/ValidationProblemResponse.json>; rel="describedBy"',
    );
  });

  it("rejects unknown keys with stable dot-notation validation", async () => {
    const response = await request(
      "/v1/hello",
      postJson({ name: "Jani", unexpected: "sensitive-marker" }),
    );
    const body = await jsonObject(response);

    expect(response.status).toBe(422);
    expect(body).toMatchObject({
      title: "Unprocessable Entity",
      status: 422,
      detail: "validation failed",
      errors: [{ location: "body.unexpected", message: "Unexpected field" }],
    });
    expect(JSON.stringify(body)).not.toContain("sensitive-marker");
    expectSecurityHeaders(response);
  });

  it("uses strict JSON wire types", async () => {
    const response = await request("/v1/hello", postJson({ name: 123, language: "en" }));
    const body = await jsonObject(response);

    expect(response.status).toBe(422);
    expect(body.errors).toEqual([{ location: "body.name", message: "Invalid value type" }]);
  });
});

describe("items API", () => {
  it("returns the default first 20 records and an exact relative next/schema Link", async () => {
    const response = await request("/v1/items", {
      headers: { Host: "attacker.invalid" },
    });
    const body = await jsonObject(response);
    const items = body.items as Array<{ id: string }>;

    expect(response.status).toBe(200);
    expect(body.total).toBe(30);
    expect(items).toHaveLength(20);
    expect(items[0]?.id).toBe("item-001");
    expect(items.at(-1)?.id).toBe("item-020");
    expect(response.headers.get("Link")).toBe(
      '</v1/items?limit=20&cursor=aXRlbTppdGVtLTAyMA>; rel="next", </schemas/ItemList.json>; rel="describedBy"',
    );
    expect(response.headers.get("Link")).not.toContain("attacker.invalid");
  });

  it("uses the last duplicate scalar query values and drops unknown keys from links", async () => {
    const response = await request(
      "/v1/items?limit=bad&limit=3&category=tools&category=electronics&cursor=bad&cursor=&unknown=keep-out",
    );
    const body = await jsonObject(response);
    const items = body.items as Array<{ id: string }>;

    expect(response.status).toBe(200);
    expect(body.total).toBe(13);
    expect(items.map((item) => item.id)).toEqual(["item-001", "item-002", "item-004"]);
    expect(response.headers.get("Link")).toBe(
      '</v1/items?category=electronics&limit=3&cursor=aXRlbTppdGVtLTAwNA>; rel="next", </schemas/ItemList.json>; rel="describedBy"',
    );
    expect(response.headers.get("Link")).not.toContain("unknown");
  });

  it("round-trips exact next and previous links", async () => {
    const first = await request("/v1/items?limit=5");
    expect(first.headers.get("Link")).toBe(
      '</v1/items?limit=5&cursor=aXRlbTppdGVtLTAwNQ>; rel="next", </schemas/ItemList.json>; rel="describedBy"',
    );

    const second = await request("/v1/items?limit=5&cursor=aXRlbTppdGVtLTAwNQ");
    const body = await jsonObject(second);
    const items = body.items as Array<{ id: string }>;
    expect(items.map((item) => item.id)).toEqual([
      "item-006",
      "item-007",
      "item-008",
      "item-009",
      "item-010",
    ]);
    expect(second.headers.get("Link")).toBe(
      '</v1/items?limit=5&cursor=aXRlbTppdGVtLTAxMA>; rel="next", </v1/items?limit=5>; rel="prev", </schemas/ItemList.json>; rel="describedBy"',
    );
  });

  it.each([
    ["electronics", 13],
    ["tools", 6],
    ["accessories", 4],
    ["robotics", 2],
    ["power", 2],
    ["components", 3],
  ])("filters %s before pagination with total %i", async (category, total) => {
    const response = await request(`/v1/items?category=${category}&limit=100`);
    const body = await jsonObject(response);

    expect(response.status).toBe(200);
    expect(body.total).toBe(total);
    expect(body.items).toHaveLength(total);
    expect(response.headers.get("Link")).toBe('</schemas/ItemList.json>; rel="describedBy"');
  });

  it("locates a cursor inside the filtered sequence", async () => {
    const response = await request(
      "/v1/items?category=electronics&limit=3&cursor=aXRlbTppdGVtLTAwNQ",
    );
    const body = await jsonObject(response);
    const items = body.items as Array<{ id: string }>;

    expect(items.map((item) => item.id)).toEqual(["item-008", "item-009", "item-010"]);
    expect(body.total).toBe(13);
  });

  it("accepts legal terminal cursor padding", async () => {
    const response = await request("/v1/items?limit=2&cursor=aXRlbTppdGVtLTAwNQ%3D%3D");
    const body = await jsonObject(response);
    const items = body.items as Array<{ id: string }>;

    expect(response.status).toBe(200);
    expect(items.map((item) => item.id)).toEqual(["item-006", "item-007"]);
  });

  it("accepts a final-item cursor and emits only the usable previous/schema links", async () => {
    const response = await request("/v1/items?limit=20&cursor=aXRlbTppdGVtLTAzMA");
    const body = await jsonObject(response);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ items: [], total: 30 });
    expect(response.headers.get("Link")).toBe(
      '</v1/items?limit=20&cursor=aXRlbTppdGVtLTAxMA>; rel="prev", </schemas/ItemList.json>; rel="describedBy"',
    );
  });

  it.each(["%%%", "aXRlbTptaXNzaW5n", "b3RoZXI6aXRlbS0wMDE"])(
    "maps a malformed or semantically invalid cursor to a safe 400: %s",
    async (cursor) => {
      const response = await request(`/v1/items?cursor=${encodeURIComponent(cursor)}`);
      const body = await jsonObject(response);

      expect(response.status).toBe(400);
      expect(body).toMatchObject({ title: "Bad Request", status: 400, detail: "Invalid cursor" });
      expect(JSON.stringify(body)).not.toContain(cursor);
      expect(response.headers.get("Link")).toBe(
        '</schemas/ProblemResponse.json>; rel="describedBy"',
      );
    },
  );

  it("keeps query-shape failures as normalized 422 responses", async () => {
    const response = await request("/v1/items?limit=101&category=unknown");
    const body = await jsonObject(response);

    expect(response.status).toBe(422);
    expect(body.errors).toEqual([
      { location: "query.limit", message: "Limit must be at most 100" },
      { location: "query.category", message: "Invalid value" },
    ]);
  });

  it.each([
    ["%205%20", 200, 5],
    ["5.0", 200, 5],
    ["%2B5", 200, 5],
    ["01", 200, 1],
    ["1e1", 422, undefined],
    ["5.10", 422, undefined],
    ["", 422, undefined],
  ])("freezes reference integer query coercion for limit=%s", async (limit, status, count) => {
    const response = await request(`/v1/items?limit=${limit}`);

    expect(response.status).toBe(status);
    if (status === 200) {
      const body = await jsonObject(response);
      if (count === undefined) throw new Error("Successful query case requires an item count");
      expect(body.items).toHaveLength(count);
    } else {
      expect(await jsonObject(response)).toMatchObject({
        errors: [{ location: "query.limit", message: "Invalid value type" }],
      });
    }
  });
});

describe("documentation and standalone schemas", () => {
  it("serves HTML that references only the pinned same-origin assets", async () => {
    const response = await request("/api-docs", { headers: { Accept: "text/html" } });
    const html = await response.text();
    const references = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((match) => match[1] ?? "");
    const expected = [
      DOCS_ASSETS.favicon16,
      DOCS_ASSETS.favicon32,
      DOCS_ASSETS.stylesheet,
      DOCS_ASSETS.customStylesheet,
      DOCS_ASSETS.bundleScript,
      DOCS_ASSETS.initializerScript,
    ];

    expect(response.status).toBe(200);
    expect(html).toContain('<main id="swagger-ui"></main>');
    expect(references).toEqual(expect.arrayContaining(expected));
    expect(references).toHaveLength(expected.length);
    expect(references.every((reference) => reference.startsWith("/docs-assets/"))).toBe(true);
    expect(html).not.toMatch(/https?:\/\//i);
    for (const scriptBody of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      expect(scriptBody[1]?.trim()).toBe("");
    }
    expectSecurityHeaders(response, true);
  });

  it("negotiates docs and schema media types independently", async () => {
    const docs = await request("/api-docs", { headers: { Accept: "application/json" } });
    const schema = await request("/schemas/Greeting.json", {
      headers: { Accept: "application/json" },
    });

    expect(docs.status).toBe(406);
    expect(await docs.json()).toMatchObject({
      status: 406,
      detail: "Supported response formats: text/html",
    });
    expect(schema.status).toBe(406);
    expect(await schema.json()).toMatchObject({
      status: 406,
      detail: "Supported response formats: application/schema+json",
    });
  });

  it.each(["/schemas/Greeting", "/schemas/Greeting.json"])(
    "serves the standalone Greeting schema through %s",
    async (path) => {
      const response = await request(path, {
        headers: { Accept: "application/schema+json" },
      });
      const schema = await jsonObject(response);

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/schema+json");
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(response.headers.get("Link")).toBe('</schemas/Greeting.json>; rel="describedBy"');
    },
  );

  it("negotiates before checking whether a schema exists", async () => {
    const response = await request("/schemas/UnknownSchema.json", {
      headers: { Accept: "application/json" },
    });

    expect(response.status).toBe(406);
  });

  it.each([
    ["/schemas/UnknownSchema.json", "Schema not found"],
    ["/schemas/greeting.json", "Schema not found"],
    ["/schemas/Bad-Name.json", "Schema not found"],
  ])("returns a safe 404 for an unknown or invalid schema name: %s", async (path, detail) => {
    const response = await request(path);
    const body = await jsonObject(response);

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ title: "Not Found", status: 404, detail });
    expect(response.headers.get("Link")).toBe('</schemas/ProblemResponse.json>; rel="describedBy"');
  });
});

const getOpenApiDocument = async (
  bindings: RuntimeBindings = TEST_BINDINGS,
): Promise<JsonObject> => {
  const response = await request("/openapi.json", {}, bindings);
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  return jsonObject(response);
};

const operationEntries = (document: JsonObject): Array<[string, string, JsonObject]> => {
  const paths = object(document.paths, "OpenAPI paths");
  const entries: Array<[string, string, JsonObject]> = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = object(pathValue, `path ${path}`);
    for (const method of ["get", "post", "patch", "delete"]) {
      if (Object.hasOwn(pathItem, method)) {
        entries.push([path, method, object(pathItem[method], `${method} ${path}`)]);
      }
    }
  }
  return entries;
};

const pathGraphWithoutSecurity = (document: JsonObject): JsonObject => {
  const paths = object(structuredClone(document.paths), "cloned OpenAPI paths");
  for (const [, , operation] of operationEntries({ paths })) {
    Reflect.deleteProperty(operation, "security");
  }
  return paths;
};

describe("OpenAPI deployment profiles", () => {
  it("publishes exactly the eight documented API operations and schema set", async () => {
    const document = await getOpenApiDocument();
    const paths = object(document.paths, "OpenAPI paths");
    const components = object(document.components, "OpenAPI components");
    const schemas = object(components.schemas, "OpenAPI schemas");
    const operations = operationEntries(document);

    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toEqual({ title: "Hono Playground", version: "0.1.0" });
    expect(document.servers).toEqual([{ url: "/" }]);
    expect(Object.keys(paths).sort()).toEqual(["/health", "/v1/hello", "/v1/items", "/v1/profile"]);
    expect(operations).toHaveLength(8);
    expect(operations.map(([, , operation]) => operation.operationId).sort()).toEqual([
      "health_get",
      "hello_create",
      "hello_get",
      "items_list",
      "profile_create",
      "profile_delete",
      "profile_get",
      "profile_update",
    ]);
    expect(Object.keys(schemas).sort()).toEqual([...STANDALONE_SCHEMA_NAMES].sort());
    expect(JSON.stringify(document).toLowerCase()).not.toContain("application/cbor");
    expect(JSON.stringify(document).toLowerCase()).not.toContain("cf-access-jwt-assertion");
  });

  it("publishes literal method, limiter, authentication, and dependency response headers", async () => {
    const document = await getOpenApiDocument();
    for (const [path, method, operation] of operationEntries(document)) {
      const responses = object(operation.responses, `${method} ${path} responses`);
      const methodHeaders = object(
        object(responses["405"], `${method} ${path} 405`).headers,
        `${method} ${path} 405 headers`,
      );
      const rateHeaders = object(
        object(responses["429"], `${method} ${path} 429`).headers,
        `${method} ${path} 429 headers`,
      );
      expect(methodHeaders).toHaveProperty("Allow");
      expect(rateHeaders).toHaveProperty("Retry-After");

      if (path === "/v1/profile") {
        const authenticationHeaders = object(
          object(responses["401"], `${method} ${path} 401`).headers,
          `${method} ${path} 401 headers`,
        );
        const dependencyHeaders = object(
          object(responses["503"], `${method} ${path} 503`).headers,
          `${method} ${path} 503 headers`,
        );
        expect(authenticationHeaders).toHaveProperty("WWW-Authenticate");
        expect(dependencyHeaders).toHaveProperty("Retry-After");
      }
    }
  });

  it("places cookie-only Access security at the workers.dev document root", async () => {
    const document = await getOpenApiDocument();
    const components = object(document.components, "OpenAPI components");
    const schemes = object(components.securitySchemes, "OpenAPI security schemes");

    expect(document["x-cloudflare-deployment-profile"]).toBe("workers-dev-demo");
    expect(document["x-cloudflare-edge-access-scope"]).toBe("worker");
    expect(document["x-cloudflare-rate-limit-mode"]).toBe("workers-binding");
    expect(document.security).toEqual([{ CloudflareAccessCookie: [] }]);
    expect(schemes.CloudflareAccessCookie).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "CF_Authorization",
    });
    expect(schemes).not.toHaveProperty("CloudflareAccessOAuth");
    for (const [, , operation] of operationEntries(document)) {
      expect(operation).not.toHaveProperty("security");
    }
  });

  it("places cookie/OAuth alternatives only on custom-domain profile operations", async () => {
    const document = await getOpenApiDocument(CUSTOM_DOMAIN_BINDINGS);
    const components = object(document.components, "OpenAPI components");
    const schemes = object(components.securitySchemes, "OpenAPI security schemes");
    const oauth = object(schemes.CloudflareAccessOAuth, "Managed OAuth scheme");

    expect(document["x-cloudflare-deployment-profile"]).toBe("custom-domain-production");
    expect(document["x-cloudflare-edge-access-scope"]).toBe("profile-path");
    expect(document["x-cloudflare-rate-limit-mode"]).toBe("workers-binding+waf");
    expect(document).not.toHaveProperty("security");
    expect(oauth).toMatchObject({
      type: "http",
      scheme: "bearer",
      "x-cloudflare-managed-oauth": true,
    });
    expect(oauth.description).toEqual(expect.stringMatching(/opaque/i));
    expect(oauth.description).toEqual(expect.stringContaining("user-based"));
    expect(oauth.description).toEqual(expect.stringContaining("WWW-Authenticate"));

    for (const [path, , operation] of operationEntries(document)) {
      if (path === "/v1/profile") {
        expect(operation.security).toEqual([
          { CloudflareAccessCookie: [] },
          { CloudflareAccessOAuth: [] },
        ]);
      } else {
        expect(operation).not.toHaveProperty("security");
      }
    }
  });

  it("keeps the path and schema graph identical across deployment profiles", async () => {
    const workersDev = await getOpenApiDocument();
    const customDomain = await getOpenApiDocument(CUSTOM_DOMAIN_BINDINGS);
    const workersComponents = object(workersDev.components, "workers.dev components");
    const customComponents = object(customDomain.components, "custom-domain components");

    expect(pathGraphWithoutSecurity(workersDev)).toEqual(pathGraphWithoutSecurity(customDomain));
    expect(workersComponents.schemas).toEqual(customComponents.schemas);
  });
});
