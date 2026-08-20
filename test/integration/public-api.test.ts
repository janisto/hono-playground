import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.ts";
import type { RuntimeBindings } from "../../src/core/types.ts";
import { JSON_API_MEDIA_TYPE } from "../../src/models/json-api.ts";
import { encodeCursor } from "../../src/pagination/cursor.ts";

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
const request = (path: string, init: RequestInit = {}): Promise<Response> =>
  Promise.resolve(app.request(new Request(`${ORIGIN}${path}`, init), undefined, TEST_BINDINGS));

type JsonObject = Record<string, unknown>;

type ItemResource = {
  type: "items";
  id: string;
  attributes: {
    name: string;
    category: string;
    price: { amountMinor: number; currency: "USD" };
    inStock: boolean;
    createdAt: string;
    description: string;
  };
};

type ItemCollectionDocument = {
  jsonapi: { version: "1.1" };
  links: { self: string; next?: string; prev?: string };
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

const itemCollection = async (response: Response): Promise<ItemCollectionDocument> =>
  (await response.json()) as ItemCollectionDocument;

const expectJsonApiError = async (
  response: Response,
  expected: { status: number; code: string; source?: { parameter: string } },
): Promise<JsonApiErrorDocument> => {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
  const document = (await response.json()) as JsonApiErrorDocument;
  expect(document.jsonapi).toEqual({ version: "1.1" });
  expect(document.errors).toHaveLength(1);
  expect(document.errors[0]).toMatchObject({
    status: String(expected.status),
    code: expected.code,
    ...(expected.source === undefined ? {} : { source: expected.source }),
  });
  return document;
};

const expectSecurityHeaders = (response: Response, documentation = false): void => {
  expect(response.headers.get("X-Request-ID")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(response.headers.get("Permissions-Policy")).toContain("geolocation=()");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.has("Strict-Transport-Security")).toBe(false);
  const csp = response.headers.get("Content-Security-Policy") ?? "";
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
  for (const header of CORS_HEADERS) expect(response.headers.has(header)).toBe(false);
};

const relationTarget = (header: string | null, relation: "next" | "prev"): string | undefined => {
  if (header === null) return undefined;
  const match = new RegExp(`<([^>]+)>; rel="${relation}"`, "u").exec(header);
  return match?.[1];
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("portable health and hello operations", () => {
  it.each([
    ["/health", "application/json", false],
    ["/v1/hello", "application/json", false],
    ["/v1/items", JSON_API_MEDIA_TYPE, false],
    ["/openapi.json", "application/json", false],
    ["/api-docs", "text/html", true],
  ] as const)("applies the common response policy to GET %s", async (path, mediaType, documentation) => {
    const response = await request(path, { headers: { Accept: mediaType } });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(mediaType);
    expect(response.headers.get("Vary")).toBe("Accept");
    expectSecurityHeaders(response, documentation);
  });

  it("returns the exact dependency-free health and world greeting objects", async () => {
    const [health, hello] = await Promise.all([request("/health"), request("/v1/hello")]);

    await expect(health.json()).resolves.toEqual({ status: "healthy" });
    await expect(hello.json()).resolves.toEqual({ message: "Hello, World!" });
  });

  it("creates a greeting from strict plain JSON without resource semantics", async () => {
    const response = await request("/v1/hello", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json;charset=UTF-8" },
      body: JSON.stringify({ name: "Ada" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.has("Location")).toBe(false);
    await expect(response.json()).resolves.toEqual({ message: "Hello, Ada!" });
  });

  it.each([
    ["unknown member", JSON.stringify({ name: "Ada", language: "en" }), 422],
    ["whitespace-bounded name", JSON.stringify({ name: " Ada " }), 422],
    ["malformed JSON", '{"name":', 400],
    ["duplicate member", '{"name":"Ada","name":"Grace"}', 400],
  ])("rejects %s at the real hello boundary", async (_case, body, status) => {
    const response = await request("/v1/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      status,
      code: status === 400 ? "invalid_request" : "validation_failed",
    });
  });

  it("ignores representation fields on the body-free GET", async () => {
    const response = await request("/v1/hello", {
      method: "GET",
      headers: { "Content-Encoding": "gzip", "Content-Type": "text/plain" },
    });

    expect(response.status).toBe(200);
  });
});

describe("items JSON:API and cursor navigation", () => {
  it("returns the exact portable item projection and no undocumented detail link", async () => {
    const response = await request("/v1/items", {
      headers: { Accept: JSON_API_MEDIA_TYPE, Host: "attacker.invalid" },
    });
    const document = await itemCollection(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
    expect(document.jsonapi).toEqual({ version: "1.1" });
    expect(document.meta).toEqual({ total: 30 });
    expect(document.data).toHaveLength(20);
    expect(document.data[0]).toEqual({
      type: "items",
      id: "item-001",
      attributes: {
        name: "Alpha Widget",
        category: "electronics",
        price: { amountMinor: 2999, currency: "USD" },
        inStock: true,
        createdAt: "2024-01-15T10:30:00.000Z",
        description: "A versatile electronic widget for everyday use",
      },
    });
    expect(document.data.at(-1)?.id).toBe("item-020");
    expect(JSON.stringify(document.links)).not.toContain("attacker.invalid");
    expect(relationTarget(response.headers.get("Link"), "next")).toBe(document.links.next);
    expect(document.links.prev).toBeUndefined();
  });

  it("traverses three pages forward and backward without duplicates or skips", async () => {
    const forward: ItemCollectionDocument[] = [];
    let target = "/v1/items?page%5Blimit%5D=10";
    for (let index = 0; index < 3; index += 1) {
      const response = await request(target);
      const document = await itemCollection(response);
      expect(response.status).toBe(200);
      expect(relationTarget(response.headers.get("Link"), "next")).toBe(document.links.next);
      expect(relationTarget(response.headers.get("Link"), "prev")).toBe(document.links.prev);
      forward.push(document);
      target = document.links.next ?? "";
    }
    expect(forward.flatMap((document) => document.data.map((item) => item.id))).toEqual(
      Array.from({ length: 30 }, (_, index) => `item-${String(index + 1).padStart(3, "0")}`),
    );
    expect(forward[2]?.links.next).toBeUndefined();

    const secondBack = await itemCollection(await request(forward[2]?.links.prev ?? ""));
    const firstBack = await itemCollection(await request(secondBack.links.prev ?? ""));
    expect(secondBack.data.map((item) => item.id)).toEqual(forward[1]?.data.map((item) => item.id));
    expect(firstBack.data.map((item) => item.id)).toEqual(forward[0]?.data.map((item) => item.id));
    expect(firstBack.links.prev).toBeUndefined();
  });

  it.each([
    [
      "electronics",
      [
        "item-001",
        "item-002",
        "item-004",
        "item-005",
        "item-008",
        "item-009",
        "item-010",
        "item-015",
        "item-016",
        "item-025",
        "item-026",
        "item-028",
        "item-029",
      ],
    ],
    ["tools", ["item-003", "item-021", "item-022", "item-023", "item-024", "item-027"]],
    ["accessories", ["item-006", "item-007", "item-020", "item-030"]],
    ["robotics", ["item-011", "item-012"]],
    ["power", ["item-013", "item-014"]],
    ["components", ["item-017", "item-018", "item-019"]],
  ])("filters %s before pagination", async (category, ids) => {
    const document = await itemCollection(
      await request(`/v1/items?filter%5Bcategory%5D=${category}&page%5Blimit%5D=100`),
    );

    expect(document.data.map((item) => item.id)).toEqual(ids);
    expect(document.meta.total).toBe(ids.length);
    expect(document.links.next).toBeUndefined();
    expect(document.links.prev).toBeUndefined();
  });

  it.each([
    ["unknown", "/v1/items?attacker=sensitive", undefined],
    ["repeated limit", "/v1/items?page%5Blimit%5D=2&page%5Blimit%5D=3", "page[limit]"],
    ["repeated cursor", "/v1/items?page%5Bcursor%5D=a&page%5Bcursor%5D=b", "page[cursor]"],
    ["empty cursor", "/v1/items?page%5Bcursor%5D=", "page[cursor]"],
    ["malformed percent", "/v1/items?page%5Bcursor%5D=%", undefined],
    ["invalid UTF-8", "/v1/items?page%5Bcursor%5D=%C3%28", undefined],
  ])("maps parser-controlled %s input to source-safe 400", async (_case, path, parameter) => {
    const response = await request(path);
    const document = await expectJsonApiError(response, {
      status: 400,
      code: "invalid_request",
      ...(parameter === undefined ? {} : { source: { parameter } }),
    });

    if (parameter === undefined) expect(document.errors[0]).not.toHaveProperty("source");
    expect(JSON.stringify(document)).not.toContain("sensitive");
  });

  it.each(["0", "101", "9007199254740992", "%205%20", "5.0", "%2B5", "1e1", ""])(
    "maps typed page[limit]=%s input to 422",
    async (limit) => {
      const response = await request(`/v1/items?page%5Blimit%5D=${limit}`);

      expect(response.status).toBe(422);
      const document = (await response.json()) as JsonApiErrorDocument;
      expect(document.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "validation_failed", source: { parameter: "page[limit]" } }),
        ]),
      );
    },
  );

  it("rejects malformed, noncanonical, wrong-scope, stale, and impossible cursor state", async () => {
    const states = [
      "%%%",
      `${encodeCursor({ version: 1, operation: "listItems", direction: "next", limit: 20, category: null, anchor: "item-020" })}=`,
      encodeCursor({
        version: 1,
        operation: "other",
        direction: "next",
        limit: 20,
        category: null,
        anchor: "item-020",
      }),
      encodeCursor({
        version: 1,
        operation: "listItems",
        direction: "sideways",
        limit: 20,
        category: null,
        anchor: "item-020",
      }),
      encodeCursor({
        version: 1,
        operation: "listItems",
        direction: "next",
        limit: 20,
        category: null,
        anchor: "missing",
      }),
      encodeCursor({
        version: 1,
        operation: "listItems",
        direction: "next",
        limit: 20,
        category: null,
        anchor: "item-030",
      }),
      encodeCursor({
        version: 1,
        operation: "listItems",
        direction: "prev",
        limit: 20,
        category: null,
        anchor: "item-001",
      }),
    ];
    for (const cursor of states) {
      const response = await request(`/v1/items?page%5Bcursor%5D=${encodeURIComponent(cursor)}`);
      await expectJsonApiError(response, {
        status: 400,
        code: "invalid_request",
        source: { parameter: "page[cursor]" },
      });
    }
  });

  it("binds an emitted cursor to its effective limit and filter", async () => {
    const first = await itemCollection(await request("/v1/items?page%5Blimit%5D=5"));
    const cursor = new URL(first.links.next ?? "", ORIGIN).searchParams.get("page[cursor]");
    if (cursor === null) throw new Error("missing emitted cursor");

    for (const path of [
      `/v1/items?page%5Blimit%5D=6&page%5Bcursor%5D=${encodeURIComponent(cursor)}`,
      `/v1/items?filter%5Bcategory%5D=electronics&page%5Blimit%5D=5&page%5Bcursor%5D=${encodeURIComponent(cursor)}`,
    ]) {
      await expectJsonApiError(await request(path), {
        status: 400,
        code: "invalid_request",
        source: { parameter: "page[cursor]" },
      });
    }
  });
});

describe("documentation UI", () => {
  it("serves pinned passive Swagger UI against the canonical document", async () => {
    const response = await request("/api-docs", { headers: { Accept: "text/html" } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('<div id="swagger-ui"></div>');
    expect(html).toContain("swagger-ui-dist@5.32.11/swagger-ui.css");
    expect(html).toContain("swagger-ui-dist@5.32.11/swagger-ui-bundle.js");
    expect(html).toContain('url: "/openapi.json"');
    expect(html).toContain("supportedSubmitMethods: []");
    expect(html).toContain('validatorUrl: "none"');
    expectSecurityHeaders(response, true);
  });

  it("rejects an unacceptable documentation representation with the stable problem", async () => {
    const response = await request("/api-docs", { headers: { Accept: "application/json" } });

    expect(response.status).toBe(406);
    await expect(response.json()).resolves.toEqual({
      type: "about:blank",
      title: "Not Acceptable",
      status: 406,
      detail: "No acceptable response representation is available",
      code: "not_acceptable",
    });
  });
});

const openApiDocument = async (): Promise<JsonObject> => {
  const response = await request("/openapi.json");
  expect(response.status, await response.clone().text()).toBe(200);
  return object(await response.json(), "OpenAPI document");
};

const operationEntries = (document: JsonObject): Array<[string, string, JsonObject]> => {
  const paths = object(document["paths"], "OpenAPI paths");
  const entries: Array<[string, string, JsonObject]> = [];
  for (const [path, pathValue] of Object.entries(paths)) {
    const pathItem = object(pathValue, `path ${path}`);
    for (const method of ["get", "post", "patch", "delete"]) {
      if (Object.hasOwn(pathItem, method)) entries.push([path, method, object(pathItem[method], `${method} ${path}`)]);
    }
  }
  return entries;
};

const resolveLocalRef = (document: JsonObject, ref: string): unknown => {
  if (!ref.startsWith("#/")) throw new TypeError(`non-local OpenAPI reference: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((value, segment) => object(value, ref)[segment], document);
};

const findObjects = (value: unknown, predicate: (candidate: JsonObject) => boolean): JsonObject[] => {
  const matches: JsonObject[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    const record = candidate as JsonObject;
    if (predicate(record)) matches.push(record);
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(value);
  return matches;
};

const visitRefs = (value: unknown, refs: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const entry of value) visitRefs(entry, refs);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string") refs.add(entry);
    else visitRefs(entry, refs);
  }
};

const collectPatterns = (value: unknown, patterns: string[]): void => {
  if (Array.isArray(value)) {
    for (const entry of value) collectPatterns(entry, patterns);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "pattern" && typeof entry === "string") patterns.push(entry);
    else collectPatterns(entry, patterns);
  }
};

const OPERATION_IDS = new Map([
  ["get /health", "getHealth"],
  ["get /v1/hello", "getHello"],
  ["post /v1/hello", "createHello"],
  ["get /v1/items", "listItems"],
  ["post /v1/profile", "createProfile"],
  ["get /v1/profile", "getProfile"],
  ["patch /v1/profile", "updateProfile"],
  ["delete /v1/profile", "deleteProfile"],
  ["get /v1/github/owners/{owner}", "getGitHubOwner"],
  ["get /v1/github/owners/{owner}/repos", "listGitHubOwnerRepositories"],
  ["get /v1/github/repos/{owner}/{repo}", "getGitHubRepository"],
  ["get /v1/github/repos/{owner}/{repo}/activity", "listGitHubRepositoryActivity"],
  ["get /v1/github/repos/{owner}/{repo}/languages", "listGitHubRepositoryLanguages"],
  ["get /v1/github/repos/{owner}/{repo}/tags", "listGitHubRepositoryTags"],
]);

const EXPECTED_STATUSES = new Map<string, string[]>([
  ["get /health", ["200", "400", "406", "500"]],
  ["get /v1/hello", ["200", "400", "406", "429", "500", "503"]],
  ["post /v1/hello", ["200", "400", "406", "413", "415", "422", "429", "500", "503"]],
  ["get /v1/items", ["200", "400", "406", "422", "429", "500", "503"]],
  ["post /v1/profile", ["201", "400", "403", "406", "409", "413", "415", "422", "429", "500", "503"]],
  ["get /v1/profile", ["200", "400", "403", "404", "406", "429", "500", "503"]],
  ["patch /v1/profile", ["200", "400", "403", "404", "406", "409", "413", "415", "422", "429", "500", "503"]],
  ["delete /v1/profile", ["204", "400", "403", "404", "429", "500", "503"]],
]);
const GITHUB_STATUSES = ["200", "400", "404", "406", "422", "429", "500", "502", "503", "504"];
const REQUIRED_HEADERS = [
  "X-Request-ID",
  "Cache-Control",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Vary",
];

describe("generated OpenAPI 3.1 semantic contract", () => {
  it("publishes exactly the fourteen portable tuples with explicit security", async () => {
    const document = await openApiDocument();
    const operations = operationEntries(document);

    expect(document["openapi"]).toBe("3.1.0");
    expect(document["info"]).toMatchObject({ title: "Hono Playground", version: "0.1.0" });
    expect(operations).toHaveLength(14);
    expect(
      new Map(operations.map(([path, method, operation]) => [`${method} ${path}`, operation["operationId"]])),
    ).toEqual(OPERATION_IDS);
    for (const [path, , operation] of operations) {
      expect(operation["security"]).toEqual(path === "/v1/profile" ? [{ CloudflareAccess: [] }] : []);
      expect(operation["description"]).toMatch(/Query is closed:.*returns 400\./u);
      const parameters = Array.isArray(operation["parameters"]) ? operation["parameters"] : [];
      expect(parameters).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "X-Request-ID", in: "header", required: false })]),
      );
    }
  });

  it("documents only reachable statuses, representations, and required response headers", async () => {
    const document = await openApiDocument();
    for (const [path, method, operation] of operationEntries(document)) {
      const key = `${method} ${path}`;
      const responses = object(operation["responses"], `${key} responses`);
      const expected = path.startsWith("/v1/github/") ? GITHUB_STATUSES : EXPECTED_STATUSES.get(key);
      expect(Object.keys(responses).sort()).toEqual(expected?.toSorted());
      expect(responses).not.toHaveProperty("405");

      for (const [status, responseValue] of Object.entries(responses)) {
        const response = object(responseValue, `${key} ${status}`);
        const headers = object(response["headers"], `${key} ${status} headers`);
        for (const header of REQUIRED_HEADERS) {
          expect(object(headers[header], `${key} ${status} ${header}`)["required"]).toBe(true);
        }
        if (status === "204") {
          expect(response).not.toHaveProperty("content");
        } else {
          const content = object(response["content"], `${key} ${status} content`);
          const expectedMedia = status.startsWith("2")
            ? path === "/v1/items" || path === "/v1/profile"
              ? JSON_API_MEDIA_TYPE
              : "application/json"
            : path === "/v1/items" || path === "/v1/profile"
              ? JSON_API_MEDIA_TYPE
              : "application/problem+json";
          expect(Object.keys(content)).toEqual([expectedMedia]);
        }
      }

      const successStatus = method === "post" && path === "/v1/profile" ? "201" : method === "delete" ? "204" : "200";
      const success = object(responses[successStatus], `${key} success`);
      if (successStatus !== "204") {
        const content = object(success["content"], `${key} success content`);
        const expectedMedia = path === "/v1/items" || path === "/v1/profile" ? JSON_API_MEDIA_TYPE : "application/json";
        expect(Object.keys(content)).toEqual([expectedMedia]);
      }
      if (responses["429"] !== undefined) {
        const headers = object(object(responses["429"], `${key} 429`)["headers"], `${key} 429 headers`);
        expect(headers).toHaveProperty("Retry-After");
        if (path.startsWith("/v1/github/")) expect(headers).toHaveProperty("X-RateLimit-Reset");
        else expect(headers).not.toHaveProperty("X-RateLimit-Reset");
      }
    }
  });

  it("documents exact parameters and request-body boundaries", async () => {
    const document = await openApiDocument();
    for (const [path, method, operation] of operationEntries(document)) {
      const key = `${method} ${path}`;
      const parameters = (Array.isArray(operation["parameters"]) ? operation["parameters"] : []).map((value) =>
        object(value, `${key} parameter`),
      );
      const byName = new Map(parameters.map((parameter) => [String(parameter["name"]), parameter]));
      const expectedPath = path.includes("{repo}") ? ["owner", "repo"] : path.includes("{owner}") ? ["owner"] : [];
      const expectedQuery =
        path === "/v1/items"
          ? ["page[limit]", "page[cursor]", "filter[category]"]
          : path.endsWith("/repos") || path.endsWith("/activity") || path.endsWith("/tags")
            ? ["limit", "cursor"]
            : [];
      expect([...byName.keys()].toSorted()).toEqual([...expectedPath, ...expectedQuery, "X-Request-ID"].toSorted());

      const requestId = object(byName.get("X-Request-ID"), `${key} X-Request-ID`);
      expect(requestId).toMatchObject({ in: "header", required: false });
      expect(String(requestId["description"])).toMatch(/Missing, invalid, repeated, or comma-combined/u);
      expect(object(requestId["schema"], `${key} X-Request-ID schema`)).toMatchObject({
        type: "string",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
        maxLength: 128,
      });

      for (const name of expectedPath) {
        expect(byName.get(name)).toMatchObject({ in: "path", required: true });
      }
      for (const name of expectedQuery) {
        expect(byName.get(name)).toMatchObject({ in: "query", required: false });
      }

      const limitName = path === "/v1/items" ? "page[limit]" : expectedQuery.includes("limit") ? "limit" : undefined;
      if (limitName !== undefined) {
        expect(object(byName.get(limitName)?.["schema"], `${key} limit schema`)).toMatchObject({
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
        });
      }
      const cursorName =
        path === "/v1/items" ? "page[cursor]" : expectedQuery.includes("cursor") ? "cursor" : undefined;
      if (cursorName !== undefined) {
        expect(object(byName.get(cursorName)?.["schema"], `${key} cursor schema`)).toMatchObject({
          type: "string",
          minLength: 1,
          maxLength: 2048,
          pattern: "^[!-~]+$",
        });
      }

      const expectedBodyMedia =
        key === "post /v1/hello"
          ? "application/json"
          : key === "post /v1/profile" || key === "patch /v1/profile"
            ? JSON_API_MEDIA_TYPE
            : undefined;
      if (expectedBodyMedia === undefined) {
        expect(operation).not.toHaveProperty("requestBody");
      } else {
        const requestBody = object(operation["requestBody"], `${key} request body`);
        expect(requestBody["required"]).toBe(true);
        expect(Object.keys(object(requestBody["content"], `${key} request content`))).toEqual([expectedBodyMedia]);
      }
    }
  });

  it("describes the profile mapping, pagination, closed data, and provider-free caller surface", async () => {
    const document = await openApiDocument();
    const components = object(document["components"], "components");
    const schemas = object(components["schemas"], "schemas");
    const securitySchemes = object(components["securitySchemes"], "security schemes");

    expect(securitySchemes["CloudflareAccess"]).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "CF_Authorization",
    });
    expect(schemas["Money"]).toMatchObject({
      type: "object",
      required: ["amountMinor", "currency"],
      properties: {
        amountMinor: { type: "integer", minimum: 0, maximum: 9_007_199_254_740_991 },
        currency: { type: "string" },
      },
      additionalProperties: false,
    });
    const moneyProperties = object(object(schemas["Money"], "Money schema")["properties"], "Money properties");
    const currency = object(moneyProperties["currency"], "Money currency");
    expect(currency["const"] ?? (currency["enum"] as unknown[] | undefined)?.[0]).toBe("USD");
    expect(schemas["ItemResource"]).toMatchObject({
      type: "object",
      required: ["type", "id", "attributes"],
      additionalProperties: false,
    });
    expect(schemas["ProfileCreateAttributes"]).toMatchObject({ additionalProperties: false });
    expect(schemas["ProfileUpdateAttributes"]).toMatchObject({ additionalProperties: false, minProperties: 1 });
    expect(schemas["JsonApiRequestObject"]).not.toMatchObject({ additionalProperties: false });

    for (const name of ["ProfileCreateAttributes", "ProfileUpdateAttributes"]) {
      const properties = object(object(schemas[name], `${name} schema`)["properties"], `${name} properties`);
      const contactEmail = object(properties["contactEmail"], `${name}.contactEmail`);
      const phoneNumber = object(properties["phoneNumber"], `${name}.phoneNumber`);
      expect(new RegExp(String(contactEmail["pattern"]), "u").test(" Ada@EXAMPLE.COM ")).toBe(true);
      expect(new RegExp(String(contactEmail["pattern"]), "u").test("Ada@@example.com")).toBe(false);
      expect(contactEmail).not.toHaveProperty("maxLength");
      expect(new RegExp(String(phoneNumber["pattern"]), "u").test(" +358401234567 ")).toBe(true);
      expect(new RegExp(String(phoneNumber["pattern"]), "u").test("+01234567")).toBe(false);
    }

    const profileProperties = object(
      object(schemas["ProfileAttributes"], "ProfileAttributes schema")["properties"],
      "ProfileAttributes properties",
    );
    const emittedContactEmail = object(profileProperties["contactEmail"], "ProfileAttributes.contactEmail");
    expect(new RegExp(String(emittedContactEmail["pattern"]), "u").test("Ada@example.com")).toBe(true);
    expect(new RegExp(String(emittedContactEmail["pattern"]), "u").test(" Ada@example.com ")).toBe(false);

    const helloProperties = object(
      object(schemas["HelloCreate"], "HelloCreate schema")["properties"],
      "HelloCreate properties",
    );
    const boundedName = object(helloProperties["name"], "HelloCreate.name");
    expect(new RegExp(String(boundedName["pattern"]), "u").test("Ada Lovelace")).toBe(true);
    expect(new RegExp(String(boundedName["pattern"]), "u").test(" Ada")).toBe(false);
    expect(new RegExp(String(boundedName["pattern"]), "u").test("Ada\u0085")).toBe(false);

    const validationProblems = findObjects(document, (candidate) => {
      const properties = candidate["properties"];
      if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return false;
      const code = (properties as JsonObject)["code"];
      const type = (properties as JsonObject)["type"];
      const isLiteral = (value: unknown, expected: string): boolean =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        ((value as JsonObject)["const"] === expected ||
          (Array.isArray((value as JsonObject)["enum"]) &&
            ((value as JsonObject)["enum"] as unknown[])[0] === expected));
      return isLiteral(code, "validation_failed") && isLiteral(type, "about:blank");
    });
    expect(validationProblems.length).toBeGreaterThan(0);
    for (const schema of validationProblems) {
      expect(schema["required"]).toEqual(expect.arrayContaining(["errors"]));
    }

    const serialized = JSON.stringify(document).toLowerCase();
    expect(serialized).not.toContain("application/cbor");
    expect(serialized).not.toContain("cf-access-jwt-assertion");
    expect(serialized).not.toContain('"authorization"');
    expect(serialized).not.toContain("x-github-api-version");
  });

  it("contains only resolvable same-document references", async () => {
    const document = await openApiDocument();
    const refs = new Set<string>();
    visitRefs(document, refs);

    expect(refs.size).toBeGreaterThan(0);
    for (const ref of refs) expect(resolveLocalRef(document, ref)).toBeDefined();
  });

  it("publishes JSON Schema patterns without JavaScript delimiters or flags", async () => {
    const document = await openApiDocument();
    const patterns: string[] = [];
    collectPatterns(document, patterns);

    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns).not.toContain("^[!-~]+$/u");
    expect(patterns).not.toContain("^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u");
    expect(patterns).toContain("^[!-~]+$");
    expect(patterns).toContain("^(?:[0-9a-f]{40}|[0-9a-f]{64})$");
  });
});
