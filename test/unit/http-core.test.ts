import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { resolveRoute } from "../../src/core/routes.js";
import type { RuntimeBindings } from "../../src/core/types.js";

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
  DEPLOYMENT_PROFILE: "workers-dev-demo",
  LOG_LEVEL: "error",
  MANAGED_OAUTH_ENABLED: "false",
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
  title: string;
  status: number;
  detail: string;
  errors?: Array<{ location: string; message: string }>;
};

const expectProblem = async (
  response: Response,
  expected: Pick<Problem, "detail" | "status" | "title">,
): Promise<Problem> => {
  expect(response.status).toBe(expected.status);
  expect(response.headers.get("Content-Type")).toContain("application/problem+json");
  const body = (await response.json()) as Problem;
  expect(body).toMatchObject(expected);
  expect(body).not.toHaveProperty("type");
  expect(body).not.toHaveProperty("instance");
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

  it("preserves the validated request ID on body-limit and configuration failures", async () => {
    const smallApp = createApp({ maximumRequestBytes: 16 });
    const requestId = "bounded-request-id";
    const oversized = await smallApp.request(
      new Request(`${ORIGIN}/v1/hello`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Request-ID": requestId,
        },
        body: JSON.stringify({ name: "a value larger than sixteen bytes" }),
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

  it("adds short HSTS only for a validated production response", async () => {
    const response = await request(
      "/openapi.json",
      {},
      {
        ...TEST_BINDINGS,
        ENVIRONMENT: "production",
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
});

describe("success representation negotiation", () => {
  it.each([
    undefined,
    "",
    "application/json",
    "APPLICATION/JSON",
    "application/*",
    "*/*",
    "text/plain;q=1, application/json;q=0.25",
    "application/json;q=0.5;extension=yes",
  ])("accepts a positive JSON range: %s", async (accept) => {
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
  ])("returns 406 when JSON is not acceptably selected: %s", async (accept) => {
    const response = await request("/health", { headers: { Accept: accept } });

    await expectProblem(response, {
      title: "Not Acceptable",
      status: 406,
      detail: "Supported response formats: application/json",
    });
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(response.headers.get("Link")).toBe('</schemas/ProblemResponse.json>; rel="describedBy"');
    expectCommonHeaders(response);
  });

  it("combines repeated Accept field values as one precedence-aware list", async () => {
    const headers = new Headers();
    headers.append("Accept", "*/*;q=1");
    headers.append("Accept", "application/json;q=0");
    const response = await request("/health", { headers });

    expect(response.status).toBe(406);
  });
});

describe("known-resource method policy and strict paths", () => {
  it.each([
    ["GET", "/health", "health_get"],
    ["GET", "/v1/hello", "hello_get"],
    ["POST", "/v1/hello", "hello_create"],
    ["GET", "/v1/items", "items_list"],
    ["POST", "/v1/profile", "profile_create"],
    ["GET", "/v1/profile", "profile_get"],
    ["PATCH", "/v1/profile", "profile_update"],
    ["DELETE", "/v1/profile", "profile_delete"],
    ["GET", "/openapi.json", "openapi_get"],
    ["GET", "/api-docs", "api_docs_get"],
    ["GET", "/schemas/Greeting.json", "schema_get"],
  ])("maps %s %s to the fixed operation label %s", (method, path, operationId) => {
    expect(resolveRoute(path, method).metadata.operationId).toBe(operationId);
  });

  it.each([
    ["HEAD", "/health", "GET"],
    ["POST", "/health", "GET"],
    ["PUT", "/v1/hello", "GET, POST"],
    ["OPTIONS", "/v1/hello", "GET, POST"],
    ["POST", "/v1/items", "GET"],
    ["HEAD", "/openapi.json", "GET"],
    ["OPTIONS", "/api-docs", "GET"],
    ["HEAD", "/schemas/Greeting.json", "GET"],
    ["OPTIONS", "/v1/profile", "GET, POST, PATCH, DELETE"],
  ])("returns a complete 405 Allow for %s %s", async (method, path, allow) => {
    const response = await request(path, { method });

    if (method === "HEAD") {
      expect(response.status).toBe(405);
      expect(response.headers.get("Content-Type")).toContain("application/problem+json");
      expect(await response.text()).toBe("");
    } else {
      await expectProblem(response, {
        title: "Method Not Allowed",
        status: 405,
        detail: "Method Not Allowed",
      });
    }
    expect(response.headers.get("Allow")).toBe(allow);
    expect(response.headers.get("Link")).toBe('</schemas/ProblemResponse.json>; rel="describedBy"');
    expectCommonHeaders(response, path === "/api-docs");
  });

  it("keeps the HEAD 405 body empty while retaining problem representation headers", async () => {
    const response = await request("/health", { method: "HEAD" });

    expect(response.status).toBe(405);
    expect(response.headers.get("Content-Type")).toContain("application/problem+json");
    expect(response.headers.get("Allow")).toBe("GET");
    expect(response.headers.get("Content-Length")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("applies the method guard before negotiation and body processing", async () => {
    const response = await request("/v1/hello", {
      method: "PUT",
      headers: { Accept: "text/plain", "Content-Type": "application/cbor" },
      body: "not-json",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
  });

  it.each(["/health/", "/v1/hello/", "/v1/items/", "/openapi.json/", "/api-docs/"])(
    "does not redirect a trailing-slash path: %s",
    async (path) => {
      const response = await request(path);

      await expectProblem(response, {
        title: "Not Found",
        status: 404,
        detail: "Not Found",
      });
      expect(response.headers.has("Location")).toBe(false);
      expectCommonHeaders(response);
    },
  );

  it("rejects percent-encoded route variants before Hono dispatch or authentication", async () => {
    const verifier = vi.fn(() => Promise.resolve({ sub: "must-not-be-used" }));
    const encodedApp = createApp({ accessVerifier: verifier });
    const cases: Array<[string, string, RequestInit]> = [
      ["GET", "/%68ealth", { headers: { Accept: "text/plain" } }],
      ["HEAD", "/%68ealth", {}],
      [
        "POST",
        "/v1/%68ello",
        {
          headers: { Accept: "text/plain", "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Encoded" }),
        },
      ],
      [
        "POST",
        "/v1/%70rofile",
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: "https://attacker.invalid",
          },
          body: JSON.stringify({}),
        },
      ],
      ["GET", "/schemas/%47reeting.json", {}],
      ["GET", "/v1/%2Fitems", {}],
      ["GET", "/v1/%zz", {}],
    ];

    for (const [method, path, init] of cases) {
      const response = await encodedApp.request(
        new Request(`${ORIGIN}${path}`, { ...init, method }),
        undefined,
        TEST_BINDINGS,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
      if (method !== "HEAD") {
        await expectProblem(response, {
          title: "Not Found",
          status: 404,
          detail: "Not Found",
        });
      }
    }
    expect(verifier).not.toHaveBeenCalled();
  });

  it("uses ordinary 404 behavior for OPTIONS on an unknown resource", async () => {
    const response = await request("/not-a-route", { method: "OPTIONS" });

    expect(response.status).toBe(404);
    expect(response.headers.has("Allow")).toBe(false);
    expectCommonHeaders(response);
  });
});

describe("JSON body preconditions and ordering", () => {
  it("negotiates the success representation before touching an invalid body", async () => {
    const smallApp = createApp({ maximumRequestBytes: 8 });
    const response = await smallApp.request(
      new Request(`${ORIGIN}/v1/hello`, {
        method: "POST",
        headers: { Accept: "text/plain", "Content-Type": "application/cbor" },
        body: "this body is both unsupported and too large",
      }),
      undefined,
      TEST_BINDINGS,
    );

    expect(response.status).toBe(406);
  });

  it("returns a normalized 422 when Content-Type is missing", async () => {
    const response = await request("/v1/hello", {
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify({ name: "Jani" })),
    });

    const problem = await expectProblem(response, {
      title: "Unprocessable Entity",
      status: 422,
      detail: "validation failed",
    });
    expect(problem.errors).toEqual([{ location: "body", message: "JSON body is required" }]);
    expect(response.headers.get("Link")).toBe(
      '</schemas/ValidationProblemResponse.json>; rel="describedBy"',
    );
  });

  it.each([
    [{ "Content-Type": "text/plain" }, "not-json"],
    [{ "Content-Type": "application/cbor" }, "not-cbor"],
    [{ "Content-Type": "application/json", "Content-Encoding": "gzip" }, "{}"],
  ])("rejects unsupported representation metadata before parsing", async (headers, body) => {
    const response = await request("/v1/hello", { method: "POST", headers, body });

    await expectProblem(response, {
      title: "Unsupported Media Type",
      status: 415,
      detail: "Only identity-encoded application/json is supported",
    });
  });

  it.each(["", "   ", '{"name":'])(
    "normalizes an empty or malformed JSON body: %j",
    async (body) => {
      const response = await request("/v1/hello", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      const problem = await expectProblem(response, {
        title: "Unprocessable Entity",
        status: 422,
        detail: "validation failed",
      });
      expect(problem.errors).toEqual([{ location: "body", message: "Invalid JSON body" }]);
    },
  );

  it("rejects invalid UTF-8 instead of parsing replacement characters", async () => {
    const response = await request("/v1/hello", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0xff, 0x7d]),
    });

    const problem = await expectProblem(response, {
      title: "Unprocessable Entity",
      status: 422,
      detail: "validation failed",
    });
    expect(problem.errors).toEqual([{ location: "body", message: "Invalid JSON body" }]);
  });

  it("returns 413 for a streamed body above the configured application limit", async () => {
    const smallApp = createApp({ maximumRequestBytes: 32 });
    const response = await smallApp.request(
      new Request(`${ORIGIN}/v1/hello`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x".repeat(64) }),
      }),
      undefined,
      TEST_BINDINGS,
    );

    await expectProblem(response, {
      title: "Payload Too Large",
      status: 413,
      detail: "Request body too large",
    });
    expect(response.headers.get("Vary")).toBe("Accept");
    expect(response.headers.get("Link")).toBe('</schemas/ProblemResponse.json>; rel="describedBy"');
    expectCommonHeaders(response);
  });

  it("accepts application/json parameters and an explicit identity encoding", async () => {
    const response = await request("/v1/hello", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "identity",
      },
      body: JSON.stringify({ name: "Jani" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Hello, Jani!" });
  });
});
