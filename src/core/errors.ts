import type { ZodError, ZodIssue } from "zod";

import { MAX_VALIDATION_ERRORS, type ValidationErrorDetail } from "../models/error.js";
import { JSON_API_MEDIA_TYPE, JSON_API_OBJECT } from "../models/json-api.js";

export type ErrorCode =
  | "invalid_cursor"
  | "invalid_query_parameter"
  | "invalid_json"
  | "not_authenticated"
  | "origin_not_allowed"
  | "client_generated_id_unsupported"
  | "not_found"
  | "method_not_allowed"
  | "not_acceptable"
  | "resource_type_mismatch"
  | "resource_identity_mismatch"
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
  invalid_query_parameter: catalogEntry(400, "Bad Request", ["Invalid query parameter"]),
  invalid_json: catalogEntry(400, "Bad Request", ["Invalid JSON document"]),
  not_authenticated: catalogEntry(401, "Unauthorized", ["Not authenticated"], {
    fixedHeaders: { "WWW-Authenticate": 'Bearer realm="Cloudflare Access"' },
  }),
  origin_not_allowed: catalogEntry(403, "Forbidden", ["Origin not allowed"]),
  client_generated_id_unsupported: catalogEntry(403, "Forbidden", [
    "Client-generated profile IDs are not supported",
  ]),
  not_found: catalogEntry(404, "Not Found", ["Not Found", "Item not found", "Profile not found"]),
  method_not_allowed: catalogEntry(405, "Method Not Allowed", ["Method Not Allowed"], {
    requiredHeaders: ["Allow"],
  }),
  not_acceptable: catalogEntry(406, "Not Acceptable", [
    `Supported response format: ${JSON_API_MEDIA_TYPE}`,
    "Supported response format: application/json",
    "Supported response format: text/html",
  ]),
  resource_type_mismatch: catalogEntry(409, "Conflict", ["Resource type does not match endpoint"]),
  resource_identity_mismatch: catalogEntry(409, "Conflict", [
    "Resource ID does not match the current profile",
  ]),
  profile_conflict: catalogEntry(409, "Conflict", ["Profile already exists"]),
  payload_too_large: catalogEntry(413, "Content Too Large", ["Request body too large"]),
  unsupported_media_type: catalogEntry(415, "Unsupported Media Type", [
    `Content-Type must be ${JSON_API_MEDIA_TYPE} without unsupported extensions`,
    "Only identity-encoded JSON:API documents are supported",
  ]),
  validation_failed: catalogEntry(422, "Unprocessable Content", [
    "Request document validation failed",
  ]),
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

const allowsIssues = (code: ErrorCode): boolean =>
  code === "validation_failed" || code === "invalid_query_parameter";

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
    if (allowsIssues(options.code)) {
      if (options.errors === undefined || options.errors.length === 0) {
        throw new TypeError("Validation errors require at least one normalized issue");
      }
      if (options.errors.length > MAX_VALIDATION_ERRORS) {
        throw new TypeError(`Validation errors must not exceed ${MAX_VALIDATION_ERRORS} issues`);
      }
    } else if (options.errors !== undefined) {
      throw new TypeError("This application error must not include normalized issues");
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

const issueDetail = (issue: ZodIssue): string => {
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
      return "Unexpected member";
    default:
      return "Invalid value";
  }
};

const encodeJsonPointerSegment = (segment: PropertyKey): string =>
  String(segment).replaceAll("~", "~0").replaceAll("/", "~1");

const bodySource = (path: readonly PropertyKey[]): ValidationErrorDetail["source"] => {
  if (path.length === 0) return undefined;
  return { pointer: `/${path.map(encodeJsonPointerSegment).join("/")}` };
};

const querySource = (
  path: readonly PropertyKey[],
  fallback?: string,
): ValidationErrorDetail["source"] => {
  const parameter = path.length > 0 ? String(path[0]) : fallback;
  return parameter === undefined ? undefined : { parameter };
};

export const validationErrorsFromZod = (
  error: ZodError,
  target: "body" | "query",
): ValidationErrorDetail[] => {
  const details: ValidationErrorDetail[] = [];
  let truncated = false;
  const append = (detail: ValidationErrorDetail): boolean => {
    if (details.length < MAX_VALIDATION_ERRORS - 1) {
      details.push(detail);
      return true;
    }
    truncated = true;
    return false;
  };

  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const path = [...issue.path, key];
        const source =
          target === "body"
            ? { pointer: `/${path.map(encodeJsonPointerSegment).join("/")}` }
            : querySource(issue.path, key);
        if (
          !append({
            detail: issueDetail(issue),
            ...(source === undefined ? {} : { source }),
          })
        ) {
          break;
        }
      }
    } else {
      const source =
        target === "body"
          ? bodySource(issue.path)
          : querySource(issue.path.map((segment) => String(segment)));
      append({
        detail: issueDetail(issue),
        ...(source === undefined ? {} : { source }),
      });
    }

    if (truncated) break;
  }
  if (truncated) {
    details.push({ detail: "Additional validation errors omitted" });
  }
  return details;
};

export const validationError = (
  errors: ValidationErrorDetail[],
  target: "body" | "query" = "body",
): AppError =>
  target === "query"
    ? new AppError({
        status: 400,
        code: "invalid_query_parameter",
        detail: "Invalid query parameter",
        errors,
      })
    : new AppError({
        status: 422,
        code: "validation_failed",
        detail: "Request document validation failed",
        errors,
      });

export const zodValidationError = (error: ZodError, target: "body" | "query" = "body"): AppError =>
  validationError(validationErrorsFromZod(error, target), target);

export const problemResponse = (error: AppError, method = "GET"): Response => {
  const headers = new Headers(error.headers);
  headers.set("Content-Type", "application/problem+json");

  const body = {
    type: "about:blank",
    title: APPLICATION_ERROR_CATALOG[error.code].title,
    status: error.status,
    detail: error.detail,
    code: error.code,
  };

  return new Response(method === "HEAD" ? null : JSON.stringify(body), {
    status: error.status,
    headers,
  });
};

export const jsonApiErrorResponse = (error: AppError, method = "GET"): Response => {
  const headers = new Headers(error.headers);
  headers.set("Content-Type", JSON_API_MEDIA_TYPE);

  const catalog = APPLICATION_ERROR_CATALOG[error.code];
  const errors = (error.errors ?? [{ detail: error.detail }]).map((issue) => ({
    status: String(error.status),
    code: error.code,
    title: catalog.title,
    detail: issue.detail,
    ...(issue.source === undefined ? {} : { source: issue.source }),
  }));
  const body = { jsonapi: JSON_API_OBJECT, errors };

  return new Response(method === "HEAD" ? null : JSON.stringify(body), {
    status: error.status,
    headers,
  });
};

export const invalidJsonError = (): AppError =>
  new AppError({
    status: 400,
    code: "invalid_json",
    detail: "Invalid JSON document",
  });

export const internalError = (operatorCode?: OperatorCode): AppError =>
  new AppError({
    status: 500,
    code: "internal_error",
    detail: "Internal Server Error",
    ...(operatorCode === undefined ? {} : { operatorCode }),
  });
