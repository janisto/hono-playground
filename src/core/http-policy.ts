import type { MiddlewareHandler } from "hono";

import { precheckJsonApiBody } from "./body.ts";
import { requireAccept, requireJsonApiAccept } from "./content-negotiation.ts";
import { AppError } from "./errors.ts";
import { requireSameOriginForUnsafeProfile } from "./origin.ts";
import { enforcePublicRateLimit } from "./rate-limit.ts";
import {
  apiDocumentationRoute,
  isJsonApiRoute,
  isRepresentationBearing,
  openApiDocumentRoute,
  resolveRoute,
} from "./routes.ts";
import type { AppEnvironment, RouteMetadata } from "./types.ts";

const BODY_METHODS = new Set(["POST", "PATCH"]);

const requiredRepresentation = (metadata: RouteMetadata): { mediaType: string; advertised: string } | undefined => {
  if (metadata.template === apiDocumentationRoute.path) {
    return { mediaType: "text/html", advertised: "text/html" };
  }
  if (metadata.template === openApiDocumentRoute.path) {
    return { mediaType: "application/json", advertised: "application/json" };
  }
  if (metadata.kind === "public") return { mediaType: "application/json", advertised: "application/json" };
  return undefined;
};

export const httpPolicy = (): MiddlewareHandler<AppEnvironment> => {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.includes("%")) {
      throw new AppError({ status: 404, code: "not_found", detail: "Not Found" });
    }
    const resolution = resolveRoute(pathname, c.req.method);
    c.set("routeMetadata", resolution.metadata);

    if (resolution.knownResource && !resolution.allowedMethods?.includes(c.req.method)) {
      throw new AppError({
        status: 405,
        code: "method_not_allowed",
        detail: "Method Not Allowed",
        headers: { Allow: resolution.allowedMethods?.join(", ") ?? "" },
      });
    }

    if (isRepresentationBearing(resolution.metadata)) {
      if (isJsonApiRoute(resolution.metadata)) {
        requireJsonApiAccept(c.req.header("Accept") ?? null);
      } else {
        const representation = requiredRepresentation(resolution.metadata);
        if (representation !== undefined) {
          requireAccept(c.req.header("Accept") ?? null, representation.mediaType, representation.advertised);
        }
      }
    }

    if (resolution.metadata.template.startsWith("/v1/profiles")) {
      requireSameOriginForUnsafeProfile(c.req.raw);
    }

    if (
      resolution.metadata.kind === "public" ||
      resolution.metadata.kind === "resource" ||
      resolution.metadata.kind === "docs"
    ) {
      await enforcePublicRateLimit(c);
    }

    const expectsJsonApiBody =
      BODY_METHODS.has(c.req.method) &&
      (resolution.metadata.template === "/v1/profiles" || resolution.metadata.template === "/v1/profiles/current");
    if (!expectsJsonApiBody) {
      await next();
      return;
    }

    const maximumBytes = c.get("runtimeConfig").maximumRequestBytes;
    c.set("jsonApiBodyText", await precheckJsonApiBody(c.req.raw.clone(), maximumBytes));
    await next();
  };
};
