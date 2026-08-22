import { z } from "@hono/zod-openapi";
import {
  JsonApiIncludedSchema,
  JsonApiLinkSchema,
  JsonApiMetaSchema,
  JsonApiObjectSchema,
  JsonApiRelationshipsSchema,
  JsonApiRequestLinksSchema,
  JsonApiRequestObjectSchema,
} from "./json-api.ts";
import {
  BoundedNameSchema,
  OpaqueIdSchema,
  PhoneNumberSchema,
  stripAsciiWhitespace,
  TimestampSchema,
} from "./portable.ts";

const CONTACT_EMAIL_PATTERN =
  /^(?!\.)(?![^@]*\.\.)(?![^@]*\.@)[A-Za-z0-9!#$%&'*+/=?^_{|}~.-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

const CONTACT_EMAIL_INPUT_PATTERN =
  "^[\\t-\\r ]*(?=[^\\t-\\r ]{1,254}[\\t-\\r ]*$)" +
  "(?!\\.)(?![^@]*\\.\\.)(?![^@]*\\.@)" +
  "[A-Za-z0-9!#$%&'*+/=?^_{|}~.-]{1,64}@" +
  "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?" +
  "(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+[\\t-\\r ]*$";

const PHONE_NUMBER_INPUT_PATTERN = "^[\\t-\\r ]*\\+[1-9][0-9]{6,14}[\\t-\\r ]*$";

export const normalizeContactEmail = (value: string): string => {
  const stripped = stripAsciiWhitespace(value);
  const at = stripped.indexOf("@");
  return at < 0 ? stripped : `${stripped.slice(0, at)}@${stripped.slice(at + 1).toLowerCase()}`;
};

export const ContactEmailSchema = z
  .string()
  .min(3)
  .max(254)
  .regex(CONTACT_EMAIL_PATTERN, { error: "Invalid contact email" })
  .openapi({ minLength: 3, maxLength: 254, pattern: CONTACT_EMAIL_PATTERN.source });

export const ContactEmailInputSchema = z.string().transform(normalizeContactEmail).pipe(ContactEmailSchema).openapi({
  type: "string",
  pattern: CONTACT_EMAIL_INPUT_PATTERN,
  description: "ASCII email; surrounding ASCII whitespace is stripped and the domain is lowercased.",
});

export const PhoneNumberInputSchema = z.string().transform(stripAsciiWhitespace).pipe(PhoneNumberSchema).openapi({
  type: "string",
  pattern: PHONE_NUMBER_INPUT_PATTERN,
  description: "E.164 phone number after stripping surrounding ASCII whitespace.",
});

const mutableProfileFields = {
  firstName: BoundedNameSchema,
  lastName: BoundedNameSchema,
  contactEmail: ContactEmailInputSchema,
  phoneNumber: PhoneNumberInputSchema,
  marketingOptIn: z.boolean(),
};

export const ProfileCreateSchema = z
  .strictObject({
    ...mutableProfileFields,
    marketingOptIn: mutableProfileFields.marketingOptIn.default(false),
    termsAccepted: z.literal(true, { error: "Terms must be accepted" }),
  })
  .openapi("ProfileCreateAttributes");

export const ProfileUpdateSchema = z
  .strictObject(mutableProfileFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, { error: "At least one profile attribute is required" })
  .openapi("ProfileUpdateAttributes", { minProperties: 1 });

export const ProfileSchema = z
  .strictObject({
    id: OpaqueIdSchema,
    firstName: BoundedNameSchema,
    lastName: BoundedNameSchema,
    contactEmail: ContactEmailSchema,
    phoneNumber: PhoneNumberSchema,
    marketingOptIn: z.boolean(),
    termsAccepted: z.literal(true),
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .refine((value) => value.updatedAt.getTime() >= value.createdAt.getTime(), {
    error: "updatedAt must not precede createdAt",
  });

export const ProfileAttributesSchema = z
  .strictObject({
    firstName: BoundedNameSchema,
    lastName: BoundedNameSchema,
    contactEmail: ContactEmailSchema,
    phoneNumber: PhoneNumberSchema,
    marketingOptIn: z.boolean(),
    termsAccepted: z.literal(true),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("ProfileAttributes");

export const ProfileResourceSchema = z
  .strictObject({
    type: z.literal("profiles"),
    id: OpaqueIdSchema,
    attributes: ProfileAttributesSchema,
    links: z.strictObject({ self: JsonApiLinkSchema }),
  })
  .openapi("ProfileResource");

export const ProfileDocumentSchema = z
  .strictObject({
    jsonapi: JsonApiObjectSchema,
    links: z.strictObject({ self: JsonApiLinkSchema }),
    data: ProfileResourceSchema,
  })
  .openapi("ProfileDocument");

export const ProfileCreateDocumentSchema = z
  .looseObject({
    jsonapi: JsonApiRequestObjectSchema.optional(),
    links: JsonApiRequestLinksSchema.optional(),
    meta: JsonApiMetaSchema.optional(),
    included: JsonApiIncludedSchema.optional(),
    data: z.looseObject({
      type: z.literal("profiles"),
      id: z.string().optional(),
      lid: z.string().optional(),
      attributes: ProfileCreateSchema,
      relationships: JsonApiRelationshipsSchema.optional(),
      links: JsonApiRequestLinksSchema.optional(),
      meta: JsonApiMetaSchema.optional(),
    }),
  })
  .openapi("ProfileCreateDocument", {
    description: "Unknown JSON:API protocol members are ignored; profile attributes are closed.",
  });

export const ProfileUpdateDocumentSchema = z
  .looseObject({
    jsonapi: JsonApiRequestObjectSchema.optional(),
    links: JsonApiRequestLinksSchema.optional(),
    meta: JsonApiMetaSchema.optional(),
    included: JsonApiIncludedSchema.optional(),
    data: z.looseObject({
      type: z.literal("profiles"),
      id: z.string(),
      lid: z.string().optional(),
      attributes: ProfileUpdateSchema,
      relationships: JsonApiRelationshipsSchema.optional(),
      links: JsonApiRequestLinksSchema.optional(),
      meta: JsonApiMetaSchema.optional(),
    }),
  })
  .openapi("ProfileUpdateDocument", {
    description: "Unknown JSON:API protocol members are ignored; profile attributes are closed and non-empty.",
  });

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileCreate = z.infer<typeof ProfileCreateSchema>;
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
export type ProfileResource = z.infer<typeof ProfileResourceSchema>;
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;
