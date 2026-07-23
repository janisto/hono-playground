import { describe, expect, it } from "vitest";

import {
  APPLICATION_ERROR_CATALOG,
  AppError,
  problemResponse,
  validationError,
} from "../../src/core/errors.js";

describe("application error catalog", () => {
  it("freezes the literal status, title, and safe-detail contract", () => {
    expect(
      Object.fromEntries(
        Object.entries(APPLICATION_ERROR_CATALOG).map(([code, entry]) => [
          code,
          { status: entry.status, title: entry.title, safeDetails: entry.safeDetails },
        ]),
      ),
    ).toEqual({
      invalid_cursor: { status: 400, title: "Bad Request", safeDetails: ["Invalid cursor"] },
      not_authenticated: {
        status: 401,
        title: "Unauthorized",
        safeDetails: ["Not authenticated"],
      },
      origin_not_allowed: {
        status: 403,
        title: "Forbidden",
        safeDetails: ["Origin not allowed"],
      },
      not_found: {
        status: 404,
        title: "Not Found",
        safeDetails: ["Not Found", "Profile not found"],
      },
      schema_not_found: {
        status: 404,
        title: "Not Found",
        safeDetails: ["Schema not found"],
      },
      method_not_allowed: {
        status: 405,
        title: "Method Not Allowed",
        safeDetails: ["Method Not Allowed"],
      },
      not_acceptable: {
        status: 406,
        title: "Not Acceptable",
        safeDetails: [
          "Supported response formats: application/json",
          "Supported response formats: application/schema+json",
          "Supported response formats: text/html",
        ],
      },
      profile_conflict: {
        status: 409,
        title: "Conflict",
        safeDetails: ["Profile already exists"],
      },
      payload_too_large: {
        status: 413,
        title: "Payload Too Large",
        safeDetails: ["Request body too large"],
      },
      unsupported_media_type: {
        status: 415,
        title: "Unsupported Media Type",
        safeDetails: ["Only identity-encoded application/json is supported"],
      },
      validation_failed: {
        status: 422,
        title: "Unprocessable Entity",
        safeDetails: ["validation failed"],
      },
      rate_limited: {
        status: 429,
        title: "Too Many Requests",
        safeDetails: ["Rate limit exceeded"],
      },
      rate_limiter_unavailable: {
        status: 503,
        title: "Service Unavailable",
        safeDetails: ["Rate limiter unavailable"],
      },
      internal_error: {
        status: 500,
        title: "Internal Server Error",
        safeDetails: ["Internal Server Error"],
      },
      jwks_unavailable: {
        status: 503,
        title: "Service Unavailable",
        safeDetails: ["Authentication service unavailable"],
      },
      database_unavailable: {
        status: 503,
        title: "Service Unavailable",
        safeDetails: ["Database temporarily unavailable"],
      },
    });
    expect(Object.isFrozen(APPLICATION_ERROR_CATALOG)).toBe(true);
    for (const entry of Object.values(APPLICATION_ERROR_CATALOG)) {
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.safeDetails)).toBe(true);
    }
  });

  it("rejects arbitrary status/detail/issues and missing dynamic headers", () => {
    expect(
      () => new AppError({ status: 500, code: "not_found", detail: "private marker" }),
    ).toThrow("must match the application error catalog");
    expect(
      () => new AppError({ status: 404, code: "not_found", detail: "private marker" }),
    ).toThrow("must match the application error catalog");
    expect(
      () =>
        new AppError({
          status: 404,
          code: "not_found",
          detail: "Not Found",
          errors: [{ location: "private", message: "private" }],
        }),
    ).toThrow("Only validation errors");
    expect(
      () =>
        new AppError({
          status: 422,
          code: "validation_failed",
          detail: "validation failed",
        }),
    ).toThrow("at least one normalized issue");
    expect(
      () =>
        new AppError({
          status: 405,
          code: "method_not_allowed",
          detail: "Method Not Allowed",
        }),
    ).toThrow("non-empty Allow");
    expect(
      () =>
        new AppError({
          status: 405,
          code: "method_not_allowed",
          detail: "Method Not Allowed",
          headers: { Allow: " " },
        }),
    ).toThrow("non-empty Allow");
  });

  it("composes fixed authentication and retry headers centrally", async () => {
    const unauthorized = new AppError({
      status: 401,
      code: "not_authenticated",
      detail: "Not authenticated",
    });
    const limited = new AppError({
      status: 429,
      code: "rate_limited",
      detail: "Rate limit exceeded",
    });
    const unavailable = new AppError({
      status: 503,
      code: "database_unavailable",
      detail: "Database temporarily unavailable",
      headers: { "Retry-After": "1" },
    });

    expect(unauthorized.headers.get("WWW-Authenticate")).toBe('Bearer realm="Cloudflare Access"');
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(unavailable.headers.get("Retry-After")).toBe("1");
    expect(
      await problemResponse(validationError([{ location: "body", message: "Invalid" }])).json(),
    ).toEqual({
      title: "Unprocessable Entity",
      status: 422,
      detail: "validation failed",
      errors: [{ location: "body", message: "Invalid" }],
    });
  });
});
