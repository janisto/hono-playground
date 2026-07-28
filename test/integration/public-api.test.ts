import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.ts";
import type { RuntimeBindings } from "../../src/core/types.ts";
import { JSON_API_MEDIA_TYPE } from "../../src/models/json-api.ts";

const ORIGIN = "https://api.example.test";
const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  RATE_LIMIT_MODE: "none",
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

const request = (path: string, init: RequestInit = {}, bindings: RuntimeBindings = TEST_BINDINGS): Promise<Response> =>
  Promise.resolve(app.request(new Request(`${ORIGIN}${path}`, init), undefined, bindings));

interface JsonObject {
  [key: string]: unknown;
  readonly CloudflareAccess?: unknown;
  readonly components?: unknown;
  readonly info?: unknown;
  readonly headers?: unknown;
  readonly JsonApiRequestLinkObject?: unknown;
  readonly JsonApiRequestLinks?: unknown;
  readonly JsonApiRequestObject?: unknown;
  readonly openapi?: unknown;
  readonly operationId?: unknown;
  readonly paths?: unknown;
  readonly responses?: unknown;
  readonly schemas?: unknown;
  readonly security?: unknown;
  readonly securitySchemes?: unknown;
  readonly servers?: unknown;
}

type ItemResource = {
  type: "items";
  id: string;
  attributes: {
    name: string;
    category: string;
    priceCents: number;
    inStock: boolean;
    createdAt: string;
    description: string;
  };
  links: { self: string };
};

type ItemCollectionDocument = {
  jsonapi: { version: "1.1" };
  links: {
    self: string;
    next?: string;
    prev?: string;
  };
  data: ItemResource[];
  meta: { total: number };
};

type JsonApiErrorDocument = {
  jsonapi: { version: "1.1" };
  errors: Array<{
    status: string;
    code: string;
    title: string;
    detail: string;
    source?: { pointer?: string; parameter?: string; header?: string };
  }>;
};

const object = (value: unknown, label: string): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
};

const jsonObject = async (response: Response): Promise<JsonObject> => object(await response.json(), "JSON response");

const itemCollection = async (response: Response): Promise<ItemCollectionDocument> =>
  (await response.json()) as ItemCollectionDocument;

const expectJsonApiError = async (
  response: Response,
  expected: {
    status: number;
    code: string;
    detail?: string;
    source?: { pointer?: string; parameter?: string; header?: string };
  },
): Promise<JsonApiErrorDocument> => {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
  const document = (await response.json()) as JsonApiErrorDocument;
  expect(document.jsonapi).toEqual({ version: "1.1" });
  expect(document.errors[0]).toMatchObject({
    status: String(expected.status),
    code: expected.code,
    ...(expected.detail === undefined ? {} : { detail: expected.detail }),
    ...(expected.source === undefined ? {} : { source: expected.source }),
  });
  return document;
};

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
    expect(csp).toContain("script-src 'sha256-");
    expect(csp).toContain("'sha384-");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
  } else {
    expect(csp).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  }
  expectNoCors(response);
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public response contract", () => {
  it.each([
    {
      label: "health",
      path: "/health",
      accept: "application/json",
      contentType: "application/json",
      documentation: false,
    },
    {
      label: "items",
      path: "/v1/items?page%5Blimit%5D=100",
      accept: JSON_API_MEDIA_TYPE,
      contentType: JSON_API_MEDIA_TYPE,
      documentation: false,
    },
    {
      label: "item",
      path: "/v1/items/item-001",
      accept: JSON_API_MEDIA_TYPE,
      contentType: JSON_API_MEDIA_TYPE,
      documentation: false,
    },
    {
      label: "OpenAPI",
      path: "/openapi.json",
      accept: "application/json",
      contentType: "application/json",
      documentation: false,
    },
    {
      label: "documentation HTML",
      path: "/api-docs",
      accept: "text/html",
      contentType: "text/html",
      documentation: true,
    },
  ])("applies common security policy and no CORS to $label", async (contract) => {
    const response = await request(contract.path, {
      headers: { Accept: contract.accept },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(contract.contentType);
    expect(response.headers.get("Vary")).toBe("Accept");
    expectSecurityHeaders(response, contract.documentation);
    expect(response.headers.has("Link")).toBe(false);
  });

  it("keeps operational health outside JSON:API", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "healthy" });
    expect(response.headers.get("Content-Type")).toContain("application/json");
  });
});

describe("items JSON:API", () => {
  it("returns a resource collection with camelCase attributes and integer cents", async () => {
    const response = await request("/v1/items", {
      headers: { Accept: JSON_API_MEDIA_TYPE, Host: "attacker.invalid" },
    });
    const document = await itemCollection(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
    expect(document.jsonapi).toEqual({ version: "1.1" });
    expect(document.meta).toEqual({ total: 30 });
    expect(document.data).toHaveLength(20);
    expect(document.data[0]).toMatchObject({
      type: "items",
      id: "item-001",
      attributes: {
        category: "electronics",
        priceCents: expect.any(Number),
        inStock: expect.any(Boolean),
        createdAt: expect.stringMatching(/Z$/),
      },
      links: { self: "/v1/items/item-001" },
    });
    expect(Number.isInteger(document.data[0]?.attributes.priceCents)).toBe(true);
    expect(document.data.at(-1)?.id).toBe("item-020");
    expect(document.links).toEqual({
      self: "/v1/items?page%5Blimit%5D=20",
      next: "/v1/items?page%5Blimit%5D=20&page%5Bcursor%5D=aXRlbTppdGVtLTAyMA",
    });
    expect(JSON.stringify(document.links)).not.toContain("attacker.invalid");
  });

  it("returns an individual item and a safe missing-resource error", async () => {
    const found = await request("/v1/items/item-001");
    const foundDocument = (await found.json()) as { data: ItemResource };
    const missing = await request("/v1/items/not-present");

    expect(found.status).toBe(200);
    expect(foundDocument.data).toMatchObject({
      type: "items",
      id: "item-001",
      links: { self: "/v1/items/item-001" },
    });
    await expectJsonApiError(missing, {
      status: 404,
      code: "not_found",
      detail: "Item not found",
    });
  });

  it.each([
    ["page[limit]", "/v1/items?page%5Blimit%5D=2&page%5Blimit%5D=3", "page[limit]"],
    ["filter[category]", "/v1/items?filter%5Bcategory%5D=tools&filter%5Bcategory%5D=electronics", "filter[category]"],
    [
      "page[cursor]",
      "/v1/items?page%5Bcursor%5D=aXRlbTppdGVtLTAwMQ&page%5Bcursor%5D=aXRlbTppdGVtLTAwMg",
      "page[cursor]",
    ],
  ])("rejects a repeated singleton %s instead of choosing one value", async (_name, path, source) => {
    const response = await request(path);

    await expectJsonApiError(response, {
      status: 400,
      code: "invalid_query_parameter",
      source: { parameter: source },
    });
  });

  it("rejects an explicit empty cursor instead of aliasing the first page", async () => {
    const response = await request("/v1/items?page%5Bcursor%5D=");

    await expectJsonApiError(response, {
      status: 400,
      code: "invalid_query_parameter",
      source: { parameter: "page[cursor]" },
    });
  });

  it("round-trips exact next and previous document links", async () => {
    const first = await request("/v1/items?page%5Blimit%5D=5");
    const firstDocument = await itemCollection(first);
    expect(firstDocument.links.next).toBe("/v1/items?page%5Blimit%5D=5&page%5Bcursor%5D=aXRlbTppdGVtLTAwNQ");

    const second = await request(firstDocument.links.next ?? "missing");
    const secondDocument = await itemCollection(second);
    expect(secondDocument.data.map((item) => item.id)).toEqual([
      "item-006",
      "item-007",
      "item-008",
      "item-009",
      "item-010",
    ]);
    expect(secondDocument.links).toMatchObject({
      self: "/v1/items?page%5Blimit%5D=5&page%5Bcursor%5D=aXRlbTppdGVtLTAwNQ",
      next: "/v1/items?page%5Blimit%5D=5&page%5Bcursor%5D=aXRlbTppdGVtLTAxMA",
      prev: "/v1/items?page%5Blimit%5D=5",
    });
  });

  it.each([
    ["electronics", 13],
    ["tools", 6],
    ["accessories", 4],
    ["robotics", 2],
    ["power", 2],
    ["components", 3],
  ])("filters %s before pagination with total %i", async (category, total) => {
    const response = await request(`/v1/items?filter%5Bcategory%5D=${category}&page%5Blimit%5D=100`);
    const document = await itemCollection(response);

    expect(response.status).toBe(200);
    expect(document.meta.total).toBe(total);
    expect(document.data).toHaveLength(total);
    expect(document.data.every((item) => item.attributes.category === category)).toBe(true);
    expect(document.links.next).toBeUndefined();
    expect(document.links.prev).toBeUndefined();
  });

  it("locates a cursor inside a filtered sequence", async () => {
    const response = await request(
      "/v1/items?filter%5Bcategory%5D=electronics&page%5Blimit%5D=3&page%5Bcursor%5D=aXRlbTppdGVtLTAwNQ",
    );
    const document = await itemCollection(response);

    expect(document.data.map((item) => item.id)).toEqual(["item-008", "item-009", "item-010"]);
    expect(document.meta.total).toBe(13);
  });

  it("accepts legal terminal base64url padding and an empty terminal page", async () => {
    const padded = await request("/v1/items?page%5Blimit%5D=2&page%5Bcursor%5D=aXRlbTppdGVtLTAwNQ%3D%3D");
    const paddedDocument = await itemCollection(padded);
    expect(padded.status).toBe(200);
    expect(paddedDocument.data.map((item) => item.id)).toEqual(["item-006", "item-007"]);

    const terminal = await request("/v1/items?page%5Blimit%5D=20&page%5Bcursor%5D=aXRlbTppdGVtLTAzMA");
    const terminalDocument = await itemCollection(terminal);
    expect(terminal.status).toBe(200);
    expect(terminalDocument.data).toEqual([]);
    expect(terminalDocument.meta).toEqual({ total: 30 });
    expect(terminalDocument.links.next).toBeUndefined();
    expect(terminalDocument.links.prev).toBe("/v1/items?page%5Blimit%5D=20&page%5Bcursor%5D=aXRlbTppdGVtLTAxMA");
  });

  it.each(["%%%", "aXRlbTptaXNzaW5n", "b3RoZXI6aXRlbS0wMDE"])(
    "maps an invalid cursor to a safe JSON:API 400: %s",
    async (cursor) => {
      const response = await request(`/v1/items?page%5Bcursor%5D=${encodeURIComponent(cursor)}`);
      const document = await expectJsonApiError(response, {
        status: 400,
        code: "invalid_cursor",
        detail: "Invalid cursor",
      });

      expect(JSON.stringify(document)).not.toContain(cursor);
    },
  );

  it("rejects unknown query parameters as required by JSON:API", async () => {
    const response = await request("/v1/items?unknown=sensitive-marker");
    const document = await expectJsonApiError(response, {
      status: 400,
      code: "invalid_query_parameter",
      source: { parameter: "unknown" },
    });

    expect(JSON.stringify(document)).not.toContain("sensitive-marker");
  });

  it("rejects unknown query parameters on an individual resource", async () => {
    const response = await request("/v1/items/item-001?unknown=sensitive-marker");
    const document = await expectJsonApiError(response, {
      status: 400,
      code: "invalid_query_parameter",
      source: { parameter: "unknown" },
    });

    expect(JSON.stringify(document)).not.toContain("sensitive-marker");
  });

  it("reports every invalid supported query parameter without echoing values", async () => {
    const response = await request("/v1/items?page%5Blimit%5D=101&filter%5Bcategory%5D=unknown");
    const document = await expectJsonApiError(response, {
      status: 400,
      code: "invalid_query_parameter",
    });

    expect(document.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: { parameter: "page[limit]" } }),
        expect.objectContaining({ source: { parameter: "filter[category]" } }),
      ]),
    );
    expect(JSON.stringify(document)).not.toContain("unknown");
  });

  it.each([
    ["5", 200, 5],
    ["01", 200, 1],
    ["%205%20", 400, undefined],
    ["5.0", 400, undefined],
    ["%2B5", 400, undefined],
    ["1e1", 400, undefined],
    ["", 400, undefined],
  ])("uses exact positive-integer syntax for page[limit]=%s", async (limit, status, count) => {
    const response = await request(`/v1/items?page%5Blimit%5D=${limit}`);

    expect(response.status).toBe(status);
    if (status === 200) {
      const document = await itemCollection(response);
      if (count === undefined) throw new Error("Successful pagination case requires a count");
      expect(document.data).toHaveLength(count);
    } else {
      await expectJsonApiError(response, {
        status: 400,
        code: "invalid_query_parameter",
        source: { parameter: "page[limit]" },
      });
    }
  });
});

describe("API documentation", () => {
  it("serves the official Hono Swagger UI against the canonical OpenAPI document", async () => {
    const response = await request("/api-docs", { headers: { Accept: "text/html" } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<div id="swagger-ui"></div>');
    expect(html).toContain("swagger-ui-dist@5.32.11/swagger-ui.css");
    expect(html).toContain("swagger-ui-dist@5.32.11/swagger-ui-bundle.js");
    expect(html).toContain('integrity="sha384-9Q2fpS+xeS4ffJy6CagnwoUl+4ldAYhOs9pgZuEKxypVModhmZFzeMlvVsAjf7uT"');
    expect(html).toContain('integrity="sha384-vfl/klfTFrIz5urj0HnhcXLAbzPdRHezizfy+XgFB6GqcKkhlk0lS3bIbyB39NLA"');
    expect(html).toContain('url: "/openapi.json"');
    expect(html).toContain("supportedSubmitMethods: []");
    expect(html).toContain('validatorUrl: "none"');
    expectSecurityHeaders(response, true);
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(csp).not.toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net/u);
  });

  it("rejects a representation that cannot carry the documentation HTML", async () => {
    const response = await request("/api-docs", { headers: { Accept: "application/json" } });

    expect(response.status).toBe(406);
    expect(await response.json()).toMatchObject({
      status: 406,
      detail: "Supported response format: text/html",
    });
  });
});

const getOpenApiDocument = async (): Promise<JsonObject> => {
  const response = await request("/openapi.json");
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

describe("OpenAPI 3.1 contract", () => {
  it("publishes exactly the seven implemented operations from the route registry", async () => {
    const document = await getOpenApiDocument();
    const paths = object(document.paths, "OpenAPI paths");
    const components = object(document.components, "OpenAPI components");
    const schemas = object(components.schemas, "OpenAPI schemas");
    const { JsonApiMeta: jsonApiMeta } = schemas;
    const operations = operationEntries(document);

    expect(document.openapi).toBe("3.1.0");
    expect(document.info).toMatchObject({ title: "Hono Playground", version: "0.1.0" });
    expect(document.servers).toEqual([{ url: "/" }]);
    expect(Object.keys(paths).sort()).toEqual([
      "/health",
      "/v1/items",
      "/v1/items/{itemId}",
      "/v1/profiles",
      "/v1/profiles/current",
    ]);
    expect(operations).toHaveLength(7);
    expect(operations.map(([, , operation]) => operation.operationId).sort()).toEqual([
      "createProfile",
      "deleteCurrentProfile",
      "getCurrentProfile",
      "getHealth",
      "getItem",
      "listItems",
      "updateCurrentProfile",
    ]);
    expect(schemas).toHaveProperty("ProfileDocument");
    expect(schemas).toHaveProperty("ItemCollectionDocument");
    expect(schemas).toHaveProperty("JsonApiErrorDocument");
    expect(schemas.JsonApiRequestObject).toMatchObject({
      type: "object",
      properties: {
        version: { type: "string" },
        profile: {
          type: "array",
          items: { type: "string", format: "uri" },
        },
      },
      additionalProperties: false,
    });
    expect(schemas.JsonApiRequestLinks).toMatchObject({
      type: "object",
      propertyNames: {
        type: "string",
        pattern: "^[a-z][A-Za-z0-9]*$",
      },
      additionalProperties: { $ref: "#/components/schemas/JsonApiRequestLink" },
    });
    expect(jsonApiMeta).toMatchObject({
      type: "object",
      propertyNames: {
        type: "string",
        pattern: "^[a-z][A-Za-z0-9]*$",
      },
    });
    expect(schemas.JsonApiRequestLinkObject).toMatchObject({
      type: "object",
      properties: {
        describedby: {
          oneOf: [{ $ref: "#/components/schemas/JsonApiRequestLink" }, { type: "null" }],
        },
        rel: {
          anyOf: [
            { type: "string", pattern: "^[a-z][a-z0-9.-]*$" },
            { type: "string", format: "uri" },
          ],
        },
        type: {
          type: "string",
          description: "Media type",
          pattern: expect.stringContaining("/"),
        },
        hreflang: {
          anyOf: [
            {
              type: "string",
              description: "Well-formed RFC 5646 language tag",
              pattern: expect.stringContaining("[A-Za-z]{2,3}"),
            },
            {
              type: "array",
              minItems: 1,
              items: {
                type: "string",
                description: "Well-formed RFC 5646 language tag",
                pattern: expect.stringContaining("[A-Za-z]{2,3}"),
              },
            },
          ],
        },
      },
    });
    expect(JSON.stringify(document).toLowerCase()).not.toContain("application/cbor");
    expect(JSON.stringify(document).toLowerCase()).not.toContain("cf-access-jwt-assertion");
    expect(JSON.stringify(document)).toContain(JSON_API_MEDIA_TYPE);
  });

  it("publishes literal method and rate-limit headers on every operation", async () => {
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

      if (path.startsWith("/v1/profiles")) {
        const dependencyHeaders = object(
          object(responses["503"], `${method} ${path} 503`).headers,
          `${method} ${path} 503 headers`,
        );
        expect(responses["403"]).toBeDefined();
        expect(responses["401"]).toBeUndefined();
        expect(dependencyHeaders).toHaveProperty("Retry-After");
      }
    }
  });

  it("documents Cloudflare Access only on protected profile operations", async () => {
    const document = await getOpenApiDocument();
    const components = object(document.components, "OpenAPI components");
    const schemes = object(components.securitySchemes, "OpenAPI security schemes");

    expect(schemes.CloudflareAccess).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "CF_Authorization",
    });
    expect(document).not.toHaveProperty("security");

    for (const [path, , operation] of operationEntries(document)) {
      if (path.startsWith("/v1/profiles")) {
        expect(operation.security).toEqual([{ CloudflareAccess: [] }]);
      } else {
        expect(operation).not.toHaveProperty("security");
      }
    }
  });
});
