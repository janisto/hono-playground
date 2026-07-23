import { z } from "@hono/zod-openapi";

export const LanguageSchema = z.enum(["en", "fi", "es", "fr", "de"]);

const NameSchema = z
  .string()
  .refine((value) => Array.from(value).length >= 1, {
    message: "String should have at least 1 character",
  })
  .refine((value) => Array.from(value).length <= 100, {
    message: "String should have at most 100 characters",
  })
  .openapi({ minLength: 1, maxLength: 100 });

export const GreetingRequestSchema = z
  .object({
    name: NameSchema,
    language: LanguageSchema.default("en"),
  })
  .strict()
  .openapi("GreetingRequest");

export const GreetingSchema = z.object({ message: z.string() }).strict().openapi("Greeting");

export type GreetingRequest = z.infer<typeof GreetingRequestSchema>;
export type Language = z.infer<typeof LanguageSchema>;
