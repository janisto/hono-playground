import type { core, ZodError } from "zod";

import {
  type JsonApiErrorSource,
  MAX_ERROR_SOURCE_LENGTH,
  MAX_VALIDATION_ERRORS,
  type ValidationErrorDetail,
} from "../models/error.ts";
import { JSON_API_MEDIA_TYPE, JSON_API_OBJECT } from "../models/json-api.ts";
import { scalarLength } from "../models/portable.ts";

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "client_generated_id_unsupported"
  | "relationships_unsupported"
  | "not_found"
  | "profile_not_found"
  | "github_not_found"
  | "method_not_allowed"
  | "not_acceptable"
  | "profile_exists"
  | "profile_resource_mismatch"
  | "payload_too_large"
  | "unsupported_media_type"
  | "validation_failed"
  | "rate_limited"
  | "github_rate_limit"
  | "internal_error"
  | "github_upstream"
  | "dependency_unavailable"
  | "github_timeout";

export type OperatorCode =
  | "access_jwks_unavailable"
  | "access_verifier_configuration_invalid"
  | "github_transport_failure"
  | "profile_database_unavailable"
  | "profile_limiter_unavailable"
  | "profile_repository_failure"
  | "public_limiter_unavailable"
  | "runtime_configuration_invalid";

type ErrorCatalogEntry = Readonly<{ status: number; title: string; detail: string }>;

export const APPLICATION_ERROR_CATALOG = Object.freeze({
  invalid_request: { status: 400, title: "Bad Request", detail: "Request is malformed" },
  unauthorized: { status: 401, title: "Unauthorized", detail: "Authentication is required or invalid" },
  forbidden: { status: 403, title: "Forbidden", detail: "Access is forbidden" },
  client_generated_id_unsupported: {
    status: 403,
    title: "Forbidden",
    detail: "Client-generated profile IDs are not supported",
  },
  relationships_unsupported: {
    status: 403,
    title: "Forbidden",
    detail: "Profile relationships are not supported",
  },
  not_found: { status: 404, title: "Not Found", detail: "Resource not found" },
  profile_not_found: { status: 404, title: "Not Found", detail: "Profile not found" },
  github_not_found: { status: 404, title: "Not Found", detail: "GitHub resource not found" },
  method_not_allowed: { status: 405, title: "Method Not Allowed", detail: "Method not allowed" },
  not_acceptable: {
    status: 406,
    title: "Not Acceptable",
    detail: "No acceptable response representation is available",
  },
  profile_exists: { status: 409, title: "Conflict", detail: "Profile already exists" },
  profile_resource_mismatch: {
    status: 409,
    title: "Conflict",
    detail: "Profile resource does not match this endpoint",
  },
  payload_too_large: { status: 413, title: "Content Too Large", detail: "Request body is too large" },
  unsupported_media_type: {
    status: 415,
    title: "Unsupported Media Type",
    detail: "Request representation is not supported",
  },
  validation_failed: {
    status: 422,
    title: "Unprocessable Content",
    detail: "Request validation failed",
  },
  rate_limited: { status: 429, title: "Too Many Requests", detail: "Rate limit exceeded" },
  github_rate_limit: { status: 429, title: "Too Many Requests", detail: "GitHub rate limit exceeded" },
  internal_error: { status: 500, title: "Internal Server Error", detail: "Internal server error" },
  github_upstream: {
    status: 502,
    title: "Bad Gateway",
    detail: "GitHub upstream response is invalid or unavailable",
  },
  dependency_unavailable: {
    status: 503,
    title: "Service Unavailable",
    detail: "A required dependency is unavailable",
  },
  github_timeout: { status: 504, title: "Gateway Timeout", detail: "GitHub request timed out" },
}) satisfies Readonly<Record<ErrorCode, ErrorCatalogEntry>>;

type AppErrorOptions = {
  code: ErrorCode;
  status?: number;
  detail?: string;
  errors?: ValidationErrorDetail[];
  source?: JsonApiErrorSource;
  headers?: HeadersInit;
  operatorCode?: OperatorCode;
};

const isCanonicalSafeInteger = (value: string | null): boolean => {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0;
};

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly detail: string;
  readonly errors: ValidationErrorDetail[] | undefined;
  readonly source: JsonApiErrorSource | undefined;
  readonly headers: Headers;
  readonly operatorCode: OperatorCode | undefined;

  constructor(options: AppErrorOptions) {
    const catalog = APPLICATION_ERROR_CATALOG[options.code];
    if (
      (options.status !== undefined && options.status !== catalog.status) ||
      (options.detail !== undefined && options.detail !== catalog.detail)
    ) {
      throw new TypeError("AppError status and detail must match the application error catalog");
    }
    if (
      options.errors !== undefined &&
      (options.errors.length === 0 || options.errors.length > MAX_VALIDATION_ERRORS)
    ) {
      throw new TypeError("AppError issues must contain between 1 and 32 entries");
    }
    if (options.code === "validation_failed" && options.errors === undefined) {
      throw new TypeError("validation_failed requires normalized issues");
    }
    if (options.code !== "validation_failed" && options.errors !== undefined) {
      throw new TypeError("only validation_failed may contain normalized issues");
    }
    const headers = new Headers(options.headers);
    if (options.code === "method_not_allowed" && !headers.get("Allow")?.trim()) {
      throw new TypeError("method_not_allowed requires Allow");
    }
    if (
      (options.code === "rate_limited" || options.code === "github_rate_limit") &&
      !isCanonicalSafeInteger(headers.get("Retry-After"))
    ) {
      throw new TypeError("rate-limit errors require a canonical Retry-After");
    }
    if (
      headers.has("X-RateLimit-Reset") &&
      (options.code !== "github_rate_limit" || !isCanonicalSafeInteger(headers.get("X-RateLimit-Reset")))
    ) {
      throw new TypeError("only GitHub rate-limit errors may contain a canonical X-RateLimit-Reset");
    }
    super(options.code);
    this.name = "AppError";
    this.status = catalog.status;
    this.code = options.code;
    this.detail = catalog.detail;
    this.errors = options.errors;
    this.source = options.source;
    this.headers = headers;
    this.operatorCode = options.operatorCode;
  }
}

const issueDetail = (issue: core.$ZodIssue): string => {
  switch (issue.code) {
    case "invalid_type":
      return "Invalid value type";
    case "too_small":
    case "too_big":
    case "custom":
      return issue.message.slice(0, 200) || "Invalid value";
    case "invalid_format":
      return issue.message.slice(0, 200) || "Invalid value";
    case "invalid_value":
      return "Invalid value";
    case "unrecognized_keys":
      return "Unexpected member";
    default:
      return "Invalid value";
  }
};

const encodePointerSegment = (segment: PropertyKey): string =>
  String(segment).replaceAll("~", "~0").replaceAll("/", "~1");

const hasOwnPath = (value: unknown, path: readonly PropertyKey[]): boolean => {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) return false;
    current = Reflect.get(current, segment);
  }
  return true;
};

const bodySource = (path: readonly PropertyKey[], input?: unknown): ValidationErrorDetail["source"] => {
  const existing = [...path];
  while (existing.length > 0 && input !== undefined && !hasOwnPath(input, existing)) existing.pop();
  if (existing.length === 0) return undefined;
  const pointer = `/${existing.map(encodePointerSegment).join("/")}`;
  return scalarLength(pointer) <= MAX_ERROR_SOURCE_LENGTH ? { pointer } : undefined;
};

export const validationErrorsFromZod = (
  error: ZodError,
  target: "body" | "query" | "path",
  input?: unknown,
): ValidationErrorDetail[] => {
  const details: ValidationErrorDetail[] = [];
  const append = (detail: ValidationErrorDetail): void => {
    if (details.length < MAX_VALIDATION_ERRORS - 1) details.push(detail);
  };
  for (const issue of error.issues) {
    const source =
      target === "body"
        ? bodySource(issue.path, input)
        : target === "query" && issue.path[0] !== undefined
          ? { parameter: String(issue.path[0]) }
          : undefined;
    append({ detail: issueDetail(issue), ...(source === undefined ? {} : { source }) });
    if (details.length === MAX_VALIDATION_ERRORS - 1 && error.issues.length > details.length) break;
  }
  if (error.issues.length > details.length) details.push({ detail: "Additional validation errors omitted" });
  return details.length === 0 ? [{ detail: "Invalid value" }] : details;
};

export const zodValidationError = (
  error: ZodError,
  target: "body" | "query" | "path" = "body",
  input?: unknown,
): AppError => new AppError({ code: "validation_failed", errors: validationErrorsFromZod(error, target, input) });

export const problemResponse = (
  error: AppError,
  method = "GET",
  contentType = "application/problem+json",
): Response => {
  const headers = new Headers(error.headers);
  headers.set("Content-Type", contentType);
  const body = {
    type: "about:blank",
    title: APPLICATION_ERROR_CATALOG[error.code].title,
    status: error.status,
    detail: error.detail,
    code: error.code,
    ...(error.errors === undefined ? {} : { errors: error.errors }),
  };
  return new Response(method === "HEAD" ? null : JSON.stringify(body), { status: error.status, headers });
};

export const jsonApiErrorResponse = (error: AppError, method = "GET"): Response => {
  const headers = new Headers(error.headers);
  headers.set("Content-Type", JSON_API_MEDIA_TYPE);
  const catalog = APPLICATION_ERROR_CATALOG[error.code];
  const issues = error.errors ?? [
    { detail: error.detail, ...(error.source === undefined ? {} : { source: error.source }) },
  ];
  const body = {
    jsonapi: JSON_API_OBJECT,
    errors: issues.map((issue) => ({
      status: String(error.status),
      code: error.code,
      title: catalog.title,
      detail: issue.detail,
      ...(issue.source === undefined ? {} : { source: issue.source }),
    })),
  };
  return new Response(method === "HEAD" ? null : JSON.stringify(body), { status: error.status, headers });
};

export const invalidJsonError = (): AppError => new AppError({ code: "invalid_request" });
export const internalError = (operatorCode?: OperatorCode): AppError =>
  new AppError({ code: "internal_error", ...(operatorCode === undefined ? {} : { operatorCode }) });
