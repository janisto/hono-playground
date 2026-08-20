import {
  githubOwnerRepositoriesRoute,
  githubOwnerRoute,
  githubRepositoryActivityRoute,
  githubRepositoryLanguagesRoute,
  githubRepositoryRoute,
  githubRepositoryTagsRoute,
  healthRoute,
  helloGetRoute,
  helloPostRoute,
  itemsRoute,
  profileDeleteRoute,
  profileGetRoute,
  profilePatchRoute,
  profilePostRoute,
} from "../api/routes.ts";
import type { RequestMediaProfile } from "./body.ts";
import type { RouteMetadata } from "./types.ts";

type RouteDefinition = Readonly<{
  route: Readonly<{ path: string; method: string; operationId: string }>;
  kind: RouteMetadata["kind"];
  queryNames?: readonly string[];
  bodyProfile?: RequestMediaProfile;
}>;

export const openApiDocumentRoute = {
  path: "/openapi.json",
  method: "get",
  operationId: "getOpenApiDocument",
} as const;

export const apiDocumentationRoute = { path: "/api-docs", method: "get", operationId: "getApiDocs" } as const;

const PAGINATION_QUERY = ["limit", "cursor"] as const;
const ITEM_QUERY = ["page[limit]", "page[cursor]", "filter[category]"] as const;

export const ROUTE_DEFINITIONS = [
  { route: healthRoute, kind: "plain-public" },
  { route: helloGetRoute, kind: "plain-public" },
  { route: helloPostRoute, kind: "plain-public", bodyProfile: "json" },
  { route: itemsRoute, kind: "json-api-public", queryNames: ITEM_QUERY },
  { route: profilePostRoute, kind: "profile-write", bodyProfile: "json-api" },
  { route: profileGetRoute, kind: "profile-read" },
  { route: profilePatchRoute, kind: "profile-write", bodyProfile: "json-api" },
  { route: profileDeleteRoute, kind: "profile-write" },
  { route: githubOwnerRoute, kind: "plain-public" },
  { route: githubOwnerRepositoriesRoute, kind: "plain-public", queryNames: PAGINATION_QUERY },
  { route: githubRepositoryRoute, kind: "plain-public" },
  { route: githubRepositoryActivityRoute, kind: "plain-public", queryNames: PAGINATION_QUERY },
  { route: githubRepositoryLanguagesRoute, kind: "plain-public" },
  { route: githubRepositoryTagsRoute, kind: "plain-public", queryNames: PAGINATION_QUERY },
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

const requestMethods = (method: string): readonly string[] =>
  method.toUpperCase() === "GET" ? ["GET", "HEAD"] : [method.toUpperCase()];

const grouped = new Map<string, RouteDefinition[]>();
for (const definition of ROUTE_DEFINITIONS) {
  const definitions = grouped.get(definition.route.path) ?? [];
  definitions.push(definition);
  grouped.set(definition.route.path, definitions);
}
const ROUTE_FAMILIES: readonly RouteFamily[] = [...grouped].map(([template, definitions]) => ({
  template,
  matcher: routeMatcher(template),
  definitions,
  allowedMethods: [...new Set(definitions.flatMap((definition) => requestMethods(definition.route.method)))],
}));

const EMPTY_QUERY = new Set<string>();
const UNMATCHED: RouteMetadata = {
  template: "unmatched",
  operationId: "unmatched",
  kind: "unmatched",
  queryNames: EMPTY_QUERY,
};

export type RouteResolution = Readonly<{
  metadata: RouteMetadata;
  allowedMethods: readonly string[] | undefined;
  knownResource: boolean;
}>;

const metadataFor = (definition: RouteDefinition, template: string): RouteMetadata => ({
  template,
  operationId: definition.route.operationId,
  kind: definition.kind,
  queryNames: new Set(definition.queryNames ?? []),
  ...(definition.bodyProfile === undefined ? {} : { bodyProfile: definition.bodyProfile }),
});

export const resolveRoute = (pathname: string, method: string): RouteResolution => {
  const family = ROUTE_FAMILIES.find((candidate) => candidate.matcher.test(pathname));
  if (family === undefined) return { metadata: UNMATCHED, allowedMethods: undefined, knownResource: false };
  const routed = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  const definition = family.definitions.find((candidate) => candidate.route.method.toUpperCase() === routed);
  if (definition !== undefined) {
    return {
      metadata: metadataFor(definition, family.template),
      allowedMethods: family.allowedMethods,
      knownResource: true,
    };
  }
  const first = family.definitions[0];
  return {
    metadata:
      first === undefined ? UNMATCHED : { ...metadataFor(first, family.template), operationId: "methodNotAllowed" },
    allowedMethods: family.allowedMethods,
    knownResource: true,
  };
};

export const isJsonApiRoute = (metadata: RouteMetadata): boolean =>
  metadata.kind === "json-api-public" || metadata.kind.startsWith("profile");

export const isPublicRateLimited = (metadata: RouteMetadata): boolean =>
  metadata.template.startsWith("/v1/") && !metadata.kind.startsWith("profile");
