import { z } from "@hono/zod-openapi";
import { isAbsoluteUri, isUriReference } from "../core/uri.ts";

export const JSON_API_MEDIA_TYPE = "application/vnd.api+json";
export const JSON_API_VERSION = "1.1";

export const JsonApiObjectSchema = z.strictObject({ version: z.literal(JSON_API_VERSION) }).openapi("JsonApiObject");

export const JSON_API_OBJECT = Object.freeze({ version: JSON_API_VERSION });

export const JsonApiLinkSchema = z.string().min(1).refine(isUriReference, { error: "Invalid URI reference" }).openapi({
  description: "URI reference",
  format: "uri-reference",
});

export const JsonApiMetaSchema = z.record(z.string(), z.unknown()).openapi("JsonApiMeta");

const JsonApiProfileUriSchema = z
  .string()
  .min(1)
  .refine(isAbsoluteUri, { error: "Invalid profile URI" })
  .openapi({ format: "uri" });

const JsonApiRequestLinkObjectSchema = z
  .strictObject({
    href: JsonApiLinkSchema,
    rel: z.string().min(1).optional(),
    describedby: JsonApiLinkSchema.optional(),
    title: z.string().optional(),
    type: z.string().min(1).optional(),
    hreflang: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
    meta: JsonApiMetaSchema.optional(),
  })
  .openapi("JsonApiRequestLinkObject");

export const JsonApiRequestLinkSchema = z
  .union([JsonApiLinkSchema, JsonApiRequestLinkObjectSchema, z.null()])
  .openapi("JsonApiRequestLink");

export const JsonApiRequestLinksSchema = z.record(z.string(), JsonApiRequestLinkSchema).openapi("JsonApiRequestLinks");

export const JsonApiRequestObjectSchema = z
  .strictObject({
    version: z.string().min(1).optional(),
    profile: z.array(JsonApiProfileUriSchema).optional(),
    meta: JsonApiMetaSchema.optional(),
  })
  .openapi("JsonApiRequestObject");
