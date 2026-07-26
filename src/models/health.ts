import { z } from "@hono/zod-openapi";

export const HealthResponseSchema = z
  .strictObject({ status: z.literal("healthy") })
  .openapi("HealthResponse");

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
