import { z } from "@hono/zod-openapi";
import { JsonApiObjectSchema } from "./json-api.js";

export const MAX_VALIDATION_ERRORS = 32;

const problemResponseFields = {
  type: z.literal("about:blank"),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
};

export const ProblemResponseSchema = z
  .object(problemResponseFields)
  .strict()
  .openapi("ProblemResponse");

export const JsonApiErrorSourceSchema = z
  .union([
    z.object({ pointer: z.string().startsWith("/") }).strict(),
    z.object({ parameter: z.string().min(1) }).strict(),
    z.object({ header: z.string().min(1) }).strict(),
  ])
  .openapi("JsonApiErrorSource");

export const JsonApiErrorSchema = z
  .object({
    status: z.string().regex(/^[45][0-9]{2}$/),
    code: z.string().regex(/^[a-z][a-z0-9_]*$/),
    title: z.string(),
    detail: z.string(),
    source: JsonApiErrorSourceSchema.optional(),
  })
  .strict()
  .openapi("JsonApiError");

export const JsonApiErrorDocumentSchema = z
  .object({
    jsonapi: JsonApiObjectSchema,
    errors: z.array(JsonApiErrorSchema).min(1).max(MAX_VALIDATION_ERRORS),
  })
  .strict()
  .openapi("JsonApiErrorDocument");

export type ProblemResponse = z.infer<typeof ProblemResponseSchema>;
export type JsonApiErrorSource = z.infer<typeof JsonApiErrorSourceSchema>;
export type JsonApiError = z.infer<typeof JsonApiErrorSchema>;
export type JsonApiErrorDocument = z.infer<typeof JsonApiErrorDocumentSchema>;

export type ValidationErrorDetail = Readonly<{
  detail: string;
  source?: JsonApiErrorSource;
}>;
