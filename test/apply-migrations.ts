import { applyD1Migrations, env } from "cloudflare:test";

import { MIGRATIONS_TABLE } from "../infra/config.js";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS, MIGRATIONS_TABLE);
