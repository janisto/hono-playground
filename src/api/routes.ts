import { createRoute, z } from "@hono/zod-openapi";

import { JsonApiErrorDocumentSchema, ProblemResponseSchema } from "../models/error.js";
import { HealthResponseSchema } from "../models/health.js";
import { ItemCategorySchema, ItemCollectionDocumentSchema, ItemDocumentSchema } from "../models/items.js";
import { JSON_API_MEDIA_TYPE } from "../models/json-api.js";
import { ProfileCreateDocumentSchema, ProfileDocumentSchema, ProfileUpdateDocumentSchema } from "../models/profile.js";

const commonHeaders = {
  "X-Request-ID": { schema: { type: "string" as const } },
  Vary: { schema: { type: "string" as const } },
};

const problem = (description: string) => ({
  description,
  headers: commonHeaders,
  content: { "application/problem+json": { schema: ProblemResponseSchema } },
});

const jsonApiError = (description: string) => ({
  description,
  headers: commonHeaders,
  content: { [JSON_API_MEDIA_TYPE]: { schema: JsonApiErrorDocumentSchema } },
});

const methodNotAllowedProblem = {
  ...problem("Method not allowed"),
  headers: {
    ...commonHeaders,
    Allow: { schema: { type: "string" as const }, description: "Complete allowed-method list" },
  },
};

const methodNotAllowedJsonApi = {
  ...jsonApiError("Method not allowed"),
  headers: {
    ...commonHeaders,
    Allow: { schema: { type: "string" as const }, description: "Complete allowed-method list" },
  },
};

const rateLimitJsonApi = {
  ...jsonApiError("Application rate limit exceeded"),
  headers: {
    ...commonHeaders,
    "Retry-After": { schema: { type: "string" as const }, description: "Retry delay in seconds" },
  },
};

const rateLimitProblem = {
  ...problem("Application rate limit exceeded"),
  headers: {
    ...commonHeaders,
    "Retry-After": { schema: { type: "string" as const }, description: "Retry delay in seconds" },
  },
};

const jsonApiCommon = {
  405: methodNotAllowedJsonApi,
  406: jsonApiError("No acceptable JSON:API representation"),
  429: rateLimitJsonApi,
  500: jsonApiError("Internal server error"),
};

const jsonApiBodyFailures = {
  400: jsonApiError("Malformed JSON document or invalid query parameter"),
  413: jsonApiError("Request body too large"),
  415: jsonApiError("Unsupported request representation"),
  422: jsonApiError("Request document validation failed"),
};

const singletonQueryValue = (value: unknown): unknown =>
  Array.isArray(value) && value.length === 1 ? value[0] : value;

const positiveIntegerQuery = (value: unknown): unknown => {
  const scalar = singletonQueryValue(value);
  if (typeof scalar !== "string" || !/^[0-9]+$/u.test(scalar)) return scalar;
  return Number(scalar);
};

export const ItemsQuerySchema = z.strictObject({
  "page[limit]": z.preprocess(
    positiveIntegerQuery,
    z
      .int({ error: "Page limit must be an integer" })
      .min(1, { error: "Page limit must be at least 1" })
      .max(100, { error: "Page limit must be at most 100" })
      .default(20),
  ),
  "page[cursor]": z.preprocess(
    singletonQueryValue,
    z.string().min(1, { error: "Cursor must not be empty" }).max(2048, { error: "Cursor is too long" }).optional(),
  ),
  "filter[category]": z.preprocess(singletonQueryValue, ItemCategorySchema.optional()),
});

const EmptyQuerySchema = z.strictObject({});

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "getHealth",
  tags: ["operations"],
  responses: {
    200: {
      description: "Worker process is healthy",
      headers: commonHeaders,
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    405: methodNotAllowedProblem,
    406: problem("No acceptable health representation"),
    429: rateLimitProblem,
    500: problem("Internal server error"),
  },
});

export const itemsRoute = createRoute({
  method: "get",
  path: "/v1/items",
  operationId: "listItems",
  tags: ["items"],
  request: { query: ItemsQuerySchema },
  responses: {
    200: {
      description: "Cursor-paginated item collection",
      headers: commonHeaders,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ItemCollectionDocumentSchema } },
    },
    400: jsonApiError("Invalid query parameter or cursor"),
    ...jsonApiCommon,
  },
});

export const itemGetRoute = createRoute({
  method: "get",
  path: "/v1/items/{itemId}",
  operationId: "getItem",
  tags: ["items"],
  request: {
    params: z.strictObject({
      itemId: z.string().min(1).max(128),
    }),
    query: EmptyQuerySchema,
  },
  responses: {
    200: {
      description: "Item resource",
      headers: commonHeaders,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ItemDocumentSchema } },
    },
    400: jsonApiError("Invalid query parameter"),
    404: jsonApiError("Item does not exist"),
    ...jsonApiCommon,
  },
});

const profileErrors = {
  403: jsonApiError("Access assertion is missing or invalid, or request is forbidden"),
  429: rateLimitJsonApi,
  500: jsonApiError("Internal server error"),
  503: {
    ...jsonApiError("Profile dependency temporarily unavailable"),
    headers: { ...commonHeaders, "Retry-After": { schema: { type: "string" as const } } },
  },
};

const cloudflareAccess: Array<Record<string, string[]>> = [{ CloudflareAccess: [] }];

export const profilePostRoute = createRoute({
  method: "post",
  path: "/v1/profiles",
  operationId: "createProfile",
  tags: ["profiles"],
  security: cloudflareAccess,
  request: {
    query: EmptyQuerySchema,
    body: {
      required: true,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileCreateDocumentSchema } },
    },
  },
  responses: {
    201: {
      description: "Profile created",
      headers: {
        ...commonHeaders,
        Location: { schema: { type: "string" as const } },
      },
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileDocumentSchema } },
    },
    409: jsonApiError("Profile already exists or resource type conflicts"),
    ...jsonApiBodyFailures,
    ...jsonApiCommon,
    ...profileErrors,
  },
});

export const profileGetRoute = createRoute({
  method: "get",
  path: "/v1/profiles/current",
  operationId: "getCurrentProfile",
  tags: ["profiles"],
  security: cloudflareAccess,
  request: { query: EmptyQuerySchema },
  responses: {
    200: {
      description: "Current identity profile",
      headers: commonHeaders,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileDocumentSchema } },
    },
    400: jsonApiError("Invalid query parameter"),
    404: jsonApiError("Profile does not exist"),
    ...jsonApiCommon,
    ...profileErrors,
  },
});

export const profilePatchRoute = createRoute({
  method: "patch",
  path: "/v1/profiles/current",
  operationId: "updateCurrentProfile",
  tags: ["profiles"],
  security: cloudflareAccess,
  request: {
    query: EmptyQuerySchema,
    body: {
      required: true,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileUpdateDocumentSchema } },
    },
  },
  responses: {
    200: {
      description: "Profile updated",
      headers: commonHeaders,
      content: { [JSON_API_MEDIA_TYPE]: { schema: ProfileDocumentSchema } },
    },
    404: jsonApiError("Profile does not exist"),
    409: jsonApiError("Resource type or ID does not match the endpoint"),
    ...jsonApiBodyFailures,
    ...jsonApiCommon,
    ...profileErrors,
  },
});

export const profileDeleteRoute = createRoute({
  method: "delete",
  path: "/v1/profiles/current",
  operationId: "deleteCurrentProfile",
  tags: ["profiles"],
  security: cloudflareAccess,
  request: { query: EmptyQuerySchema },
  responses: {
    204: {
      description: "Profile deleted",
      headers: { "X-Request-ID": commonHeaders["X-Request-ID"] },
    },
    400: jsonApiError("Invalid query parameter"),
    404: jsonApiError("Profile does not exist"),
    ...jsonApiCommon,
    ...profileErrors,
  },
});
