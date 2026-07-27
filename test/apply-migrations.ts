import { applyD1Migrations, env } from "cloudflare:test";

import { MIGRATIONS_TABLE } from "../infra/config.ts";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS, MIGRATIONS_TABLE);
