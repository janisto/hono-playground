import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  APPLICATION_ERROR_CATALOG,
  AppError,
  jsonApiErrorResponse,
  problemResponse,
  validationErrorsFromZod,
  zodValidationError,
} from "../../src/core/errors.ts";
import { MAX_VALIDATION_ERRORS } from "../../src/models/error.ts";

describe("portable error boundary", () => {
  it("pins every public status, code, title, and default detail", () => {
    expect(APPLICATION_ERROR_CATALOG).toMatchObject({
      invalid_request: { status: 400, title: "Bad Request", detail: "Request is malformed" },
      forbidden: { status: 403, title: "Forbidden", detail: "Access is forbidden" },
      profile_resource_mismatch: {
        status: 409,
        title: "Conflict",
        detail: "Profile resource does not match this endpoint",
      },
      validation_failed: {
        status: 422,
        title: "Unprocessable Content",
        detail: "Request validation failed",
      },
      github_upstream: {
        status: 502,
        title: "Bad Gateway",
        detail: "GitHub upstream response is invalid or unavailable",
      },
      github_timeout: { status: 504, title: "Gateway Timeout", detail: "GitHub request timed out" },
    });
    for (const code of Object.keys(APPLICATION_ERROR_CATALOG)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });

  it("rejects contradictory metadata and invalid dynamic-header states", () => {
    expect(() => new AppError({ status: 500, code: "not_found" })).toThrow("must match");
    expect(() => new AppError({ code: "not_found", detail: "private marker" })).toThrow("must match");
    expect(() => new AppError({ code: "validation_failed" })).toThrow("requires normalized issues");
    expect(() => new AppError({ code: "not_found", errors: [{ detail: "private" }] })).toThrow(
      "only validation_failed",
    );
    expect(() => new AppError({ code: "method_not_allowed" })).toThrow("requires Allow");
    expect(() => new AppError({ code: "rate_limited" })).toThrow("require a canonical Retry-After");
    expect(
      () =>
        new AppError({
          code: "validation_failed",
          errors: Array.from({ length: MAX_VALIDATION_ERRORS + 1 }, () => ({ detail: "Invalid value" })),
        }),
    ).toThrow("between 1 and 32");
  });

  it("normalizes validation issues without attacker-controlled unknown member names", () => {
    const schema = z.strictObject({
      data: z.strictObject({
        attributes: z.strictObject({ firstName: z.string().min(1) }),
      }),
    });
    const input = { data: { attributes: { firstName: "", attackerSecret: "private-marker" } } };
    const parsed = schema.safeParse(input);
    if (parsed.success) throw new Error("expected validation failure");
    const issues = validationErrorsFromZod(parsed.error, "body", input);
    expect(issues).toEqual([
      {
        detail: "Too small: expected string to have >=1 characters",
        source: { pointer: "/data/attributes/firstName" },
      },
      { detail: "Unexpected member", source: { pointer: "/data/attributes" } },
    ]);
    expect(JSON.stringify(issues)).not.toContain("attackerSecret");
    expect(JSON.stringify(issues)).not.toContain("private-marker");
  });

  it("keeps an exact 256-scalar source and omits the next larger pointer", () => {
    const atLimit = "a".repeat(255);
    const overLimit = "b".repeat(256);
    for (const [key, expected] of [
      [atLimit, { pointer: `/${atLimit}` }],
      [overLimit, undefined],
    ] as const) {
      const schema = z.strictObject({ [key]: z.string().min(1) });
      const input = { [key]: "" };
      const parsed = schema.safeParse(input);
      if (parsed.success) throw new Error("expected validation failure");

      expect(validationErrorsFromZod(parsed.error, "body", input)[0]?.source).toEqual(expected);
    }
  });

  it("caps independent issues at 31 plus the source-free truncation marker", () => {
    const shape = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, z.string()]));
    const parsed = z.strictObject(shape).safeParse({});
    if (parsed.success) throw new Error("expected validation failure");
    const issues = validationErrorsFromZod(parsed.error, "body", {});
    expect(issues).toHaveLength(MAX_VALIDATION_ERRORS);
    expect(issues.at(-1)).toEqual({ detail: "Additional validation errors omitted" });
  });

  it("serializes plain and JSON:API errors with their exact profiles", async () => {
    const operational = problemResponse(new AppError({ code: "not_found" }));
    expect(operational.headers.get("Content-Type")).toBe("application/problem+json");
    await expect(operational.json()).resolves.toEqual({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      detail: "Resource not found",
      code: "not_found",
    });

    const parsed = z.strictObject({ firstName: z.string().min(1) }).safeParse({ firstName: "" });
    if (parsed.success) throw new Error("expected validation failure");
    const resource = jsonApiErrorResponse(zodValidationError(parsed.error, "body", { firstName: "" }));
    expect(resource.headers.get("Content-Type")).toBe("application/vnd.api+json");
    await expect(resource.json()).resolves.toEqual({
      jsonapi: { version: "1.1" },
      errors: [
        {
          status: "422",
          code: "validation_failed",
          title: "Unprocessable Content",
          detail: "Too small: expected string to have >=1 characters",
          source: { pointer: "/firstName" },
        },
      ],
    });
  });
});
