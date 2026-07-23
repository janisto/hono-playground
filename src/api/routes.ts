import { createRoute, z } from "@hono/zod-openapi";

import { ProblemResponseSchema, ValidationProblemResponseSchema } from "../models/error.js";
import { HealthResponseSchema } from "../models/health.js";
import { GreetingRequestSchema, GreetingSchema } from "../models/hello.js";
import { ItemCategorySchema, ItemListSchema } from "../models/items.js";
import { ProfileCreateSchema, ProfileSchema, ProfileUpdateSchema } from "../models/profile.js";

const describedByHeaders = {
  Link: { schema: { type: "string" as const }, description: "RFC 8288 schema link" },
  "X-Request-ID": { schema: { type: "string" as const } },
  Vary: { schema: { type: "string" as const } },
};

const problem = (description: string) => ({
  description,
  headers: describedByHeaders,
  content: { "application/problem+json": { schema: ProblemResponseSchema } },
});

const methodNotAllowedProblem = {
  ...problem("Method not allowed"),
  headers: {
    ...describedByHeaders,
    Allow: { schema: { type: "string" as const }, description: "Complete allowed-method list" },
  },
};

const rateLimitProblem = {
  ...problem("Application rate limit exceeded"),
  headers: {
    ...describedByHeaders,
    "Retry-After": { schema: { type: "string" as const }, description: "Retry delay in seconds" },
  },
};

const validationProblem = {
  description: "Request validation failed",
  headers: describedByHeaders,
  content: { "application/problem+json": { schema: ValidationProblemResponseSchema } },
};

const common = {
  405: methodNotAllowedProblem,
  406: problem("No acceptable success representation"),
  429: rateLimitProblem,
  500: problem("Internal server error"),
};

const bodyFailures = {
  413: problem("Request body too large"),
  415: problem("Unsupported request representation"),
  422: validationProblem,
};

const lastValue = (value: unknown): unknown => (Array.isArray(value) ? value.at(-1) : value);

const referenceIntegerQuery = (value: unknown): unknown => {
  const scalar = lastValue(value);
  if (typeof scalar !== "string") return scalar;
  const normalized = scalar.trim();
  if (!/^[+-]?[0-9]+(?:\.0+)?$/u.test(normalized)) return scalar;
  return Number(normalized);
};

export const ItemsQuerySchema = z.object({
  limit: z.preprocess(
    referenceIntegerQuery,
    z
      .number()
      .int({ message: "Limit must be an integer" })
      .min(1, { message: "Limit must be at least 1" })
      .max(100, { message: "Limit must be at most 100" })
      .default(20),
  ),
  category: z.preprocess(lastValue, ItemCategorySchema.optional()),
  cursor: z.preprocess(
    lastValue,
    z.string().openapi({ maxLength: 2048, description: "Opaque item cursor" }).optional(),
  ),
});

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  operationId: "health_get",
  tags: ["public"],
  responses: {
    200: {
      description: "Worker process is healthy",
      headers: describedByHeaders,
      content: { "application/json": { schema: HealthResponseSchema } },
    },
    ...common,
  },
});

export const helloGetRoute = createRoute({
  method: "get",
  path: "/v1/hello",
  operationId: "hello_get",
  tags: ["public"],
  responses: {
    200: {
      description: "Default greeting",
      headers: describedByHeaders,
      content: { "application/json": { schema: GreetingSchema } },
    },
    ...common,
  },
});

export const helloPostRoute = createRoute({
  method: "post",
  path: "/v1/hello",
  operationId: "hello_create",
  tags: ["public"],
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: GreetingRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "Requested greeting",
      headers: describedByHeaders,
      content: { "application/json": { schema: GreetingSchema } },
    },
    ...common,
    ...bodyFailures,
  },
});

export const itemsRoute = createRoute({
  method: "get",
  path: "/v1/items",
  operationId: "items_list",
  tags: ["public"],
  request: { query: ItemsQuerySchema },
  responses: {
    200: {
      description: "Cursor-paginated items",
      headers: { ...describedByHeaders, Link: describedByHeaders.Link },
      content: { "application/json": { schema: ItemListSchema } },
    },
    400: problem("Invalid cursor"),
    422: validationProblem,
    ...common,
  },
});

const profileErrors = {
  401: {
    ...problem("Access assertion is missing or invalid"),
    headers: {
      ...describedByHeaders,
      "WWW-Authenticate": { schema: { type: "string" as const } },
    },
  },
  429: rateLimitProblem,
  500: problem("Internal server error"),
  503: {
    ...problem("Profile dependency temporarily unavailable"),
    headers: { ...describedByHeaders, "Retry-After": { schema: { type: "string" as const } } },
  },
};

export const profileGetRoute = createRoute({
  method: "get",
  path: "/v1/profile",
  operationId: "profile_get",
  tags: ["profile"],
  responses: {
    200: {
      description: "Current identity profile",
      headers: describedByHeaders,
      content: { "application/json": { schema: ProfileSchema } },
    },
    404: problem("Profile does not exist"),
    405: common[405],
    406: common[406],
    ...profileErrors,
  },
});

export const profilePostRoute = createRoute({
  method: "post",
  path: "/v1/profile",
  operationId: "profile_create",
  tags: ["profile"],
  request: {
    body: { required: true, content: { "application/json": { schema: ProfileCreateSchema } } },
  },
  responses: {
    201: {
      description: "Profile created",
      headers: {
        ...describedByHeaders,
        Location: { schema: { type: "string" as const } },
      },
      content: { "application/json": { schema: ProfileSchema } },
    },
    403: problem("Unsafe cross-origin request rejected"),
    405: common[405],
    406: common[406],
    409: problem("Profile already exists"),
    ...bodyFailures,
    ...profileErrors,
  },
});

export const profilePatchRoute = createRoute({
  method: "patch",
  path: "/v1/profile",
  operationId: "profile_update",
  tags: ["profile"],
  request: {
    body: { required: true, content: { "application/json": { schema: ProfileUpdateSchema } } },
  },
  responses: {
    200: {
      description: "Profile updated",
      headers: describedByHeaders,
      content: { "application/json": { schema: ProfileSchema } },
    },
    403: problem("Unsafe cross-origin request rejected"),
    404: problem("Profile does not exist"),
    405: common[405],
    406: common[406],
    ...bodyFailures,
    ...profileErrors,
  },
});

export const profileDeleteRoute = createRoute({
  method: "delete",
  path: "/v1/profile",
  operationId: "profile_delete",
  tags: ["profile"],
  responses: {
    204: {
      description: "Profile deleted",
      headers: { "X-Request-ID": describedByHeaders["X-Request-ID"] },
    },
    403: problem("Unsafe cross-origin request rejected"),
    404: problem("Profile does not exist"),
    405: common[405],
    ...profileErrors,
  },
});
