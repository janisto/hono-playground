import { z } from "@hono/zod-openapi";

export const JSON_API_MEDIA_TYPE = "application/vnd.api+json";
export const JSON_API_VERSION = "1.1";

export const JsonApiObjectSchema = z.strictObject({ version: z.literal(JSON_API_VERSION) }).openapi("JsonApiObject");

export const JSON_API_OBJECT = Object.freeze({ version: JSON_API_VERSION });

export const JsonApiLinkSchema = z.string().min(1).openapi({
  description: "URI reference",
  format: "uri-reference",
});
