import { describe, expect, it } from "vitest";

import {
  APPLICATION_ERROR_CATALOG,
  AppError,
  jsonApiErrorResponse,
  problemResponse,
  validationError,
} from "../../src/core/errors.js";
import { MAX_VALIDATION_ERRORS } from "../../src/models/error.js";

describe("application error catalog", () => {
  it("freezes status, title, and safe-detail contracts", () => {
    expect(APPLICATION_ERROR_CATALOG.invalid_query_parameter).toMatchObject({
      status: 400,
      title: "Bad Request",
      safeDetails: ["Invalid query parameter"],
    });
    expect(APPLICATION_ERROR_CATALOG.client_generated_id_unsupported.status).toBe(403);
    expect(APPLICATION_ERROR_CATALOG.method_not_allowed.status).toBe(405);
    expect(APPLICATION_ERROR_CATALOG.resource_type_mismatch.status).toBe(409);
    expect(APPLICATION_ERROR_CATALOG.resource_identity_mismatch.status).toBe(409);
    expect(APPLICATION_ERROR_CATALOG.validation_failed).toMatchObject({
      status: 422,
      title: "Unprocessable Content",
      safeDetails: ["Request document validation failed"],
    });
    expect(Object.isFrozen(APPLICATION_ERROR_CATALOG)).toBe(true);
    for (const [code, entry] of Object.entries(APPLICATION_ERROR_CATALOG)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/u);
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
          errors: [{ detail: "private" }],
        }),
    ).toThrow("must not include normalized issues");
    expect(
      () =>
        new AppError({
          status: 422,
          code: "validation_failed",
          detail: "Request document validation failed",
        }),
    ).toThrow("at least one normalized issue");
    expect(
      () =>
        new AppError({
          status: 422,
          code: "validation_failed",
          detail: "Request document validation failed",
          errors: Array.from({ length: MAX_VALIDATION_ERRORS + 1 }, () => ({
            detail: "Invalid value",
          })),
        }),
    ).toThrow(`must not exceed ${MAX_VALIDATION_ERRORS} issues`);
    expect(
      () =>
        new AppError({
          status: 422,
          code: "validation_failed",
          detail: "Request document validation failed",
          errors: [{ detail: "Invalid value" }],
          source: { header: "Content-Type" },
        }),
    ).toThrow("sources on their normalized issues");
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

  it("composes fixed retry headers centrally", () => {
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

    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(unavailable.headers.get("Retry-After")).toBe("1");
  });

  it("serializes operational errors as RFC 9457 and resource errors as JSON:API", async () => {
    const operational = problemResponse(
      new AppError({ status: 404, code: "not_found", detail: "Not Found" }),
    );
    expect(operational.headers.get("Content-Type")).toBe("application/problem+json");
    await expect(operational.json()).resolves.toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Not Found",
      code: "not_found",
    });

    const resource = jsonApiErrorResponse(
      validationError([
        {
          detail: "Invalid value",
          source: { pointer: "/data/attributes/firstName" },
        },
      ]),
    );
    expect(resource.headers.get("Content-Type")).toBe("application/vnd.api+json");
    await expect(resource.json()).resolves.toEqual({
      jsonapi: { version: "1.1" },
      errors: [
        {
          status: "422",
          code: "validation_failed",
          title: "Unprocessable Content",
          detail: "Invalid value",
          source: { pointer: "/data/attributes/firstName" },
        },
      ],
    });

    const headerError = jsonApiErrorResponse(
      new AppError({
        status: 406,
        code: "not_acceptable",
        detail: "Supported response format: application/vnd.api+json",
        source: { header: "Accept" },
      }),
    );
    await expect(headerError.json()).resolves.toMatchObject({
      errors: [{ source: { header: "Accept" } }],
    });
  });
});
