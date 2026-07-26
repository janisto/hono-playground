import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import { precheckJsonApiBody } from "./body.js";
import { requireAccept, requireJsonApiAccept } from "./content-negotiation.js";
import { AppError } from "./errors.js";
import { requireSameOriginForUnsafeProfile } from "./origin.js";
import { enforcePublicRateLimit } from "./rate-limit.js";
import { isJsonApiRoute, isRepresentationBearing, resolveRoute } from "./routes.js";
import type { AppEnvironment, RouteMetadata } from "./types.js";

const BODY_METHODS = new Set(["POST", "PATCH"]);

const requiredRepresentation = (
  metadata: RouteMetadata,
): { mediaType: string; advertised: string } | undefined => {
  if (metadata.template === "/api-docs") return { mediaType: "text/html", advertised: "text/html" };
  if (metadata.template === "/openapi.json") {
    return { mediaType: "application/json", advertised: "application/json" };
  }
  if (metadata.kind === "public")
    return { mediaType: "application/json", advertised: "application/json" };
  return undefined;
};

const payloadTooLarge = (): AppError =>
  new AppError({ status: 413, code: "payload_too_large", detail: "Request body too large" });

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
          requireAccept(
            c.req.header("Accept") ?? null,
            representation.mediaType,
            representation.advertised,
          );
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
      (resolution.metadata.template === "/v1/profiles" ||
        resolution.metadata.template === "/v1/profiles/current");
    if (!expectsJsonApiBody) {
      await next();
      return;
    }

    const maximumBytes = c.get("runtimeConfig").maximumRequestBytes;
    await bodyLimit({
      maxSize: maximumBytes,
      onError: () => {
        throw payloadTooLarge();
      },
    })(c, async () => {
      await precheckJsonApiBody(c.req.raw.clone(), maximumBytes);
      await next();
    });
  };
};
