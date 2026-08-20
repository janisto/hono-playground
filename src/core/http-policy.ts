import type { MiddlewareHandler } from "hono";
import { precheckBodyHeaders, precheckDeclaredBodySize } from "./body.ts";
import { requireAccept, requireJsonApiAccept } from "./content-negotiation.ts";
import { AppError } from "./errors.ts";
import { requireTrustedOriginForUnsafeProfile } from "./origin.ts";
import { parseClosedQuery, validateCursorInput } from "./query.ts";
import { enforcePublicRateLimit } from "./rate-limit.ts";
import { apiDocumentationRoute, isJsonApiRoute, isPublicRateLimited, resolveRoute } from "./routes.ts";
import type { AppEnvironment } from "./types.ts";

export const httpPolicy = (): MiddlewareHandler<AppEnvironment> => async (c, next) => {
  const pathname = new URL(c.req.url).pathname;
  if (pathname.includes("%")) throw new AppError({ code: "not_found" });
  const resolution = resolveRoute(pathname, c.req.method);
  c.set("routeMetadata", resolution.metadata);
  if (resolution.knownResource && !resolution.allowedMethods?.includes(c.req.method.toUpperCase())) {
    throw new AppError({
      code: "method_not_allowed",
      headers: { Allow: resolution.allowedMethods?.join(", ") ?? "" },
    });
  }

  const parsedQuery = resolution.knownResource
    ? parseClosedQuery(c.req.url, resolution.metadata.queryNames)
    : new Map<string, string>();
  c.set("parsedQuery", parsedQuery);
  for (const cursorName of ["cursor", "page[cursor]"]) {
    const cursor = parsedQuery.get(cursorName);
    if (cursor !== undefined) validateCursorInput(cursor, cursorName);
  }

  if (resolution.metadata.bodyProfile !== undefined) {
    precheckDeclaredBodySize(c.req.raw, c.get("runtimeConfig").maximumRequestBytes);
  }

  const bodylessSuccess = resolution.metadata.template === "/v1/profile" && c.req.method === "DELETE";
  let selectedContentType: string | undefined;
  if (!bodylessSuccess && resolution.metadata.kind !== "unmatched") {
    if (isJsonApiRoute(resolution.metadata)) selectedContentType = requireJsonApiAccept(c.req.header("Accept") ?? null);
    else if (resolution.metadata.template === apiDocumentationRoute.path) {
      selectedContentType = requireAccept(c.req.header("Accept") ?? null, "text/html");
    } else {
      selectedContentType = requireAccept(c.req.header("Accept") ?? null, "application/json");
    }
  }

  if (resolution.metadata.template === "/v1/profile") {
    c.set("variesByOrigin", c.req.header("Origin") !== undefined);
    requireTrustedOriginForUnsafeProfile(c.req.raw, c.get("runtimeConfig").publicOrigin);
  }

  if (resolution.metadata.bodyProfile !== undefined) {
    c.set(
      "bodyHeaders",
      precheckBodyHeaders(c.req.raw, c.get("runtimeConfig").maximumRequestBytes, resolution.metadata.bodyProfile),
    );
  }

  if (isPublicRateLimited(resolution.metadata)) await enforcePublicRateLimit(c);
  await next();
  if (selectedContentType !== undefined && c.res.status < 400 && c.res.status !== 204) {
    c.res.headers.set("Content-Type", selectedContentType);
  }
};
