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

const JsonApiProfileUriSchema = z
  .string()
  .min(1)
  .refine(isAbsoluteUri, { error: "Invalid profile URI" })
  .openapi({ format: "uri" });

const REGISTERED_LINK_RELATION = /^[a-z][a-z0-9.-]*$/u;
const JSON_API_MEMBER_NAME = /^[a-z][A-Za-z0-9]*$/u;
const HTTP_TOKEN_PATTERN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const HTTP_QUOTED_STRING_PATTERN = String.raw`"(?:[\t !#-\[\]-~\u0080-\u00ff]|\\[\t !-~\u0080-\u00ff])*"`;
const MEDIA_TYPE_PATTERN = new RegExp(
  String.raw`^${HTTP_TOKEN_PATTERN}/${HTTP_TOKEN_PATTERN}(?:[\t ]*;[\t ]*${HTTP_TOKEN_PATTERN}=(?:${HTTP_TOKEN_PATTERN}|${HTTP_QUOTED_STRING_PATTERN}))*$`,
  "u",
);
const LANGUAGE_TAG_SYNTAX = /^[A-Za-z0-9]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u;

const JsonApiMemberNameSchema = z
  .string()
  .regex(JSON_API_MEMBER_NAME, { error: "Invalid JSON:API member name" })
  .openapi({ description: "ASCII lower camel case JSON:API member name", pattern: JSON_API_MEMBER_NAME.source });

const jsonApiMetaOpenApi = {
  description: "Metadata keyed by ASCII lower camel case member names",
  propertyNames: {
    type: "string",
    pattern: JSON_API_MEMBER_NAME.source,
  },
};

export const JsonApiMetaSchema = z
  .record(JsonApiMemberNameSchema, z.unknown())
  .openapi("JsonApiMeta", jsonApiMetaOpenApi);

const JsonApiLinkRelationSchema = z
  .string()
  .min(1)
  .refine((value) => REGISTERED_LINK_RELATION.test(value) || isAbsoluteUri(value), {
    error: "Invalid link relation type",
  })
  .openapi({
    description: "Registered or extension link relation type",
    anyOf: [
      { type: "string", pattern: REGISTERED_LINK_RELATION.source },
      { type: "string", format: "uri" },
    ],
  });

const JsonApiLinkMediaTypeSchema = z
  .string()
  .regex(MEDIA_TYPE_PATTERN, { error: "Invalid media type" })
  .openapi({ description: "Media type", pattern: MEDIA_TYPE_PATTERN.source });

const JsonApiLanguageTagSchema = z
  .string()
  .regex(LANGUAGE_TAG_SYNTAX, { error: "Invalid language tag syntax" })
  .openapi({ description: "RFC 5646 language tag syntax", pattern: LANGUAGE_TAG_SYNTAX.source });

const JsonApiRequestLinkReference: z.ZodType = z.lazy(() => JsonApiRequestLinkSchema);

const JsonApiRequestLinkObjectSchema = z
  .strictObject({
    href: JsonApiLinkSchema,
    rel: JsonApiLinkRelationSchema.optional(),
    describedby: JsonApiRequestLinkReference.optional(),
    title: z.string().optional(),
    type: JsonApiLinkMediaTypeSchema.optional(),
    hreflang: z.union([JsonApiLanguageTagSchema, z.array(JsonApiLanguageTagSchema).min(1)]).optional(),
    meta: JsonApiMetaSchema.optional(),
  })
  .openapi("JsonApiRequestLinkObject");

export const JsonApiRequestLinkSchema = z
  .union([JsonApiLinkSchema, JsonApiRequestLinkObjectSchema, z.null()])
  .openapi("JsonApiRequestLink");

const jsonApiRequestLinksOpenApi = {
  description: "JSON:API links keyed by ASCII lower camel case member names",
  propertyNames: {
    type: "string",
    pattern: JSON_API_MEMBER_NAME.source,
  },
};

export const JsonApiRequestLinksSchema = z
  .record(JsonApiMemberNameSchema, JsonApiRequestLinkSchema)
  .openapi("JsonApiRequestLinks", jsonApiRequestLinksOpenApi);

export const JsonApiRequestObjectSchema = z
  .strictObject({
    version: z.string().min(1).optional(),
    profile: z.array(JsonApiProfileUriSchema).optional(),
    meta: JsonApiMetaSchema.optional(),
  })
  .openapi("JsonApiRequestObject");
