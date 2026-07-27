import type { WorkerEnv } from "../alchemy.run.ts";
import { app } from "./app.ts";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<WorkerEnv>;
