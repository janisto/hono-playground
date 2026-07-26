import type { WorkerEnv } from "../alchemy.run.js";
import { app } from "./app.js";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<WorkerEnv>;
