import type { RouteMetadata } from "./types.js";

type RoutePolicy = RouteMetadata & { methods: readonly string[] };

const ROUTES = new Map<string, Map<string, RoutePolicy>>();

const register = (
  path: string,
  methods: readonly string[],
  operations: Readonly<Record<string, string>>,
  kindByMethod: Readonly<Record<string, RouteMetadata["kind"]>>,
): void => {
  const policies = new Map<string, RoutePolicy>();
  for (const method of methods) {
    policies.set(method, {
      template: path,
      methods,
      operationId: operations[method] ?? "methodNotAllowed",
      kind: kindByMethod[method] ?? "public",
    });
  }
  ROUTES.set(path, policies);
};

register("/health", ["GET"], { GET: "getHealth" }, {});
register("/v1/items", ["GET"], { GET: "listItems" }, { GET: "resource" });
register("/v1/profiles", ["POST"], { POST: "createProfile" }, { POST: "profile-write" });
register(
  "/v1/profiles/current",
  ["GET", "PATCH", "DELETE"],
  {
    GET: "getCurrentProfile",
    PATCH: "updateCurrentProfile",
    DELETE: "deleteCurrentProfile",
  },
  {
    GET: "profile-read",
    PATCH: "profile-write",
    DELETE: "profile-write",
  },
);
register("/openapi.json", ["GET"], { GET: "getOpenApi" }, { GET: "docs" });
register("/api-docs", ["GET"], { GET: "getApiDocs" }, { GET: "docs" });

const UNMATCHED: RouteMetadata = {
  template: "unmatched",
  operationId: "unmatched",
  kind: "unmatched",
};

const fixedDynamicPolicy = (
  template: string,
  method: string,
  allowedMethods: readonly string[],
  operationId: string,
  kind: RouteMetadata["kind"],
): RoutePolicy | undefined =>
  method === allowedMethods[0]
    ? { template, methods: allowedMethods, operationId, kind }
    : undefined;

const dynamicRoute = (
  pathname: string,
  method: string,
): { exact: RoutePolicy | undefined; fallback: RoutePolicy } | undefined => {
  if (/^\/v1\/items\/[^/]+$/u.test(pathname)) {
    const fallback: RoutePolicy = {
      template: "/v1/items/{itemId}",
      methods: ["GET"],
      operationId: "methodNotAllowed",
      kind: "resource",
    };
    return {
      exact: fixedDynamicPolicy(fallback.template, method, fallback.methods, "getItem", "resource"),
      fallback,
    };
  }
  return undefined;
};

export type RouteResolution = {
  metadata: RouteMetadata;
  allowedMethods: readonly string[] | undefined;
  knownResource: boolean;
};

export const resolveRoute = (pathname: string, method: string): RouteResolution => {
  const methodPolicies = ROUTES.get(pathname);
  if (methodPolicies !== undefined) {
    const exact = methodPolicies.get(method);
    if (exact !== undefined) {
      return { metadata: exact, allowedMethods: exact.methods, knownResource: true };
    }
    const first = methodPolicies.values().next().value as RoutePolicy | undefined;
    return {
      metadata: {
        template: first?.template ?? "unmatched",
        operationId: "methodNotAllowed",
        kind: first?.kind ?? "unmatched",
      },
      allowedMethods: first?.methods,
      knownResource: true,
    };
  }

  const dynamic = dynamicRoute(pathname, method);
  if (dynamic !== undefined) {
    return {
      metadata: dynamic.exact ?? dynamic.fallback,
      allowedMethods: dynamic.fallback.methods,
      knownResource: true,
    };
  }

  return { metadata: UNMATCHED, allowedMethods: undefined, knownResource: false };
};

export const isRepresentationBearing = (metadata: RouteMetadata): boolean =>
  metadata.kind !== "unmatched";

export const isJsonApiRoute = (metadata: RouteMetadata): boolean =>
  metadata.kind === "resource" || metadata.kind.startsWith("profile");
