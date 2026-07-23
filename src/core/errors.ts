import type { ZodError, ZodIssue } from "zod";

import type { ValidationErrorDetail } from "../models/error.js";
import { appendSchemaLink } from "./schema-links.js";

export type ErrorCode =
  | "invalid_cursor"
  | "not_authenticated"
  | "origin_not_allowed"
  | "not_found"
  | "schema_not_found"
  | "method_not_allowed"
  | "not_acceptable"
  | "profile_conflict"
  | "payload_too_large"
  | "unsupported_media_type"
  | "validation_failed"
  | "rate_limited"
  | "rate_limiter_unavailable"
  | "internal_error"
  | "jwks_unavailable"
  | "database_unavailable";

export type OperatorCode =
  | "access_jwks_unavailable"
  | "access_verifier_configuration_invalid"
  | "profile_database_unavailable"
  | "profile_limiter_unavailable"
  | "profile_repository_failure"
  | "runtime_configuration_invalid";

type ErrorCatalogEntry = Readonly<{
  status: number;
  title: string;
  safeDetails: readonly string[];
  fixedHeaders?: Readonly<Record<string, string>>;
  requiredHeaders?: readonly string[];
}>;

const catalogEntry = (
  status: number,
  title: string,
  safeDetails: readonly string[],
  options: Readonly<{
    fixedHeaders?: Readonly<Record<string, string>>;
    requiredHeaders?: readonly string[];
  }> = {},
): ErrorCatalogEntry =>
  Object.freeze({
    status,
    title,
    safeDetails: Object.freeze([...safeDetails]),
    ...(options.fixedHeaders === undefined
      ? {}
      : { fixedHeaders: Object.freeze({ ...options.fixedHeaders }) }),
    ...(options.requiredHeaders === undefined
      ? {}
      : { requiredHeaders: Object.freeze([...options.requiredHeaders]) }),
  });

export const APPLICATION_ERROR_CATALOG = Object.freeze({
  invalid_cursor: catalogEntry(400, "Bad Request", ["Invalid cursor"]),
  not_authenticated: catalogEntry(401, "Unauthorized", ["Not authenticated"], {
    fixedHeaders: { "WWW-Authenticate": 'Bearer realm="Cloudflare Access"' },
  }),
  origin_not_allowed: catalogEntry(403, "Forbidden", ["Origin not allowed"]),
  not_found: catalogEntry(404, "Not Found", ["Not Found", "Profile not found"]),
  schema_not_found: catalogEntry(404, "Not Found", ["Schema not found"]),
  method_not_allowed: catalogEntry(405, "Method Not Allowed", ["Method Not Allowed"], {
    requiredHeaders: ["Allow"],
  }),
  not_acceptable: catalogEntry(406, "Not Acceptable", [
    "Supported response formats: application/json",
    "Supported response formats: application/schema+json",
    "Supported response formats: text/html",
  ]),
  profile_conflict: catalogEntry(409, "Conflict", ["Profile already exists"]),
  payload_too_large: catalogEntry(413, "Payload Too Large", ["Request body too large"]),
  unsupported_media_type: catalogEntry(415, "Unsupported Media Type", [
    "Only identity-encoded application/json is supported",
  ]),
  validation_failed: catalogEntry(422, "Unprocessable Entity", ["validation failed"]),
  rate_limited: catalogEntry(429, "Too Many Requests", ["Rate limit exceeded"], {
    fixedHeaders: { "Retry-After": "60" },
  }),
  rate_limiter_unavailable: catalogEntry(503, "Service Unavailable", ["Rate limiter unavailable"], {
    fixedHeaders: { "Retry-After": "30" },
  }),
  internal_error: catalogEntry(500, "Internal Server Error", ["Internal Server Error"]),
  jwks_unavailable: catalogEntry(
    503,
    "Service Unavailable",
    ["Authentication service unavailable"],
    { fixedHeaders: { "Retry-After": "30" } },
  ),
  database_unavailable: catalogEntry(503, "Service Unavailable", [
    "Database temporarily unavailable",
  ]),
}) satisfies Readonly<Record<ErrorCode, ErrorCatalogEntry>>;

type AppErrorOptions = {
  status: number;
  code: ErrorCode;
  detail: string;
  errors?: ValidationErrorDetail[];
  headers?: HeadersInit;
  operatorCode?: OperatorCode;
};

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string;
  readonly errors: ValidationErrorDetail[] | undefined;
  readonly headers: Headers;
  readonly operatorCode: OperatorCode | undefined;

  constructor(options: AppErrorOptions) {
    const catalog = APPLICATION_ERROR_CATALOG[options.code];
    if (options.status !== catalog.status || !catalog.safeDetails.includes(options.detail)) {
      throw new TypeError("AppError status and detail must match the application error catalog");
    }
    if (options.code === "validation_failed") {
      if (options.errors === undefined || options.errors.length === 0) {
        throw new TypeError("Validation errors require at least one normalized issue");
      }
    } else if (options.errors !== undefined) {
      throw new TypeError("Only validation errors may include normalized issues");
    }

    const headers = new Headers(catalog.fixedHeaders);
    const suppliedHeaders = new Headers(options.headers);
    suppliedHeaders.forEach((value, name) => {
      headers.set(name, value);
    });
    for (const [name, value] of Object.entries(catalog.fixedHeaders ?? {})) {
      if (headers.get(name) !== value) {
        throw new TypeError(`AppError header ${name} must match the application error catalog`);
      }
    }
    for (const name of catalog.requiredHeaders ?? []) {
      const value = headers.get(name);
      if (value === null || value.trim() === "") {
        throw new TypeError(`AppError requires a non-empty ${name} header`);
      }
    }

    super(options.code);
    this.name = "AppError";
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = headers;
    this.operatorCode = options.operatorCode;
  }
}

const issueMessage = (issue: ZodIssue): string => {
  switch (issue.code) {
    case "invalid_type":
      return "Invalid value type";
    case "too_small":
    case "too_big":
    case "custom":
      return issue.message;
    case "invalid_format":
      return issue.format === "email" ? "Invalid email address" : issue.message;
    case "invalid_value":
      return "Invalid value";
    case "unrecognized_keys":
      return "Unexpected field";
    default:
      return "Invalid value";
  }
};

export const validationErrorsFromZod = (
  error: ZodError,
  prefix: "body" | "query",
): ValidationErrorDetail[] => {
  const details: ValidationErrorDetail[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        details.push({ location: `${prefix}.${key}`, message: issueMessage(issue) });
      }
      continue;
    }

    const path = issue.path.map(String).join(".");
    details.push({
      location: path.length > 0 ? `${prefix}.${path}` : prefix,
      message: issueMessage(issue),
    });
  }
  return details;
};

export const validationError = (errors: ValidationErrorDetail[]): AppError =>
  new AppError({
    status: 422,
    code: "validation_failed",
    detail: "validation failed",
    errors,
  });

export const zodValidationError = (error: ZodError, prefix: "body" | "query" = "body"): AppError =>
  validationError(validationErrorsFromZod(error, prefix));

export const problemResponse = (error: AppError, method = "GET"): Response => {
  const headers = new Headers(error.headers);
  headers.set("Content-Type", "application/problem+json");
  appendSchemaLink(
    headers,
    error.errors === undefined ? "ProblemResponse" : "ValidationProblemResponse",
  );

  const body = {
    title: APPLICATION_ERROR_CATALOG[error.code].title,
    status: error.status,
    detail: error.detail,
    ...(error.errors === undefined ? {} : { errors: error.errors }),
  };

  return new Response(method === "HEAD" ? null : JSON.stringify(body), {
    status: error.status,
    headers,
  });
};

export const internalError = (operatorCode?: OperatorCode): AppError =>
  new AppError({
    status: 500,
    code: "internal_error",
    detail: "Internal Server Error",
    ...(operatorCode === undefined ? {} : { operatorCode }),
  });
