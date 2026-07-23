import { z } from "@hono/zod-openapi";

export const HealthResponseSchema = z
  .object({ status: z.literal("healthy") })
  .strict()
  .openapi("HealthResponse");

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
