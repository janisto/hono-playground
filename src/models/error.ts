import { z } from "@hono/zod-openapi";

const problemResponseFields = {
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
};

export const ProblemResponseSchema = z
  .object(problemResponseFields)
  .strict()
  .openapi("ProblemResponse");

export const ValidationErrorDetailSchema = z
  .object({
    location: z.string(),
    message: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  })
  .strict()
  .openapi("ValidationErrorDetail");

export const ValidationProblemResponseSchema = z
  .object({
    ...problemResponseFields,
    errors: z.array(ValidationErrorDetailSchema),
  })
  .strict()
  .openapi("ValidationProblemResponse");

export type ProblemResponse = z.infer<typeof ProblemResponseSchema>;
export type ValidationErrorDetail = z.infer<typeof ValidationErrorDetailSchema>;
export type ValidationProblemResponse = z.infer<typeof ValidationProblemResponseSchema>;
