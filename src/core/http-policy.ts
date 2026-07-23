import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";

import { precheckJsonBody } from "./body.js";
import { requireAccept } from "./content-negotiation.js";
import { AppError } from "./errors.js";
import { requireSameOriginForUnsafeProfile } from "./origin.js";
import { enforcePublicRateLimit } from "./rate-limit.js";
import { isRepresentationBearing, resolveRoute } from "./routes.js";
import type { AppEnvironment, RouteMetadata } from "./types.js";

const BODY_METHODS = new Set(["POST", "PATCH"]);

const requiredRepresentation = (
  metadata: RouteMetadata,
): { mediaType: string; advertised: string } | undefined => {
  if (metadata.template === "/api-docs") return { mediaType: "text/html", advertised: "text/html" };
  if (metadata.template === "/schemas/{schemaName}") {
    return { mediaType: "application/schema+json", advertised: "application/schema+json" };
  }
  if (metadata.template === "/openapi.json") {
    return { mediaType: "application/json", advertised: "application/json" };
  }
  if (metadata.kind === "public" || metadata.kind.startsWith("profile")) {
    return { mediaType: "application/json", advertised: "application/json" };
  }
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

    if (isRepresentationBearing(resolution.metadata, c.req.method)) {
      const representation = requiredRepresentation(resolution.metadata);
      if (representation !== undefined) {
        requireAccept(
          c.req.header("Accept") ?? null,
          representation.mediaType,
          representation.advertised,
        );
      }
    }

    if (resolution.metadata.template === "/v1/profile") {
      requireSameOriginForUnsafeProfile(c.req.raw);
    }

    if (resolution.metadata.kind === "public" || resolution.metadata.kind === "docs") {
      await enforcePublicRateLimit(c);
    }

    const expectsJsonBody =
      BODY_METHODS.has(c.req.method) &&
      (resolution.metadata.template === "/v1/hello" ||
        resolution.metadata.template === "/v1/profile");
    if (!expectsJsonBody) {
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
      await precheckJsonBody(c.req.raw.clone(), maximumBytes);
      await next();
    });
  };
};
