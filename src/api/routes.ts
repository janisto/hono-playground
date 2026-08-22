import { createRoute, z } from "@hono/zod-openapi";
import { APPLICATION_ERROR_CATALOG, type ErrorCode } from "../core/errors.ts";
import { ErrorSourceSchema, ValidationIssueSchema } from "../models/error.ts";
import {
  GitHubActivityPageSchema,
  GitHubLanguagesSchema,
  GitHubOwnerPathSchema,
  GitHubOwnerSchema,
  GitHubRepoPathSchema,
  GitHubRepositoryPageSchema,
  GitHubRepositorySchema,
  GitHubTagPageSchema,
} from "../models/github.ts";
import { HealthResponseSchema } from "../models/health.ts";
import { GreetingSchema, HelloCreateSchema } from "../models/hello.ts";
import { ItemCategorySchema, ItemCollectionDocumentSchema } from "../models/items.ts";
import { JSON_API_MEDIA_TYPE, JsonApiObjectSchema } from "../models/json-api.ts";
import { ProfileCreateDocumentSchema, ProfileDocumentSchema, ProfileUpdateDocumentSchema } from "../models/profile.ts";

const REQUEST_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$";
const CURSOR_PATTERN = "^[!-~]+$";
const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

const requestHeaders = z.object({
  "X-Request-ID": z
    .string()
    .optional()
    .openapi({
      param: { name: "X-Request-ID", in: "header" },
      description: "Optional request ID. Missing, invalid, repeated, or comma-combined values are replaced.",
      pattern: REQUEST_ID_PATTERN,
      maxLength: 128,
    }),
});

const commonResponseHeaders = {
  "X-Request-ID": {
    required: true,
    schema: { type: "string" as const, pattern: REQUEST_ID_PATTERN, maxLength: 128 },
  },
  "Cache-Control": { required: true, schema: { type: "string" as const, const: "no-store" } },
  "X-Content-Type-Options": { required: true, schema: { type: "string" as const, const: "nosniff" } },
  "X-Frame-Options": { required: true, schema: { type: "string" as const, const: "DENY" } },
  "Referrer-Policy": {
    required: true,
    schema: { type: "string" as const, const: "strict-origin-when-cross-origin" },
  },
  Vary: { required: true, schema: { type: "string" as const } },
};

const retryAfterHeader = {
  "Retry-After": {
    required: true,
    schema: { type: "integer" as const, minimum: 0, maximum: MAX_SAFE_INTEGER },
  },
};

const githubQuotaHeaders = {
  ...retryAfterHeader,
  "X-RateLimit-Reset": {
    required: false,
    schema: { type: "integer" as const, minimum: 0, maximum: MAX_SAFE_INTEGER },
  },
};

const optionalRetryAfterHeader = {
  "Retry-After": {
    required: false,
    schema: { type: "integer" as const, minimum: 0, maximum: MAX_SAFE_INTEGER },
  },
};

const errorObject = (status: number, code: ErrorCode) => {
  const entry = APPLICATION_ERROR_CATALOG[code];
  const fields = {
    type: z.literal("about:blank"),
    title: z.literal(entry.title),
    status: z.literal(status),
    detail: z.literal(entry.detail),
    code: z.literal(code),
  };
  return code === "validation_failed"
    ? z.strictObject({ ...fields, errors: z.array(ValidationIssueSchema).min(1).max(32) })
    : z.strictObject(fields);
};

const union = <T extends z.ZodType>(schemas: readonly T[]): z.ZodType => {
  const [first, second, ...rest] = schemas;
  if (first === undefined) throw new TypeError("error schema requires a code");
  if (second === undefined) return first;
  return z.union([first, second, ...rest]);
};

const problem = (status: number, codes: readonly ErrorCode[], headers: Record<string, unknown> = {}) => ({
  description: codes.map((code) => APPLICATION_ERROR_CATALOG[code].detail).join("; "),
  headers: { ...commonResponseHeaders, ...headers },
  content: { "application/problem+json": { schema: union(codes.map((code) => errorObject(status, code))) } },
});

const jsonApiErrorObject = (status: number, code: ErrorCode) => {
  const entry = APPLICATION_ERROR_CATALOG[code];
  return z.strictObject({
    status: z.literal(String(status)),
    code: z.literal(code),
    title: z.literal(entry.title),
    detail: code === "validation_failed" ? z.string().min(1).max(200) : z.literal(entry.detail),
    source: ErrorSourceSchema.optional(),
  });
};

const jsonApiError = (status: number, codes: readonly ErrorCode[], headers: Record<string, unknown> = {}) => ({
  description: codes.map((code) => APPLICATION_ERROR_CATALOG[code].detail).join("; "),
  headers: { ...commonResponseHeaders, ...headers },
  content: {
    [JSON_API_MEDIA_TYPE]: {
      schema: z.strictObject({
        jsonapi: JsonApiObjectSchema,
        errors: z
          .array(union(codes.map((code) => jsonApiErrorObject(status, code))))
          .min(1)
          .max(32),
      }),
    },
  },
});

const publicSecurity: [] = [];
const cloudflareAccess: Array<Record<string, string[]>> = [{ CloudflareAccess: [] }];
const closedQueryDescription =
  "Query is closed: query parameters are unsupported; unknown, repeated, or malformed query input returns 400.";
const itemsQueryDescription =
  "Query is closed: only page[limit], page[cursor], and filter[category] are supported; unknown, repeated, or malformed query input returns 400.";
const githubPageQueryDescription =
  "Query is closed: only limit and cursor are supported; unknown, repeated, or malformed query input returns 400.";

const positiveInteger = (value: unknown): unknown =>
  typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : value;

const CursorSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(new RegExp(CURSOR_PATTERN, "u"))
  .openapi({ pattern: CURSOR_PATTERN });

export const ItemsQuerySchema = z.strictObject({
  "page[limit]": z.preprocess(positiveInteger, z.int().min(1).max(100).default(20)),
  "page[cursor]": CursorSchema.optional(),
  "filter[category]": ItemCategorySchema.optional(),
});

export const GitHubPageQuerySchema = z.strictObject({
  limit: z.preprocess(positiveInteger, z.int().min(1).max(100).default(20)),
  cursor: CursorSchema.optional(),
});

const ownerParams = z.strictObject({ owner: GitHubOwnerPathSchema });
const repoParams = z.strictObject({ owner: GitHubOwnerPathSchema, repo: GitHubRepoPathSchema });

const plainGetFailures = {
  400: problem(400, ["invalid_request"]),
  406: problem(406, ["not_acceptable"]),
  500: problem(500, ["internal_error"]),
};

const publicLimiterFailures = {
  429: problem(429, ["rate_limited"], retryAfterHeader),
  503: problem(503, ["dependency_unavailable"]),
};

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  description: closedQueryDescription,
  tags: ["operations"],
  security: publicSecurity,
  request: { headers: requestHeaders },
  responses: {
    200: {
      description: "Application HTTP stack is healthy",
      headers: commonResponseHeaders,
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    ...plainGetFailures,
  },
});

export const helloGetRoute = createRoute({
  method: "get",
  path: "/v1/hello",
  operationId: "getHello",
  description: closedQueryDescription,
  tags: ["hello"],
  security: publicSecurity,
  request: { headers: requestHeaders },
  responses: {
    200: {
      description: "World greeting",
      headers: commonResponseHeaders,
      content: { "application/json": { schema: GreetingSchema } },
    },
    ...plainGetFailures,
    ...publicLimiterFailures,
  },
});

export const helloPostRoute = createRoute({
  method: "post",
  path: "/v1/hello",
  operationId: "createHello",
  description: closedQueryDescription,
  tags: ["hello"],
  security: publicSecurity,
  request: {
    headers: requestHeaders,
    body: { required: true, content: { "application/json": { schema: HelloCreateSchema } } },
  },
  responses: {
    200: {
      description: "Personalized greeting",
      headers: commonResponseHeaders,
      content: { "application/json": { schema: GreetingSchema } },
    },
    400: problem(400, ["invalid_request"]),
    406: problem(406, ["not_acceptable"]),
    413: problem(413, ["payload_too_large"]),
    415: problem(415, ["unsupported_media_type"]),
    422: problem(422, ["validation_failed"]),
    429: problem(429, ["rate_limited"], retryAfterHeader),
    500: problem(500, ["internal_error"]),
    503: problem(503, ["dependency_unavailable"]),
  },
});

export const itemsRoute = createRoute({
  method: "get",
  path: "/v1/items",
  operationId: "listItems",
  description: itemsQueryDescription,
  tags: ["items"],
  security: publicSecurity,
  request: { headers: requestHeaders, query: ItemsQuerySchema },
  responses: {
    200: {
      description: "Cursor-paginated item collection",
      headers: { ...commonResponseHeaders, Link: { schema: { type: "string" as const } } },
      content: { [JSON_API_MEDIA_TYPE]: { schema: ItemCollectionDocumentSchema } },
    },
    400: jsonApiError(400, ["invalid_request"]),
    406: jsonApiError(406, ["not_acceptable"]),
    422: jsonApiError(422, ["validation_failed"]),
    429: jsonApiError(429, ["rate_limited"], retryAfterHeader),
    500: jsonApiError(500, ["internal_error"]),
    503: jsonApiError(503, ["dependency_unavailable"]),
  },
});

const profileFailures = {
  400: jsonApiError(400, ["invalid_request"]),
  406: jsonApiError(406, ["not_acceptable"]),
  429: jsonApiError(429, ["rate_limited"], retryAfterHeader),
  500: jsonApiError(500, ["internal_error"]),
  503: jsonApiError(503, ["dependency_unavailable"], optionalRetryAfterHeader),
};

export const profilePostRoute = createRoute({
  method: "post",
  path: "/v1/profile",
  operationId: "createProfile",
  description: closedQueryDescription,
  tags: ["profile"],
  security: cloudflareAccess,
  request: {
    headers: requestHeaders,
    body: { required: true, content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileCreateDocumentSchema } } },
  },
  responses: {
    201: {
      description: "Profile created",
      headers: {
        ...commonResponseHeaders,
        Location: { required: true, schema: { type: "string" as const, const: "/v1/profile" } },
      },
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileDocumentSchema } },
    },
    403: jsonApiError(403, ["forbidden", "client_generated_id_unsupported", "relationships_unsupported"]),
    409: jsonApiError(409, ["profile_exists", "profile_resource_mismatch"]),
    413: jsonApiError(413, ["payload_too_large"]),
    415: jsonApiError(415, ["unsupported_media_type"]),
    422: jsonApiError(422, ["validation_failed"]),
    ...profileFailures,
  },
});

export const profileGetRoute = createRoute({
  method: "get",
  path: "/v1/profile",
  operationId: "getProfile",
  description: closedQueryDescription,
  tags: ["profile"],
  security: cloudflareAccess,
  request: { headers: requestHeaders },
  responses: {
    200: {
      description: "Current principal profile",
      headers: commonResponseHeaders,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileDocumentSchema } },
    },
    403: jsonApiError(403, ["forbidden"]),
    404: jsonApiError(404, ["profile_not_found"]),
    ...profileFailures,
  },
});

export const profilePatchRoute = createRoute({
  method: "patch",
  path: "/v1/profile",
  operationId: "updateProfile",
  description: closedQueryDescription,
  tags: ["profile"],
  security: cloudflareAccess,
  request: {
    headers: requestHeaders,
    body: { required: true, content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileUpdateDocumentSchema } } },
  },
  responses: {
    200: {
      description: "Profile updated",
      headers: commonResponseHeaders,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileDocumentSchema } },
    },
    403: jsonApiError(403, ["forbidden", "relationships_unsupported"]),
    404: jsonApiError(404, ["profile_not_found"]),
    409: jsonApiError(409, ["profile_resource_mismatch"]),
    413: jsonApiError(413, ["payload_too_large"]),
    415: jsonApiError(415, ["unsupported_media_type"]),
    422: jsonApiError(422, ["validation_failed"]),
    ...profileFailures,
  },
});

export const profileDeleteRoute = createRoute({
  method: "delete",
  path: "/v1/profile",
  operationId: "deleteProfile",
  description: closedQueryDescription,
  tags: ["profile"],
  security: cloudflareAccess,
  request: { headers: requestHeaders },
  responses: {
    204: { description: "Profile deleted", headers: commonResponseHeaders },
    400: jsonApiError(400, ["invalid_request"]),
    403: jsonApiError(403, ["forbidden"]),
    404: jsonApiError(404, ["profile_not_found"]),
    429: jsonApiError(429, ["rate_limited"], retryAfterHeader),
    500: jsonApiError(500, ["internal_error"]),
    503: jsonApiError(503, ["dependency_unavailable"], optionalRetryAfterHeader),
  },
});

const githubFailures = {
  400: problem(400, ["invalid_request"]),
  404: problem(404, ["github_not_found"]),
  406: problem(406, ["not_acceptable"]),
  422: problem(422, ["validation_failed"]),
  429: problem(429, ["rate_limited", "github_rate_limit"], githubQuotaHeaders),
  500: problem(500, ["internal_error"]),
  502: problem(502, ["github_upstream"]),
  503: problem(503, ["dependency_unavailable"]),
  504: problem(504, ["github_timeout"]),
};

const githubRoute = <T extends ReturnType<typeof createRoute>>(route: T): T => route;

export const githubOwnerRoute = githubRoute(
  createRoute({
    method: "get",
    path: "/v1/github/owners/{owner}",
    operationId: "getGitHubOwner",
    description: closedQueryDescription,
    tags: ["github"],
    security: publicSecurity,
    request: { headers: requestHeaders, params: ownerParams },
    responses: {
      200: {
        description: "GitHub owner",
        headers: commonResponseHeaders,
        content: { "application/json": { schema: GitHubOwnerSchema } },
      },
      ...githubFailures,
    },
  }),
);

export const githubOwnerRepositoriesRoute = githubRoute(
  createRoute({
    method: "get",
    path: "/v1/github/owners/{owner}/repos",
    operationId: "listGitHubOwnerRepositories",
    description: githubPageQueryDescription,
    tags: ["github"],
    security: publicSecurity,
    request: { headers: requestHeaders, params: ownerParams, query: GitHubPageQuerySchema },
    responses: {
      200: {
        description: "GitHub repository page",
        headers: { ...commonResponseHeaders, Link: { schema: { type: "string" as const } } },
        content: { "application/json": { schema: GitHubRepositoryPageSchema } },
      },
      ...githubFailures,
    },
  }),
);

export const githubRepositoryRoute = githubRoute(
  createRoute({
    method: "get",
    path: "/v1/github/repos/{owner}/{repo}",
    operationId: "getGitHubRepository",
    description: closedQueryDescription,
    tags: ["github"],
    security: publicSecurity,
    request: { headers: requestHeaders, params: repoParams },
    responses: {
      200: {
        description: "GitHub repository",
        headers: commonResponseHeaders,
        content: { "application/json": { schema: GitHubRepositorySchema } },
      },
      ...githubFailures,
    },
  }),
);

export const githubRepositoryActivityRoute = githubRoute(
  createRoute({
    method: "get",
    path: "/v1/github/repos/{owner}/{repo}/activity",
    operationId: "listGitHubRepositoryActivity",
    description: githubPageQueryDescription,
    tags: ["github"],
    security: publicSecurity,
    request: { headers: requestHeaders, params: repoParams, query: GitHubPageQuerySchema },
    responses: {
      200: {
        description: "GitHub activity page",
        headers: { ...commonResponseHeaders, Link: { schema: { type: "string" as const } } },
        content: { "application/json": { schema: GitHubActivityPageSchema } },
      },
      ...githubFailures,
    },
  }),
);

export const githubRepositoryLanguagesRoute = githubRoute(
  createRoute({
    method: "get",
    path: "/v1/github/repos/{owner}/{repo}/languages",
    operationId: "listGitHubRepositoryLanguages",
    description: closedQueryDescription,
    tags: ["github"],
    security: publicSecurity,
    request: { headers: requestHeaders, params: repoParams },
    responses: {
      200: {
        description: "GitHub languages",
        headers: commonResponseHeaders,
        content: { "application/json": { schema: GitHubLanguagesSchema } },
      },
      ...githubFailures,
    },
  }),
);

export const githubRepositoryTagsRoute = githubRoute(
  createRoute({
    method: "get",
    path: "/v1/github/repos/{owner}/{repo}/tags",
    operationId: "listGitHubRepositoryTags",
    description: githubPageQueryDescription,
    tags: ["github"],
    security: publicSecurity,
    request: { headers: requestHeaders, params: repoParams, query: GitHubPageQuerySchema },
    responses: {
      200: {
        description: "GitHub tag page",
        headers: { ...commonResponseHeaders, Link: { schema: { type: "string" as const } } },
        content: { "application/json": { schema: GitHubTagPageSchema } },
      },
      ...githubFailures,
    },
  }),
);
