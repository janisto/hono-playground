import type { MiddlewareHandler } from "hono";
import { SWAGGER_UI_BOOTSTRAP_CSP_SOURCE, SWAGGER_UI_BUNDLE_CSP_SOURCE } from "../docs/swagger.ts";
import { parseRuntimeConfig } from "./config.ts";
import { requestId } from "./request-context.ts";
import { apiDocumentationRoute, resolveRoute } from "./routes.ts";
import type { AppEnvironment, RuntimeBindings } from "./types.ts";

const API_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const DOCS_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  `script-src ${SWAGGER_UI_BOOTSTRAP_CSP_SOURCE} ${SWAGGER_UI_BUNDLE_CSP_SOURCE}`,
  `script-src-elem ${SWAGGER_UI_BOOTSTRAP_CSP_SOURCE} ${SWAGGER_UI_BUNDLE_CSP_SOURCE}`,
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src-elem 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' https://cdn.jsdelivr.net",
  "connect-src 'self'",
].join("; ");

const appendVary = (headers: Headers, fieldName: string): void => {
  const fields: string[] = [];
  for (const field of (headers.get("Vary") ?? "").split(",")) {
    const trimmed = field.trim();
    if (trimmed && !fields.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      fields.push(trimmed);
    }
  }
  if (!fields.some((field) => field.toLowerCase() === fieldName.toLowerCase())) fields.push(fieldName);
  headers.set("Vary", fields.join(", "));
};

const applyFinalHeaders = (
  response: Response,
  bindings: RuntimeBindings,
  pathname: string,
  id: string,
  variesByOrigin: boolean,
): void => {
  const headers = response.headers;
  headers.set("X-Request-ID", id);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", pathname === apiDocumentationRoute.path ? DOCS_CSP : API_CSP);

  if (bindings.ENVIRONMENT === "staging" || bindings.ENVIRONMENT === "production") {
    headers.set("Strict-Transport-Security", "max-age=300");
  } else {
    headers.delete("Strict-Transport-Security");
  }

  for (const name of [
    "Access-Control-Allow-Credentials",
    "Access-Control-Allow-Headers",
    "Access-Control-Allow-Methods",
    "Access-Control-Allow-Origin",
    "Access-Control-Expose-Headers",
    "Access-Control-Max-Age",
  ]) {
    headers.delete(name);
  }

  appendVary(headers, "Accept");
  if (variesByOrigin) appendVary(headers, "Origin");
};

const safeEnvironment = (bindings: RuntimeBindings): string => {
  const value = bindings.ENVIRONMENT;
  return value === "development" || value === "staging" || value === "test" || value === "production"
    ? value
    : "unknown";
};

const safeCfRay = (value: string | undefined): string | undefined =>
  value !== undefined && /^[0-9a-f]{16,32}(?:-[A-Z]{3})?$/iu.test(value) ? value : undefined;

export type LifecycleOptions = {
  now?: () => number;
};

export const lifecycle = (options: LifecycleOptions = {}): MiddlewareHandler<AppEnvironment> => {
  const now = options.now ?? Date.now;
  return async (c, next) => {
    const startedAt = now();
    const id = requestId(c.req.header("X-Request-ID") ?? null);
    const { metadata } = resolveRoute(new URL(c.req.url).pathname, c.req.method);
    c.set("requestId", id);
    c.set("routeMetadata", metadata);
    c.set("identitySubject", undefined);
    c.set("bodyText", undefined);
    c.set("bodyHeaders", undefined);
    c.set("parsedQuery", new Map());
    c.set("variesByOrigin", false);
    c.set("outcome", "ok");

    await next();

    applyFinalHeaders(c.res, c.env, new URL(c.req.url).pathname, id, c.get("variesByOrigin"));
    const version = c.env.CF_VERSION_METADATA;
    const status = c.res.status;
    const cfRay = safeCfRay(c.req.header("CF-Ray"));
    const event = {
      schema_version: 1,
      event: "http.access",
      level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      request_id: id,
      method: c.req.method,
      route_template: metadata.template,
      operation_id: metadata.operationId,
      status,
      latency_ms: Math.max(0, now() - startedAt),
      outcome: c.get("outcome"),
      environment: safeEnvironment(c.env),
      ...(cfRay === undefined ? {} : { cf_ray: cfRay }),
      ...(version === undefined ? {} : { worker_version_id: version.id, worker_version_tag: version.tag }),
    };
    if (status >= 500) console.error(event);
    else console.log(event);
  };
};

export const runtimeConfiguration = (maximumRequestBytes?: number): MiddlewareHandler<AppEnvironment> => {
  return async (c, next) => {
    const metadata = c.get("routeMetadata");
    if (metadata.template === "/health" || metadata.kind === "docs") {
      const environment = c.env.ENVIRONMENT;
      c.set("runtimeConfig", {
        environment:
          environment === "development" ||
          environment === "staging" ||
          environment === "test" ||
          environment === "production"
            ? environment
            : "test",
        maximumRequestBytes: 1_000_000,
        rateLimitMode: "none",
        publicOrigin: "https://hono-playground.dev",
      });
    } else {
      c.set("runtimeConfig", parseRuntimeConfig(c.env, maximumRequestBytes));
    }
    await next();
  };
};
