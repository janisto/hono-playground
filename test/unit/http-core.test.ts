import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { resolveRoute } from "../../src/core/routes.js";
import type { RuntimeBindings } from "../../src/core/types.js";
import { JSON_API_MEDIA_TYPE } from "../../src/models/json-api.js";

const ORIGIN = "https://api.example.test";
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

const request = (
  path: string,
  init: RequestInit = {},
  bindings: RuntimeBindings = TEST_BINDINGS,
): Promise<Response> =>
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
    expect(response.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(response.headers.get("Content-Security-Policy")).toContain("connect-src 'self'");
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
    const smallApp = createApp({ maximumRequestBytes: 16 });
    const requestId = "bounded-request-id";
    const oversized = await smallApp.request(
      new Request(`${ORIGIN}/v1/profiles`, {
        method: "POST",
        headers: {
          Accept: JSON_API_MEDIA_TYPE,
          "Content-Type": JSON_API_MEDIA_TYPE,
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
      "/health",
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

  it.each(["staging", "production"] as const)(
    "adds short HSTS for a validated %s response",
    async (environment) => {
      const response = await request(
        "/openapi.json",
        {},
        {
          ...TEST_BINDINGS,
          ENVIRONMENT: environment,
          RATE_LIMIT_MODE: "workers-binding",
          RATE_LIMIT_KEY_HMAC_KEY:
            "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          PUBLIC_RATE_LIMITER: {
            limit: () => Promise.resolve({ success: true }),
          } as unknown as RateLimit,
        },
      );

      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("Strict-Transport-Security")).toBe("max-age=300");
    },
  );
});

describe("representation negotiation", () => {
  it.each([
    undefined,
    "",
    "application/json",
    "APPLICATION/JSON",
    "application/*",
    "*/*",
    "text/plain;q=1, application/json;q=0.25",
  ])("accepts a positive operational JSON range: %s", async (accept) => {
    const response = await request(
      "/health",
      accept === undefined ? {} : { headers: { Accept: accept } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "healthy" });
  });

  it.each([
    "text/plain",
    "application/cbor",
    "application/json;q=0",
    "application/json;q=0, */*;q=1",
    "application/*;q=0, */*;q=1",
    "application/json;charset=utf-8",
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
      detail: "Supported response format: application/json",
    });
    expect(response.headers.get("Vary")).toBe("Accept");
    expectCommonHeaders(response);
  });

  it.each([
    undefined,
    "",
    JSON_API_MEDIA_TYPE,
    `${JSON_API_MEDIA_TYPE};profile="https://example.test/profile"`,
    `${JSON_API_MEDIA_TYPE};profile="https://example.test/profile urn:example:profile"`,
    "application/*",
    "*/*",
  ])("accepts a supported JSON:API range: %s", async (accept) => {
    const response = await request(
      "/v1/items",
      accept === undefined ? {} : { headers: { Accept: accept } },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(JSON_API_MEDIA_TYPE);
  });

  it.each([
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
  ])("returns a JSON:API 406 for an unsupported JSON:API range: %s", async (accept) => {
    const response = await request("/v1/items", { headers: { Accept: accept } });

    await expectJsonApiError(response, {
      status: 406,
      code: "not_acceptable",
      detail: `Supported response format: ${JSON_API_MEDIA_TYPE}`,
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
});

describe("known-resource method policy and strict paths", () => {
  it.each([
    ["GET", "/health", "getHealth"],
    ["GET", "/v1/items", "listItems"],
    ["GET", "/v1/items/item-001", "getItem"],
    ["POST", "/v1/profiles", "createProfile"],
    ["GET", "/v1/profiles/current", "getCurrentProfile"],
    ["PATCH", "/v1/profiles/current", "updateCurrentProfile"],
    ["DELETE", "/v1/profiles/current", "deleteCurrentProfile"],
    ["GET", "/openapi.json", "getOpenApi"],
    ["GET", "/api-docs", "getApiDocs"],
  ])("maps %s %s to the fixed operation label %s", (method, path, operationId) => {
    expect(resolveRoute(path, method).metadata.operationId).toBe(operationId);
  });

  it.each([
    ["HEAD", "/health", "GET", "problem"],
    ["POST", "/health", "GET", "problem"],
    ["POST", "/v1/items", "GET", "jsonapi"],
    ["PUT", "/v1/items/item-001", "GET", "jsonapi"],
    ["OPTIONS", "/v1/profiles", "POST", "jsonapi"],
    ["OPTIONS", "/v1/profiles/current", "GET, PATCH, DELETE", "jsonapi"],
    ["HEAD", "/openapi.json", "GET", "problem"],
    ["OPTIONS", "/api-docs", "GET", "problem"],
  ])("returns a complete 405 Allow for %s %s", async (method, path, allow, format) => {
    const response = await request(path, { method });

    if (method === "HEAD") {
      expect(response.status).toBe(405);
      expect(response.headers.get("Content-Type")).toContain(
        format === "jsonapi" ? JSON_API_MEDIA_TYPE : "application/problem+json",
      );
      expect(await response.text()).toBe("");
    } else if (format === "jsonapi") {
      await expectJsonApiError(response, {
        status: 405,
        code: "method_not_allowed",
        detail: "Method Not Allowed",
      });
    } else {
      await expectProblem(response, {
        title: "Method Not Allowed",
        status: 405,
        code: "method_not_allowed",
        detail: "Method Not Allowed",
      });
    }
    expect(response.headers.get("Allow")).toBe(allow);
    expectCommonHeaders(response, path === "/api-docs");
  });

  it("applies the method guard before negotiation, authentication, and body processing", async () => {
    const response = await request("/v1/profiles/current", {
      method: "POST",
      headers: { Accept: "text/plain", "Content-Type": "text/plain" },
      body: "not-json",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, PATCH, DELETE");
  });

  it.each([
    ["/health/", "problem"],
    ["/v1/items/", "jsonapi"],
    ["/v1/profiles/current/", "jsonapi"],
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
        detail: "Not Found",
      });
    } else {
      await expectProblem(response, {
        title: "Not Found",
        status: 404,
        code: "not_found",
        detail: "Not Found",
      });
    }
  });

  it.each([
    ["/health%2F", "problem"],
    ["/v1%2Fitems", "problem"],
    ["/v1/items%2Fitem-001", "jsonapi"],
  ])("rejects percent-encoded route variants before dispatch: %s", async (path, format) => {
    const response = await request(path);

    expect(response.status).toBe(404);
    if (format === "jsonapi") {
      await expectJsonApiError(response, {
        status: 404,
        code: "not_found",
        detail: "Not Found",
      });
    } else {
      await expectProblem(response, {
        title: "Not Found",
        status: 404,
        code: "not_found",
        detail: "Not Found",
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
        new Request(`${ORIGIN}/v1/profiles`, {
          method: "POST",
          headers: {
            Accept: JSON_API_MEDIA_TYPE,
            "Content-Type": JSON_API_MEDIA_TYPE,
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
      detail: `Supported response format: ${JSON_API_MEDIA_TYPE}`,
    });
  });

  it("returns 415 when Content-Type is missing", async () => {
    const response = await profileRequest("{}", { "Content-Type": "" });

    await expectJsonApiError(response, {
      status: 415,
      code: "unsupported_media_type",
      detail: `Content-Type must be ${JSON_API_MEDIA_TYPE} without unsupported extensions`,
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
    [
      `${JSON_API_MEDIA_TYPE};profile="https://one.test/profile  https://two.test/profile"`,
      undefined,
    ],
    [JSON_API_MEDIA_TYPE, "gzip"],
  ])(
    "rejects unsupported representation metadata before JSON parsing",
    async (contentType, contentEncoding) => {
      const response = await profileRequest("{", {
        "Content-Type": contentType,
        ...(contentEncoding === undefined ? {} : { "Content-Encoding": contentEncoding }),
      });

      await expectJsonApiError(response, {
        status: 415,
        code: "unsupported_media_type",
        detail:
          contentEncoding === undefined
            ? `Content-Type must be ${JSON_API_MEDIA_TYPE} without unsupported extensions`
            : "Only identity-encoded JSON:API documents are supported",
      });
    },
  );

  it.each(["", "   ", '{"data":'])(
    "normalizes an empty or malformed JSON document: %j",
    async (body) => {
      const response = await profileRequest(body);

      await expectJsonApiError(response, {
        status: 400,
        code: "invalid_json",
        detail: "Invalid JSON document",
      });
    },
  );

  it("rejects invalid UTF-8 instead of parsing replacement characters", async () => {
    const response = await profileRequest(new Uint8Array([0xc3, 0x28]));

    await expectJsonApiError(response, {
      status: 400,
      code: "invalid_json",
      detail: "Invalid JSON document",
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
      detail: "Request body too large",
    });
  });

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
