import { z } from "@hono/zod-openapi";
import { JsonApiLinkSchema, JsonApiObjectSchema } from "./json-api.js";

const boundedName = () =>
  z
    .string()
    .refine((value) => value === value.trim(), {
      message: "Name must not have surrounding whitespace",
    })
    .refine((value) => !/[\p{Cc}]/u.test(value), {
      message: "Name must not contain control characters",
    })
    .refine((value) => Array.from(value).length >= 1, {
      message: "String should have at least 1 character",
    })
    .refine((value) => Array.from(value).length <= 100, {
      message: "String should have at most 100 characters",
    })
    .openapi({ minLength: 1, maxLength: 100 });

export const EmailSchema = z
  .string()
  .trim()
  .max(254, { message: "Email should have at most 254 characters" })
  .email({ message: "Invalid email address" })
  .toLowerCase();

export const PhoneNumberSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9][0-9]{6,14}$/, { message: "Invalid E.164 phone number" });

const NormalizedEmailSchema = z
  .string()
  .max(254, { message: "Email should have at most 254 characters" })
  .email({ message: "Invalid email address" })
  .refine((value) => value === value.trim() && value === value.toLowerCase(), {
    message: "Email must be normalized",
  });

const NormalizedPhoneNumberSchema = z.string().regex(/^\+[1-9][0-9]{6,14}$/, {
  message: "Invalid E.164 phone number",
});

const mutableProfileFields = {
  firstName: boundedName(),
  lastName: boundedName(),
  email: EmailSchema,
  phoneNumber: PhoneNumberSchema,
  marketingOptIn: z.boolean(),
};

export const ProfileCreateSchema = z
  .object({
    ...mutableProfileFields,
    marketingOptIn: mutableProfileFields.marketingOptIn.default(false),
    termsAccepted: z.literal(true, { error: "Terms must be accepted" }),
  })
  .strict()
  .openapi("ProfileCreateAttributes");

export const ProfileUpdateSchema = z
  .object(mutableProfileFields)
  .partial()
  .strict()
  .openapi("ProfileUpdateAttributes");

export const ProfileSchema = z
  .object({
    id: z.string().min(1).max(128),
    firstName: mutableProfileFields.firstName,
    lastName: mutableProfileFields.lastName,
    email: NormalizedEmailSchema,
    phoneNumber: NormalizedPhoneNumberSchema,
    marketingOptIn: mutableProfileFields.marketingOptIn,
    termsAccepted: z.literal(true),
    createdAt: z.iso.datetime({ offset: false, precision: 3 }),
    updatedAt: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict();

export const ProfileAttributesSchema = ProfileSchema.omit({ id: true }).openapi(
  "ProfileAttributes",
);

export const ProfileResourceSchema = z
  .object({
    type: z.literal("profiles"),
    id: ProfileSchema.shape.id,
    attributes: ProfileAttributesSchema,
    links: z.object({ self: JsonApiLinkSchema }).strict(),
  })
  .strict()
  .openapi("ProfileResource");

export const ProfileDocumentSchema = z
  .object({
    jsonapi: JsonApiObjectSchema,
    links: z
      .object({
        self: JsonApiLinkSchema,
      })
      .strict(),
    data: ProfileResourceSchema,
  })
  .strict()
  .openapi("ProfileDocument");

export const ProfileCreateDocumentSchema = z
  .object({
    data: z
      .object({
        type: z.literal("profiles"),
        attributes: ProfileCreateSchema,
      })
      .strict(),
  })
  .strict()
  .openapi("ProfileCreateDocument");

export const ProfileUpdateDocumentSchema = z
  .object({
    data: z
      .object({
        type: z.literal("profiles"),
        id: ProfileSchema.shape.id,
        attributes: ProfileUpdateSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .openapi("ProfileUpdateDocument");

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileCreate = z.infer<typeof ProfileCreateSchema>;
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
export type ProfileResource = z.infer<typeof ProfileResourceSchema>;
export type ProfileDocument = z.infer<typeof ProfileDocumentSchema>;
