import type { MiddlewareHandler } from "hono";
import { parseRuntimeConfig } from "./config.js";
import { parseTraceParent, requestId } from "./request-context.js";
import { resolveRoute } from "./routes.js";
import { appendVary } from "./schema-links.js";
import type { AppEnvironment, D1Metrics, RuntimeBindings } from "./types.js";

const ZERO_D1: D1Metrics = { durationMs: 0, rowsRead: 0, rowsWritten: 0 };

const API_CSP = "default-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const DOCS_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-elem 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
].join("; ");

const applyFinalHeaders = (
  response: Response,
  bindings: RuntimeBindings,
  pathname: string,
  id: string,
): void => {
  const headers = response.headers;
  headers.set("X-Request-ID", id);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", pathname === "/api-docs" ? DOCS_CSP : API_CSP);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set(
    "Permissions-Policy",
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  );
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");

  if (bindings.ENVIRONMENT === "production") {
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

  const contentType = headers.get("Content-Type")?.toLowerCase() ?? "";
  if (contentType.includes("json") || pathname === "/api-docs") appendVary(headers, "Accept");
};

const safeEnvironment = (bindings: RuntimeBindings): string => {
  const value = bindings.ENVIRONMENT;
  return value === "development" || value === "test" || value === "production" ? value : "unknown";
};

const safeCfRay = (value: string | undefined): string | undefined =>
  value !== undefined && /^[0-9a-f]{16,32}(?:-[A-Z]{3})?$/iu.test(value) ? value : undefined;

export type LifecycleOptions = {
  maximumRequestBytes?: number;
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
    c.set("traceMetadata", parseTraceParent(c.req.header("traceparent") ?? null));
    c.set("identitySubject", undefined);
    c.set("d1Metrics", { ...ZERO_D1 });
    c.set("outcome", "ok");

    await next();

    applyFinalHeaders(c.res, c.env, new URL(c.req.url).pathname, id);
    const trace = c.get("traceMetadata");
    const d1 = c.get("d1Metrics");
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
      ...(trace === undefined
        ? {}
        : { inbound_trace_id: trace.traceId, inbound_parent_span_id: trace.parentSpanId }),
      ...(version === undefined
        ? {}
        : { worker_version_id: version.id, worker_version_tag: version.tag }),
      ...(d1.durationMs === 0 && d1.rowsRead === 0 && d1.rowsWritten === 0
        ? {}
        : {
            d1_duration_ms: d1.durationMs,
            d1_rows_read: d1.rowsRead,
            d1_rows_written: d1.rowsWritten,
          }),
    };
    if (status >= 500) console.error(event);
    else console.log(event);
  };
};

export const runtimeConfiguration = (
  maximumRequestBytes?: number,
): MiddlewareHandler<AppEnvironment> => {
  return async (c, next) => {
    c.set("runtimeConfig", parseRuntimeConfig(c.env, maximumRequestBytes));
    await next();
  };
};
