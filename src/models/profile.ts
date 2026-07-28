import { z } from "@hono/zod-openapi";
import { JsonApiLinkSchema, JsonApiObjectSchema } from "./json-api.ts";

const boundedName = () =>
  z
    .string()
    .refine((value) => value === value.trim(), {
      error: "Name must not have surrounding whitespace",
    })
    .refine((value) => !/[\p{Cc}]/u.test(value), {
      error: "Name must not contain control characters",
    })
    .refine((value) => Array.from(value).length >= 1, {
      error: "String should have at least 1 character",
    })
    .refine((value) => Array.from(value).length <= 100, {
      error: "String should have at most 100 characters",
    })
    .openapi({ minLength: 1, maxLength: 100 });

export const EmailSchema = z
  .string()
  .trim()
  .pipe(
    z
      .email({ error: "Invalid email address" })
      .max(254, { error: "Email should have at most 254 characters" })
      .toLowerCase(),
  );

export const PhoneNumberSchema = z
  .string()
  .trim()
  .pipe(z.e164({ error: "Invalid E.164 phone number" }));

const NormalizedEmailSchema = z
  .email({ error: "Invalid email address" })
  .max(254, { error: "Email should have at most 254 characters" })
  .refine((value) => value === value.trim() && value === value.toLowerCase(), {
    error: "Email must be normalized",
  });

const NormalizedPhoneNumberSchema = z.e164({ error: "Invalid E.164 phone number" });

const mutableProfileFields = {
  firstName: boundedName(),
  lastName: boundedName(),
  email: EmailSchema,
  phoneNumber: PhoneNumberSchema,
  marketingOptIn: z.boolean(),
};

export const ProfileCreateSchema = z
  .strictObject({
    ...mutableProfileFields,
    marketingOptIn: mutableProfileFields.marketingOptIn.default(false),
    termsAccepted: z.literal(true, { error: "Terms must be accepted" }),
  })
  .openapi("ProfileCreateAttributes");

export const ProfileUpdateSchema = z.strictObject(mutableProfileFields).partial().openapi("ProfileUpdateAttributes");

const profileFields = {
  id: z.string().min(1).max(128),
  firstName: mutableProfileFields.firstName,
  lastName: mutableProfileFields.lastName,
  email: NormalizedEmailSchema,
  phoneNumber: NormalizedPhoneNumberSchema,
  marketingOptIn: mutableProfileFields.marketingOptIn,
  termsAccepted: z.literal(true),
};

export const ProfileSchema = z.strictObject({
  ...profileFields,
  createdAt: z.date(),
  updatedAt: z.date(),
});

const ProfileTimestampSchema = z.iso.datetime({ offset: false, precision: 3 });

export const ProfileAttributesSchema = z
  .strictObject({
    firstName: profileFields.firstName,
    lastName: profileFields.lastName,
    email: profileFields.email,
    phoneNumber: profileFields.phoneNumber,
    marketingOptIn: profileFields.marketingOptIn,
    termsAccepted: profileFields.termsAccepted,
    createdAt: ProfileTimestampSchema,
    updatedAt: ProfileTimestampSchema,
  })
  .openapi("ProfileAttributes");

export const ProfileResourceSchema = z
  .strictObject({
    type: z.literal("profiles"),
    id: ProfileSchema.shape.id,
    attributes: ProfileAttributesSchema,
    links: z.strictObject({ self: JsonApiLinkSchema }),
  })
  .openapi("ProfileResource");

export const ProfileDocumentSchema = z
  .strictObject({
    jsonapi: JsonApiObjectSchema,
    links: z.strictObject({
      self: JsonApiLinkSchema,
    }),
    data: ProfileResourceSchema,
  })
  .openapi("ProfileDocument");

export const ProfileCreateDocumentSchema = z
  .strictObject({
    jsonapi: z.record(z.string(), z.unknown()).optional(),
    links: z.record(z.string(), z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    data: z.strictObject({
      type: z.literal("profiles"),
      attributes: ProfileCreateSchema,
      links: z.record(z.string(), z.unknown()).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi("ProfileCreateDocument");

export const ProfileUpdateDocumentSchema = z
  .strictObject({
    jsonapi: z.record(z.string(), z.unknown()).optional(),
    links: z.record(z.string(), z.unknown()).optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
    data: z.strictObject({
      type: z.literal("profiles"),
      id: z.string(),
      attributes: ProfileUpdateSchema.optional(),
      links: z.record(z.string(), z.unknown()).optional(),
      meta: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .openapi("ProfileUpdateDocument");

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileCreate = z.infer<typeof ProfileCreateSchema>;
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
export type ProfileResource = z.infer<typeof ProfileResourceSchema>;
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;
