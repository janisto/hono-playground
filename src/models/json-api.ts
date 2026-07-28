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
const LANGUAGE_TAG = `(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}|[A-Za-z]{4}|[A-Za-z]{5,8})`;
const LANGUAGE_TAG_SCRIPT = `(?:-[A-Za-z]{4})?`;
const LANGUAGE_TAG_REGION = `(?:-(?:[A-Za-z]{2}|[0-9]{3}))?`;
const LANGUAGE_TAG_VARIANTS = `(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*`;
const LANGUAGE_TAG_EXTENSIONS = `(?:-[0-9A-WY-Za-wy-z](?:-[A-Za-z0-9]{2,8})+)*`;
const LANGUAGE_TAG_PRIVATE_USE = `(?:-x(?:-[A-Za-z0-9]{1,8})+)?`;
const PRIVATE_USE_LANGUAGE_TAG = `x(?:-[A-Za-z0-9]{1,8})+`;
const GRANDFATHERED_LANGUAGE_TAG = `(?:en-GB-oed|i-(?:ami|bnn|default|enochian|hak|klingon|lux|mingo|navajo|pwn|tao|tay|tsu)|sgn-(?:BE-FR|BE-NL|CH-DE)|art-lojban|cel-gaulish|no-(?:bok|nyn)|zh-(?:guoyu|hakka|min(?:-nan)?|xiang))`;
const LANGUAGE_TAG_SYNTAX = new RegExp(
  `^(?:${LANGUAGE_TAG}${LANGUAGE_TAG_SCRIPT}${LANGUAGE_TAG_REGION}${LANGUAGE_TAG_VARIANTS}${LANGUAGE_TAG_EXTENSIONS}${LANGUAGE_TAG_PRIVATE_USE}|${PRIVATE_USE_LANGUAGE_TAG}|${GRANDFATHERED_LANGUAGE_TAG})$`,
  "iu",
);

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
  .openapi({ description: "Well-formed RFC 5646 language tag", pattern: LANGUAGE_TAG_SYNTAX.source });

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
