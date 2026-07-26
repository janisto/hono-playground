import {
  healthRoute,
  itemGetRoute,
  itemsRoute,
  profileDeleteRoute,
  profileGetRoute,
  profilePatchRoute,
  profilePostRoute,
} from "../api/routes.js";
import type { RouteMetadata } from "./types.js";

type RouteDefinition = Readonly<{
  route: Readonly<{
    path: string;
    method: string;
    operationId: string;
  }>;
  kind: RouteMetadata["kind"];
}>;

export const openApiDocumentRoute = {
  path: "/openapi.json",
  method: "get",
  operationId: "getOpenApi",
} as const;

export const apiDocumentationRoute = {
  path: "/api-docs",
  method: "get",
  operationId: "getApiDocs",
} as const;

export const ROUTE_DEFINITIONS = [
  { route: healthRoute, kind: "public" },
  { route: itemsRoute, kind: "resource" },
  { route: itemGetRoute, kind: "resource" },
  { route: profilePostRoute, kind: "profile-write" },
  { route: profileGetRoute, kind: "profile-read" },
  { route: profilePatchRoute, kind: "profile-write" },
  { route: profileDeleteRoute, kind: "profile-write" },
  { route: openApiDocumentRoute, kind: "docs" },
  { route: apiDocumentationRoute, kind: "docs" },
] satisfies readonly RouteDefinition[];

type RouteFamily = Readonly<{
  template: string;
  matcher: RegExp;
  definitions: readonly RouteDefinition[];
  allowedMethods: readonly string[];
}>;

const regexEscape = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const routeMatcher = (template: string): RegExp => {
  const source = template
    .split(/(\{[^/{}]+\})/u)
    .map((part) => (/^\{[^/{}]+\}$/u.test(part) ? "[^/]+" : regexEscape(part)))
    .join("");
  return new RegExp(`^${source}$`, "u");
};

const requestMethods = (method: string): readonly string[] => {
  const normalized = method.toUpperCase();
  return normalized === "GET" ? ["GET", "HEAD"] : [normalized];
};

const routeFamilies = (): readonly RouteFamily[] => {
  const grouped = new Map<string, RouteDefinition[]>();
  for (const definition of ROUTE_DEFINITIONS) {
    const definitions = grouped.get(definition.route.path) ?? [];
    definitions.push(definition);
    grouped.set(definition.route.path, definitions);
  }

  return [...grouped].map(([template, definitions]) => ({
    template,
    matcher: routeMatcher(template),
    definitions,
    allowedMethods: [...new Set(definitions.flatMap((definition) => requestMethods(definition.route.method)))],
  }));
};

const ROUTE_FAMILIES = routeFamilies();

const UNMATCHED: RouteMetadata = {
  template: "unmatched",
  operationId: "unmatched",
  kind: "unmatched",
};

export type RouteResolution = {
  metadata: RouteMetadata;
  allowedMethods: readonly string[] | undefined;
  knownResource: boolean;
};

export const resolveRoute = (pathname: string, method: string): RouteResolution => {
  const family = ROUTE_FAMILIES.find((candidate) => candidate.matcher.test(pathname));
  if (family === undefined) {
    return { metadata: UNMATCHED, allowedMethods: undefined, knownResource: false };
  }

  const normalizedMethod = method.toUpperCase();
  const routedMethod = normalizedMethod === "HEAD" ? "GET" : normalizedMethod;
  const definition = family.definitions.find((candidate) => candidate.route.method.toUpperCase() === routedMethod);
  if (definition !== undefined) {
    return {
      metadata: {
        template: family.template,
        operationId: definition.route.operationId,
        kind: definition.kind,
      },
      allowedMethods: family.allowedMethods,
      knownResource: true,
    };
  }

  return {
    metadata: {
      template: family.template,
      operationId: "methodNotAllowed",
      kind: family.definitions[0]?.kind ?? "unmatched",
    },
    allowedMethods: family.allowedMethods,
    knownResource: true,
  };
};

export const isRepresentationBearing = (metadata: RouteMetadata): boolean => metadata.kind !== "unmatched";

export const isJsonApiRoute = (metadata: RouteMetadata): boolean =>
  metadata.kind === "resource" || metadata.kind.startsWith("profile");
