import { z } from "@hono/zod-openapi";
import { BoundedNameSchema } from "./portable.ts";

export const HelloCreateSchema = z.strictObject({ name: BoundedNameSchema }).openapi("HelloCreate");

export const GreetingSchema = z
  .strictObject({ message: z.string() })
  .openapi("Greeting", { example: { message: "Hello, World!" } });

export type HelloCreate = z.infer<typeof HelloCreateSchema>;
export type Greeting = z.infer<typeof GreetingSchema>;
