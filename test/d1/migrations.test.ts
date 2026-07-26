import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { MIGRATIONS_TABLE } from "../../infra/config.ts";

describe("Drizzle migration", () => {
  it("creates the generated snake_case profile schema with its domain constraints", async () => {
    const table = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
    ).first<{ sql: string }>();
    expect(table?.sql).toMatch(/^CREATE TABLE ["`]profiles["`]/u);
    expect(table?.sql).toContain("profiles_phone_number_format");
    expect(table?.sql).toContain("profiles_terms_accepted");

    const columns = await env.DB.prepare("PRAGMA table_info(profiles)").all<{
      name: string;
      notnull: number;
      pk: number;
      type: string;
    }>();
    expect(columns.results.find(({ name }) => name === "id")).toMatchObject({
      name: "id",
      notnull: 1,
      pk: 1,
      type: "TEXT",
    });
    expect(columns.results.map(({ name, type }) => ({ name, type }))).toEqual([
      { name: "id", type: "TEXT" },
      { name: "first_name", type: "TEXT" },
      { name: "last_name", type: "TEXT" },
      { name: "email", type: "TEXT" },
      { name: "phone_number", type: "TEXT" },
      { name: "marketing_opt_in", type: "INTEGER" },
      { name: "terms_accepted", type: "INTEGER" },
      { name: "created_at", type: "INTEGER" },
      { name: "updated_at", type: "INTEGER" },
    ]);
  });

  it("records full migration paths in the Alchemy-compatible ledger", async () => {
    const columns = await env.DB.prepare(`PRAGMA table_info(${MIGRATIONS_TABLE})`).all<{
      name: string;
    }>();
    expect(columns.results.map(({ name }) => name)).toEqual(["id", "name", "applied_at"]);

    const applied = await env.DB.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`).all<{
      name: string;
    }>();
    expect(applied.results.map(({ name }) => name)).toEqual(env.TEST_MIGRATIONS.map(({ name }) => name));
  });
});
