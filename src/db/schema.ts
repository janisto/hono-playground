import { sql } from "drizzle-orm";
import { check, integer, primaryKey, snakeCase, text } from "drizzle-orm/sqlite-core";

export const profiles = snakeCase.table(
  "profiles",
  {
    id: text().notNull(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    email: text().notNull(),
    phoneNumber: text().notNull(),
    marketingOptIn: integer({ mode: "boolean" }).notNull().default(false),
    termsAccepted: integer({ mode: "boolean" }).notNull(),
    createdAt: integer({ mode: "timestamp_ms" }).notNull(),
    updatedAt: integer({ mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    primaryKey({ name: "profiles_id_pk", columns: [table.id] }),
    check("profiles_id_length", sql`length(${table.id}) BETWEEN 1 AND 128`),
    check("profiles_first_name_length", sql`length(${table.firstName}) BETWEEN 1 AND 100`),
    check("profiles_last_name_length", sql`length(${table.lastName}) BETWEEN 1 AND 100`),
    check("profiles_email_length", sql`length(${table.email}) BETWEEN 3 AND 254`),
    check(
      "profiles_phone_number_format",
      sql`
        length(${table.phoneNumber}) BETWEEN 8 AND 16
        AND substr(${table.phoneNumber}, 1, 1) = '+'
        AND substr(${table.phoneNumber}, 2, 1) BETWEEN '1' AND '9'
        AND substr(${table.phoneNumber}, 2) NOT GLOB '*[^0-9]*'
      `,
    ),
    check("profiles_marketing_opt_in_boolean", sql`${table.marketingOptIn} IN (0, 1)`),
    check("profiles_terms_accepted", sql`${table.termsAccepted} = 1`),
    check("profiles_created_at_nonnegative", sql`${table.createdAt} >= 0`),
    check("profiles_updated_at_order", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export type ProfileRow = typeof profiles.$inferSelect;
export type NewProfileRow = typeof profiles.$inferInsert;
