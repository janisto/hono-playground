import { z } from "@hono/zod-openapi";

const boundedName = () =>
  z
    .string()
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
  first_name: boundedName(),
  last_name: boundedName(),
  email: EmailSchema,
  phone_number: PhoneNumberSchema,
  marketing: z.boolean(),
};

export const ProfileCreateSchema = z
  .object({
    ...mutableProfileFields,
    marketing: mutableProfileFields.marketing.default(false),
    terms: z.literal(true, { error: "Terms must be accepted" }),
  })
  .strict()
  .openapi("ProfileCreate");

export const ProfileUpdateSchema = z
  .object(mutableProfileFields)
  .partial()
  .strict()
  .openapi("ProfileUpdate");

export const ProfileSchema = z
  .object({
    id: z.string().min(1).max(128),
    first_name: mutableProfileFields.first_name,
    last_name: mutableProfileFields.last_name,
    email: NormalizedEmailSchema,
    phone_number: NormalizedPhoneNumberSchema,
    marketing: mutableProfileFields.marketing,
    terms: z.literal(true),
    created_at: z.iso.datetime({ offset: false, precision: 3 }),
    updated_at: z.iso.datetime({ offset: false, precision: 3 }),
  })
  .strict()
  .openapi("Profile");

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileCreate = z.infer<typeof ProfileCreateSchema>;
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
