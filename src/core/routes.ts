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
      operationId: operations[method] ?? "method_not_allowed",
      kind: kindByMethod[method] ?? "public",
    });
  }
  ROUTES.set(path, policies);
};

register("/health", ["GET"], { GET: "health_get" }, {});
register(
  "/v1/hello",
  ["GET", "POST"],
  { GET: "hello_get", POST: "hello_create" },
  { POST: "public" },
);
register("/v1/items", ["GET"], { GET: "items_list" }, {});
register(
  "/v1/profile",
  ["GET", "POST", "PATCH", "DELETE"],
  {
    GET: "profile_get",
    POST: "profile_create",
    PATCH: "profile_update",
    DELETE: "profile_delete",
  },
  {
    GET: "profile-read",
    POST: "profile-write",
    PATCH: "profile-write",
    DELETE: "profile-write",
  },
);
register("/openapi.json", ["GET"], { GET: "openapi_get" }, { GET: "docs" });
register("/api-docs", ["GET"], { GET: "api_docs_get" }, { GET: "docs" });

const UNMATCHED: RouteMetadata = {
  template: "unmatched",
  operationId: "unmatched",
  kind: "unmatched",
};

const schemaPolicy = (method: string): RoutePolicy | undefined => {
  if (method !== "GET") return undefined;
  return {
    template: "/schemas/{schemaName}",
    operationId: "schema_get",
    kind: "docs",
    methods: ["GET"],
  };
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
        operationId: "method_not_allowed",
        kind: first?.kind ?? "unmatched",
      },
      allowedMethods: first?.methods,
      knownResource: true,
    };
  }

  if (/^\/schemas\/[^/]+$/.test(pathname)) {
    const exact = schemaPolicy(method);
    return {
      metadata:
        exact ??
        ({
          template: "/schemas/{schemaName}",
          operationId: "method_not_allowed",
          kind: "docs",
        } satisfies RouteMetadata),
      allowedMethods: ["GET"],
      knownResource: true,
    };
  }

  return { metadata: UNMATCHED, allowedMethods: undefined, knownResource: false };
};

export const isRepresentationBearing = (metadata: RouteMetadata, method: string): boolean =>
  metadata.kind !== "unmatched" && !(metadata.template === "/v1/profile" && method === "DELETE");

export const isJsonApiRoute = (metadata: RouteMetadata): boolean =>
  metadata.kind === "public" || metadata.kind.startsWith("profile");
