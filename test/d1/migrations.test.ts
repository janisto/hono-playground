import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("Drizzle migration", () => {
  it("creates the STRICT snake_case profile schema with its domain constraints", async () => {
    const table = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'profiles'",
    ).first<{ sql: string }>();
    expect(table?.sql).toMatch(/CREATE TABLE `profiles`[\s\S]*\)\s+STRICT$/u);
    expect(table?.sql).toContain("profiles_phone_number_format");
    expect(table?.sql).toContain("profiles_terms_accepted");

    const columns = await env.DB.prepare("PRAGMA table_info(profiles)").all<{
      name: string;
      type: string;
    }>();
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
});
