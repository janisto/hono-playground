import { z } from "@hono/zod-openapi";
import { JsonApiObjectSchema } from "./json-api.ts";

export const MAX_VALIDATION_ERRORS = 32;
export const MAX_ERROR_SOURCE_LENGTH = 256;

export const ErrorSourceSchema = z
  .union([
    z.strictObject({ pointer: z.string().min(1).max(MAX_ERROR_SOURCE_LENGTH).startsWith("/") }),
    z.strictObject({ parameter: z.string().min(1).max(MAX_ERROR_SOURCE_LENGTH) }),
    z.strictObject({ header: z.string().min(1).max(MAX_ERROR_SOURCE_LENGTH) }),
  ])
  .openapi("ErrorSource");

export const ValidationIssueSchema = z
  .strictObject({
    detail: z.string().min(1).max(200),
    source: ErrorSourceSchema.optional(),
  })
  .openapi("ValidationIssue");

const problemResponseFields = {
  type: z.literal("about:blank"),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string(),
  code: z.string().regex(/^[a-z][a-z0-9_]*$/u),
  errors: z.array(ValidationIssueSchema).min(1).max(MAX_VALIDATION_ERRORS).optional(),
};

export const ProblemResponseSchema = z.strictObject(problemResponseFields).openapi("ProblemResponse");

export const JsonApiErrorSchema = z
  .strictObject({
    status: z.string().regex(/^[45][0-9]{2}$/u),
    code: z.string().regex(/^[a-z][a-z0-9_]*$/u),
    title: z.string(),
    detail: z.string().min(1).max(200),
    source: ErrorSourceSchema.optional(),
  })
  .openapi("JsonApiError");

export const JsonApiErrorDocumentSchema = z
  .strictObject({
    jsonapi: JsonApiObjectSchema,
    errors: z.array(JsonApiErrorSchema).min(1).max(MAX_VALIDATION_ERRORS),
  })
  .openapi("JsonApiErrorDocument");

export type ProblemResponse = z.infer<typeof ProblemResponseSchema>;
export type JsonApiErrorSource = z.infer<typeof ErrorSourceSchema>;
export type JsonApiError = z.infer<typeof JsonApiErrorSchema>;
export type JsonApiErrorDocument = z.infer<typeof JsonApiErrorDocumentSchema>;
export type ValidationErrorDetail = z.infer<typeof ValidationIssueSchema>;
