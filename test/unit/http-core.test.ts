import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.ts";
import { InvalidAccessTokenError } from "../../src/auth/types.ts";
import { lifecycle } from "../../src/core/lifecycle.ts";
import { resolveRoute } from "../../src/core/routes.ts";
import type { AppEnvironment, RuntimeBindings } from "../../src/core/types.ts";
import { JSON_API_MEDIA_TYPE } from "../../src/models/json-api.ts";

const ORIGIN = "https://api.example.test";
const ACCESS_ASSERTION = { "Cf-Access-Jwt-Assertion": "signed" } as const;
const CORS_HEADERS = [
  "Access-Control-Allow-Credentials",
  "Access-Control-Allow-Headers",
  "Access-Control-Allow-Methods",
  "Access-Control-Allow-Origin",
  "Access-Control-Expose-Headers",
  "Access-Control-Max-Age",
] as const;

const TEST_BINDINGS = {
  DB: {} as D1Database,
  ENVIRONMENT: "test",
  RATE_LIMIT_MODE: "none",
} satisfies RuntimeBindings;

const app = createApp();

const request = (path: string, init: RequestInit = {}, bindings: RuntimeBindings = TEST_BINDINGS): Promise<Response> =>
  Promise.resolve(app.request(new Request(`${ORIGIN}${path}`, init), undefined, bindings));

type Problem = {
  type: "about:blank";
  title: string;
  status: number;
  detail: string;
  code: string;
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

const expectProblem = async (
  response: Response,
  expected: Pick<Problem, "code" | "detail" | "status" | "title">,
): Promise<Problem> => {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  const body = (await response.json()) as Problem;
  expect(body).toEqual({ type: "about:blank", ...expected });
  return body;
};

const expectJsonApiError = async (
  response: Response,
  expected: {
    status: number;
    code: string;
    detail: string;
    source?: { pointer?: string; parameter?: string; header?: string };
  },
): Promise<JsonApiErrorDocument> => {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
  const body = (await response.json()) as JsonApiErrorDocument;
  expect(body.jsonapi).toEqual({ version: "1.1" });
  expect(body.errors).toHaveLength(1);
  expect(body.errors[0]).toMatchObject({
    status: String(expected.status),
    code: expected.code,
    detail: expected.detail,
    ...(expected.source === undefined ? {} : { source: expected.source }),
  });
  return body;
};

const expectCommonHeaders = (response: Response, documentation = false): void => {
  expect(response.headers.get("X-Request-ID")).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  if (documentation) {
    const policy = response.headers.get("Content-Security-Policy") ?? "";
    expect(policy).toContain("script-src 'sha256-");
    expect(policy).toContain("'sha384-");
    expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
    expect(policy).toContain("connect-src 'self'");
  } else {
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  }
  expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
  expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.has("Strict-Transport-Security")).toBe(false);
  for (const header of CORS_HEADERS) {
    expect(response.headers.has(header)).toBe(false);
  }
};

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request IDs and common response policy", () => {
  it("generates a 32-character lowercase hexadecimal request ID", async () => {
    const response = await request("/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("echoes an inbound request ID only when it matches the bounded lexical contract", async () => {
    const accepted = "Request_123:alpha.beta-9";
    const response = await request("/health", { headers: { "X-Request-ID": accepted } });

    expect(response.headers.get("X-Request-ID")).toBe(accepted);
  });

  it.each(["contains spaces", "-starts-with-punctuation", "x".repeat(129)])(
    "replaces an unsafe inbound request ID: %s",
    async (candidate) => {
      const response = await request("/health", {
        headers: { "X-Request-ID": candidate },
      });

      expect(response.headers.get("X-Request-ID")).toMatch(/^[0-9a-f]{32}$/);
      expect(response.headers.get("X-Request-ID")).not.toBe(candidate);
    },
  );

  it("preserves a validated request ID on body-limit and configuration failures", async () => {
    const smallApp = createApp({
      maximumRequestBytes: 16,
      accessVerifier: () => Promise.resolve({ sub: "subject-1" }),
    });
    const requestId = "bounded-request-id";
    const oversized = await smallApp.request(
      new Request(`${ORIGIN}/v1/profile`, {
        method: "POST",
        headers: {
          Accept: JSON_API_MEDIA_TYPE,
          "Content-Type": JSON_API_MEDIA_TYPE,
          ...ACCESS_ASSERTION,
          "X-Request-ID": requestId,
        },
        body: JSON.stringify({
          data: { type: "profiles", attributes: { firstName: "larger than sixteen bytes" } },
        }),
      }),
      undefined,
      TEST_BINDINGS,
    );
    const misconfigured = await request(
      "/v1/hello",
      { headers: { "X-Request-ID": requestId } },
      { ...TEST_BINDINGS, ENVIRONMENT: "invalid" },
    );

    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("X-Request-ID")).toBe(requestId);
    expect(misconfigured.status).toBe(500);
    expect(misconfigured.headers.get("X-Request-ID")).toBe(requestId);
    expectCommonHeaders(oversized);
    expectCommonHeaders(misconfigured);
  });

  it.each(["staging", "production"] as const)("adds short HSTS for a validated %s response", async (environment) => {
    const response = await request(
      "/openapi.json",
      {},
      {
        ...TEST_BINDINGS,
        ENVIRONMENT: environment,
        RATE_LIMIT_MODE: "workers-binding",
        RATE_LIMIT_KEY_HMAC_KEY: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        PUBLIC_RATE_LIMITER: {
          limit: () => Promise.resolve({ success: true }),
        } as unknown as RateLimit,
      },
    );

    expect(response.status, await response.clone().text()).toBe(200);
    expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=300");
  });

  it("merges Vary field names case-insensitively without duplicating an existing token", async () => {
    const varyApp = new Hono<AppEnvironment>();
    varyApp.use("*", lifecycle());
    varyApp.get("/", (c) => c.body("ok", { headers: { Vary: "accept, ACCEPT, X-Test, x-test" } }));

    const response = await varyApp.request(`${ORIGIN}/`, {}, TEST_BINDINGS);

    expect(response.headers.get("Vary")).toBe("accept, X-Test");
  });
});

describe("representation negotiation", () => {
  it.each([
    undefined,
    "application/json",
    "APPLICATION/JSON",
    "application/json;charset=utf-8",
    "application/*",
    "*/*",
    "text/plain;q=1, application/json;q=0.25",
  ])("accepts a positive operational JSON range: %s", async (accept) => {
    const response = await request("/health", accept === undefined ? {} : { headers: { Accept: accept } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "healthy" });
  });

  it.each([
    ["application/json;charset=utf-8", "application/json; charset=utf-8"],
    ["application/json;charset=utf-8;q=0, application/json;q=1", "application/json"],
    ["application/json;q=0, application/json;charset=utf-8;q=1", "application/json; charset=utf-8"],
  ])("emits the exact selected JSON form for %s", async (accept, expected) => {
    const response = await request("/health", { headers: { Accept: accept } });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(expected);
  });

  it.each([
    ["application/problem+json;charset=utf-8;q=0, application/problem+json;q=1", "application/problem+json"],
    [
      "application/problem+json;q=0, application/problem+json;charset=utf-8;q=1",
      "application/problem+json; charset=utf-8",
    ],
  ])("emits the exact selected Problem Details JSON form for %s", async (accept, expected) => {
    const response = await request("/missing", { headers: { Accept: accept } });

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "text/plain",
    "application/cbor",
    "application/json;q=0",
    "application/json;q=0, */*;q=1",
    "application/*;q=0, */*;q=1",
    "application/json;q=.5",
    "application/json;q=0.1234",
    "application/json;q=9e-1",
    "application/json;q=+0.5",
    'application/json;note="unterminated',
  ])("returns Problem Details when operational JSON is unacceptable: %s", async (accept) => {
    const response = await request("/health", { headers: { Accept: accept } });

    await expectProblem(response, {
      title: "Not Acceptable",
      status: 406,
      code: "not_acceptable",
      detail: "No acceptable response representation is available",
    });
    expect(response.headers.get("Vary")).toBe("Accept");
    expectCommonHeaders(response);
  });

  it.each(['application/json, text/plain;note="unterminated', 'text/plain;note="unterminated, application/json'])(
    "ignores one malformed range when an acceptable operational range remains: %s",
    async (accept) => {
      const response = await request("/health", { headers: { Accept: accept } });

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/json");
    },
  );

  it.each([
    undefined,
    JSON_API_MEDIA_TYPE,
    `${JSON_API_MEDIA_TYPE};profile="https://example.test/profile"`,
    `${JSON_API_MEDIA_TYPE};profile="https://example.test/profile urn:example:profile"`,
    `${JSON_API_MEDIA_TYPE};profile="https://one.test/profile https://two.test/profile"`,
    "application/*",
    "*/*",
    `${JSON_API_MEDIA_TYPE};q=1;foo=bar, */*`,
    `${JSON_API_MEDIA_TYPE};charset=utf-8, */*;q=1`,
    `${JSON_API_MEDIA_TYPE};ext="https://example.test/ext", */*;q=1`,
  ])("accepts a supported JSON:API range: %s", async (accept) => {
    const response = await request("/v1/items", accept === undefined ? {} : { headers: { Accept: accept } });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
  });

  it.each([
    "",
    "   ",
    "application/json",
    `${JSON_API_MEDIA_TYPE};charset=utf-8`,
    `${JSON_API_MEDIA_TYPE};ext="https://example.test/ext"`,
    `${JSON_API_MEDIA_TYPE};profile=https://example.test/profile`,
    `${JSON_API_MEDIA_TYPE};profile=""`,
    `${JSON_API_MEDIA_TYPE};profile="relative-profile"`,
    `${JSON_API_MEDIA_TYPE};profile="https://example.test/%"`,
    `${JSON_API_MEDIA_TYPE};profile="https://one.test/profile  https://two.test/profile"`,
    `${JSON_API_MEDIA_TYPE};q=0`,
    `${JSON_API_MEDIA_TYPE};q="0.5"`,
    `${JSON_API_MEDIA_TYPE};q=0, */*;q=1`,
    `${JSON_API_MEDIA_TYPE};q=1;charset=utf-8`,
    `${JSON_API_MEDIA_TYPE};profile = "https://example.test/profile"`,
    `${JSON_API_MEDIA_TYPE};q =1`,
  ])("returns a JSON:API 406 for an unsupported JSON:API range: %s", async (accept) => {
    const response = await request("/v1/items", { headers: { Accept: accept } });

    await expectJsonApiError(response, {
      status: 406,
      code: "not_acceptable",
      detail: "No acceptable response representation is available",
      source: { header: "Accept" },
    });
    expect(response.headers.get("Vary")).toBe("Accept");
  });

  it("combines repeated Accept field values using media-range precedence", async () => {
    const headers = new Headers();
    headers.append("Accept", "*/*;q=1");
    headers.append("Accept", `${JSON_API_MEDIA_TYPE};q=0`);
    const response = await request("/v1/items", { headers });

    expect(response.status).toBe(406);
  });

  it.each([
    ["text/html;level=1", 406],
    ["text/html;level=1, */*;q=0.5", 200],
  ])("matches documentation Accept parameters only when supported: %s", async (accept, status) => {
    const response = await request("/api-docs", { headers: { Accept: accept } });

    expect(response.status).toBe(status);
  });
});

describe("known-resource method policy and strict paths", () => {
  it.each([
    ["GET", "/health", "getHealth"],
    ["HEAD", "/health", "getHealth"],
    ["GET", "/v1/hello", "getHello"],
    ["POST", "/v1/hello", "createHello"],
    ["GET", "/v1/items", "listItems"],
    ["HEAD", "/v1/items", "listItems"],
    ["POST", "/v1/profile", "createProfile"],
    ["GET", "/v1/profile", "getProfile"],
    ["HEAD", "/v1/profile", "getProfile"],
    ["PATCH", "/v1/profile", "updateProfile"],
    ["DELETE", "/v1/profile", "deleteProfile"],
    ["GET", "/v1/github/owners/octocat", "getGitHubOwner"],
    ["GET", "/v1/github/owners/octocat/repos", "listGitHubOwnerRepositories"],
    ["GET", "/v1/github/repos/octocat/hello-world", "getGitHubRepository"],
    ["GET", "/v1/github/repos/octocat/hello-world/activity", "listGitHubRepositoryActivity"],
    ["GET", "/v1/github/repos/octocat/hello-world/languages", "listGitHubRepositoryLanguages"],
    ["GET", "/v1/github/repos/octocat/hello-world/tags", "listGitHubRepositoryTags"],
    ["GET", "/openapi.json", "getOpenApiDocument"],
    ["HEAD", "/openapi.json", "getOpenApiDocument"],
    ["GET", "/api-docs", "getApiDocs"],
    ["HEAD", "/api-docs", "getApiDocs"],
  ])("maps %s %s to the fixed operation label %s", (method, path, operationId) => {
    expect(resolveRoute(path, method).metadata.operationId).toBe(operationId);
  });

  it.each([
    ["POST", "/health", "GET, HEAD", "problem"],
    ["POST", "/v1/items", "GET, HEAD", "jsonapi"],
    ["OPTIONS", "/v1/profile", "POST, GET, HEAD, PATCH, DELETE", "jsonapi"],
    ["POST", "/v1/github/owners/octocat", "GET, HEAD", "problem"],
    ["POST", "/openapi.json", "GET, HEAD", "problem"],
    ["OPTIONS", "/api-docs", "GET, HEAD", "problem"],
  ])("returns a complete 405 Allow for %s %s", async (method, path, allow, format) => {
    const response = await request(path, { method });

    if (format === "jsonapi") {
      await expectJsonApiError(response, {
        status: 405,
        code: "method_not_allowed",
        detail: "Method not allowed",
      });
    } else {
      await expectProblem(response, {
        title: "Method Not Allowed",
        status: 405,
        code: "method_not_allowed",
        detail: "Method not allowed",
      });
    }
    expect(response.headers.get("Allow")).toBe(allow);
    expectCommonHeaders(response, path === "/api-docs");
  });

  it.each([
    ["/health", "application/json", false],
    ["/v1/hello", "application/json", false],
    ["/v1/items", JSON_API_MEDIA_TYPE, false],
    ["/openapi.json", "application/json", false],
    ["/api-docs", "text/html", true],
  ] as const)("uses Hono's GET-derived HEAD behavior for %s", async (path, contentType, docs) => {
    const response = await request(path, {
      method: "HEAD",
      headers: { Accept: contentType },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(contentType);
    expect(await response.text()).toBe("");
    expectCommonHeaders(response, docs);
  });

  it("applies the method guard before negotiation, authentication, and body processing", async () => {
    const response = await request("/v1/profile", {
      method: "PUT",
      headers: { Accept: "text/plain", "Content-Type": "text/plain" },
      body: "not-json",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST, GET, HEAD, PATCH, DELETE");
  });

  it.each([
    ["/health/", "problem"],
    ["/v1/items/", "problem"],
    ["/openapi.json/", "problem"],
    ["/api-docs/", "problem"],
  ])("does not redirect a trailing-slash path: %s", async (path, format) => {
    const response = await request(path);

    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    if (format === "jsonapi") {
      await expectJsonApiError(response, {
        status: 404,
        code: "not_found",
        detail: "Resource not found",
      });
    } else {
      await expectProblem(response, {
        title: "Not Found",
        status: 404,
        code: "not_found",
        detail: "Resource not found",
      });
    }
  });

  it("fails closed on an unregistered trailing-slash profile descendant", async () => {
    const protectedApp = createApp({
      accessVerifier: async () => {
        throw new InvalidAccessTokenError();
      },
    });
    const response = await protectedApp.request(new Request(`${ORIGIN}/v1/profile/`), undefined, TEST_BINDINGS);

    expect(response.headers.get("Location")).toBeNull();
    await expectProblem(response, {
      title: "Forbidden",
      status: 403,
      code: "forbidden",
      detail: "Access is forbidden",
    });
  });

  it.each([
    ["/health%2F", "problem"],
    ["/v1%2Fitems", "problem"],
    ["/v1/items%2Fitem-001", "problem"],
  ])("rejects percent-encoded route variants before dispatch: %s", async (path, format) => {
    const response = await request(path);

    expect(response.status).toBe(404);
    if (format === "jsonapi") {
      await expectJsonApiError(response, {
        status: 404,
        code: "not_found",
        detail: "Resource not found",
      });
    } else {
      await expectProblem(response, {
        title: "Not Found",
        status: 404,
        code: "not_found",
        detail: "Resource not found",
      });
    }
  });

  it("uses ordinary 404 behavior for OPTIONS on an unknown resource", async () => {
    const response = await request("/unknown", { method: "OPTIONS" });

    expect(response.status).toBe(404);
    expect(response.headers.get("Allow")).toBeNull();
  });
});

describe("JSON:API body preconditions and ordering", () => {
  const profileRequest = (
    body: BodyInit | null,
    headers: HeadersInit = {},
    maximumRequestBytes?: number,
  ): Promise<Response> => {
    const application = createApp(
      maximumRequestBytes === undefined
        ? { accessVerifier: () => Promise.resolve({ sub: "subject-1" }) }
        : {
            accessVerifier: () => Promise.resolve({ sub: "subject-1" }),
            maximumRequestBytes,
          },
    );
    return Promise.resolve(
      application.request(
        new Request(`${ORIGIN}/v1/profile`, {
          method: "POST",
          headers: {
            Accept: JSON_API_MEDIA_TYPE,
            "Content-Type": JSON_API_MEDIA_TYPE,
            ...ACCESS_ASSERTION,
            ...headers,
          },
          body,
        }),
        undefined,
        TEST_BINDINGS,
      ),
    );
  };

  it("negotiates the response before touching an invalid request body", async () => {
    const response = await profileRequest("{", { Accept: "application/json" });

    await expectJsonApiError(response, {
      status: 406,
      code: "not_acceptable",
      detail: "No acceptable response representation is available",
      source: { header: "Accept" },
    });
  });

  it("returns 415 when Content-Type is missing", async () => {
    const response = await profileRequest("{}", { "Content-Type": "" });

    await expectJsonApiError(response, {
      status: 415,
      code: "unsupported_media_type",
      detail: "Request representation is not supported",
      source: { header: "Content-Type" },
    });
  });

  it.each([
    ["application/json", undefined],
    [`${JSON_API_MEDIA_TYPE};charset=utf-8`, undefined],
    [`${JSON_API_MEDIA_TYPE};ext="https://example.test/ext"`, undefined],
    [`${JSON_API_MEDIA_TYPE};profile=https://example.test/profile`, undefined],
    [`${JSON_API_MEDIA_TYPE};profile=""`, undefined],
    [`${JSON_API_MEDIA_TYPE};profile="relative-profile"`, undefined],
    [`${JSON_API_MEDIA_TYPE};profile="https://example.test/%"`, undefined],
    [`${JSON_API_MEDIA_TYPE};profile="https://one.test/profile  https://two.test/profile"`, undefined],
    [`${JSON_API_MEDIA_TYPE};profile = "https://example.test/profile"`, undefined],
    [`${JSON_API_MEDIA_TYPE};profile= "https://example.test/profile"`, undefined],
    [JSON_API_MEDIA_TYPE, "gzip"],
  ])("rejects unsupported representation metadata before JSON parsing", async (contentType, contentEncoding) => {
    const response = await profileRequest("{", {
      "Content-Type": contentType,
      ...(contentEncoding === undefined ? {} : { "Content-Encoding": contentEncoding }),
    });

    await expectJsonApiError(response, {
      status: 415,
      code: "unsupported_media_type",
      detail: "Request representation is not supported",
      source: {
        header: contentEncoding === undefined ? "Content-Type" : "Content-Encoding",
      },
    });
  });

  it.each(["", "   ", '{"data":'])("normalizes an empty or malformed JSON document: %j", async (body) => {
    const response = await profileRequest(body);

    await expectJsonApiError(response, {
      status: 400,
      code: "invalid_request",
      detail: "Request is malformed",
    });
  });

  it.each([
    [
      "a repeated literal member",
      '{"data":{"type":"profiles","attributes":{"firstName":"Ada","firstName":"Grace","lastName":"Lovelace","contactEmail":"ada@example.com","phoneNumber":"+12025550123","termsAccepted":true}}}',
    ],
    [
      "an escape-equivalent member",
      String.raw`{"data":{"type":"profiles","attributes":{"firstName":"Ada","lastName":"Lovelace","contactEmail":"ada@example.com","phoneNumber":"+12025550123","termsAccepted":false,"\u0074ermsAccepted":true}}}`,
    ],
    ["an unpaired surrogate", String.raw`{"data":{"type":"profiles","attributes":{"firstName":"\uD800"}}}`],
  ])("rejects ambiguous JSON containing %s", async (_case, body) => {
    const response = await profileRequest(body);

    await expectJsonApiError(response, {
      status: 400,
      code: "invalid_request",
      detail: "Request is malformed",
    });
  });

  it("accepts a paired supplementary Unicode scalar before schema validation", async () => {
    const response = await profileRequest(
      String.raw`{"data":{"type":"profiles","attributes":{"firstName":"\uD83D\uDE00"}}}`,
    );

    expect(response.status).toBe(422);
  });

  it("rejects invalid UTF-8 instead of parsing replacement characters", async () => {
    const response = await profileRequest(new Uint8Array([0xc3, 0x28]));

    await expectJsonApiError(response, {
      status: 400,
      code: "invalid_request",
      detail: "Request is malformed",
    });
  });

  it("returns 413 for a streamed body above the configured application limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(32)));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const response = await profileRequest(body, {}, 16);

    await expectJsonApiError(response, {
      status: 413,
      code: "payload_too_large",
      detail: "Request body is too large",
    });
  });

  it("accepts a body exactly at the configured byte limit before schema validation", async () => {
    const response = await profileRequest("{}", {}, 2);

    await expectJsonApiError(response, {
      status: 422,
      code: "validation_failed",
      detail: "Invalid value type",
    });
  });

  const sizedInvalidDocument = (size: number): string => {
    const prefix = '{"padding":"';
    const suffix = '"}';
    const body = `${prefix}${"x".repeat(size - prefix.length - suffix.length)}${suffix}`;
    expect(new TextEncoder().encode(body)).toHaveLength(size);
    return body;
  };

  it.each([
    [999_999, 422],
    [1_000_000, 422],
    [1_000_001, 413],
  ])("enforces the native declared body boundary at %i bytes", async (size, expectedStatus) => {
    const accessVerifier = vi.fn(async () => ({ sub: "subject-1" }));
    const profileRepositoryFactory = vi.fn();
    const application = createApp({ accessVerifier, profileRepositoryFactory });
    const requestId = `declared-${size}`;
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profile`, {
        method: "POST",
        headers: {
          Accept: JSON_API_MEDIA_TYPE,
          "Cf-Access-Jwt-Assertion": "signed",
          "Content-Length": String(size),
          "Content-Type": JSON_API_MEDIA_TYPE,
          "X-Request-ID": requestId,
        },
        body: sizedInvalidDocument(size),
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("X-Request-ID")).toBe(requestId);
    expect(accessVerifier).toHaveBeenCalledTimes(expectedStatus === 413 ? 0 : 1);
    expect(profileRepositoryFactory).not.toHaveBeenCalled();
  });

  it.each([
    [999_999, 422],
    [1_000_000, 422],
    [1_000_001, 413],
  ])("enforces the native streamed body boundary at %i bytes", async (size, expectedStatus) => {
    const accessVerifier = vi.fn(async () => ({ sub: "subject-1" }));
    const profileRepositoryFactory = vi.fn();
    const application = createApp({ accessVerifier, profileRepositoryFactory });
    const bytes = new TextEncoder().encode(sizedInvalidDocument(size));
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.length; offset += 500_000) {
      chunks.push(bytes.subarray(offset, Math.min(offset + 500_000, bytes.length)));
    }
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    });
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const requestId = `streamed-${size}`;
    const response = await application.request(
      new Request(`${ORIGIN}/v1/profile`, {
        method: "POST",
        headers: {
          Accept: JSON_API_MEDIA_TYPE,
          "Cf-Access-Jwt-Assertion": "signed",
          "Content-Type": JSON_API_MEDIA_TYPE,
          "X-Request-ID": requestId,
        },
        body,
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("X-Request-ID")).toBe(requestId);
    expect(accessVerifier).toHaveBeenCalledTimes(1);
    expect(profileRepositoryFactory).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(expectedStatus === 413 ? 1 : 0);
    if (expectedStatus === 413) expect(pull).toHaveBeenCalledTimes(3);
  });

  it("identifies Content-Length when the declared body size exceeds the limit", async () => {
    const response = await profileRequest(
      "{}",
      {
        "Content-Length": "32",
      },
      16,
    );

    await expectJsonApiError(response, {
      status: 413,
      code: "payload_too_large",
      detail: "Request body is too large",
      source: { header: "Content-Length" },
    });
  });

  it.each(["-1", "1.0", "1, 2", "9007199254740992"])(
    "rejects an invalid declared Content-Length before authentication: %s",
    async (contentLength) => {
      const accessVerifier = vi.fn(async () => ({ sub: "subject-1" }));
      const application = createApp({ accessVerifier });
      const response = await application.request(
        new Request(`${ORIGIN}/v1/profile`, {
          method: "POST",
          headers: {
            Accept: JSON_API_MEDIA_TYPE,
            "Cf-Access-Jwt-Assertion": "signed",
            "Content-Length": contentLength,
            "Content-Type": JSON_API_MEDIA_TYPE,
          },
          body: "{}",
        }),
        undefined,
        TEST_BINDINGS,
      );

      await expectJsonApiError(response, {
        status: 400,
        code: "invalid_request",
        detail: "Request is malformed",
        source: { header: "Content-Length" },
      });
      expect(accessVerifier).not.toHaveBeenCalled();
    },
  );

  it("accepts a profile media-type parameter and explicit identity encoding", async () => {
    const response = await profileRequest(
      JSON.stringify({
        data: {
          type: "profiles",
          attributes: {},
        },
      }),
      {
        "Content-Type": `${JSON_API_MEDIA_TYPE};profile="https://example.test/profile urn:example:profile"`,
        "Content-Encoding": "identity",
      },
    );

    expect(response.status).toBe(422);
    expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
  });
});
