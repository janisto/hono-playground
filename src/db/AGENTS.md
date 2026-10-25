# D1 schema and Drizzle migrations

The root `AGENTS.md` also applies. Paths below are relative to the repository root.

- SQL identifiers use lower `snake_case`: plural table names, singular column
  names, `id` primary keys, `<resource>_id` foreign keys, and timestamp columns
  such as `created_at`.
- Define SQLite tables with Drizzle v1 `snakeCase.table`. TypeScript schema keys
  stay camelCase and Drizzle performs the declared mapping. Do not hand-write
  duplicate casing conversion code or explicit SQL column aliases unless an
  external schema forces an exception and the exception is documented.
- Use `integer({ mode: "boolean" })` for D1 booleans and enforce domain
  invariants with focused database checks that Drizzle can model.
- `src/db/schema.ts` is the sole application schema source of truth. Express
  tables, columns, indexes, foreign keys, and checks through supported Drizzle
  APIs. Do not encode schema changes by writing SQL or snapshot metadata.
- Everything under `drizzle/` is Drizzle Kit-owned generated output. Never
  hand-edit or format `migration.sql`, `snapshot.json`, migration directory
  names, timestamps, snapshot IDs, `prevIds`, or any other generated metadata.
  Review generated artifacts read-only.
- Follow Drizzle's current
  [code-first generate flow](https://orm.drizzle.team/docs/drizzle-kit-generate)
  for every model change:
  1. Change `src/db/schema.ts`.
  2. Run `pnpm db:preview` and inspect the dry-run SQL.
  3. If the plan is correct, run
     `pnpm db:generate describe_schema_change`, replacing the example name with
     a specific lower-snake-case description. The package command supplies
     Drizzle's required `--name` option and fails when the name is omitted.
  4. Review the generated folder without modifying it, run `pnpm db:check`,
     and replay the committed migration chain in the D1 tests.
- If the dry run or generated result is wrong, incomplete, destructive beyond
  intent, or cannot represent a required SQLite feature, do not patch the
  generated files. Correct the Drizzle model and regenerate, or stop for an
  explicit dependency or architecture decision. This repository does not use
  `drizzle-kit generate --custom` to bypass an unsupported model.
- Drizzle v1 removed `drizzle-kit drop` and made each migration directory the
  atomic migration unit. A rejected generated directory may be discarded whole
  only after proving it has never been applied to a persistent stage; never
  salvage it by editing or renaming its contents. Do not discard committed or
  shared history autonomously: a pre-deployment baseline regeneration requires
  explicit user authority and proof that no persistent stage has applied it.
  Once a migration was or might have been applied, it is immutable. Correct the
  model and generate a new forward migration.
- Do not use `drizzle-kit push`; it applies schema differences directly and
  bypasses this repository's reviewed migration chain. Do not use
  `--ignore-conflicts`, `pull`, or `up` without an explicit task that justifies
  that operation. A conflict or format upgrade is not an ordinary model change.
- `pnpm db:check` verifies generated-history branch consistency and runs
  Drizzle's non-mutating JSON dry run. It fails when the current model would
  generate another migration. It does not prove SQL correctness, D1 behavior,
  deployment success, or that a migration was never applied.
- CI compares `drizzle/` with the pull-request base or previous `main` revision
  and rejects modifications, deletions, or renames of existing generated
  files. New forward migration directories remain allowed.
- Drizzle Kit's legacy `strict` push-confirmation setting is unrelated to
  SQLite `STRICT` tables. Do not add SQLite table options that the pinned
  Drizzle schema and snapshot model cannot represent.
- Application repositories use Drizzle queries. Raw SQL is limited to tests
  that verify D1 behavior.
- Operational data repair or erasure is not a migration. Do not encode it in a
  Drizzle migration, add an administrative HTTP route, or paste a raw identity
  into D1 Studio. Follow `docs/cloudflare-production.md`: use the D1 REST API
  with SQL placeholders and bound `params`, assert the precondition and affected
  row count, and record only the audit pseudonym rather than the raw subject.
- `drizzle_migrations` is Alchemy's Wrangler-compatible ledger for the
  Drizzle-generated SQL files. It is not Drizzle ORM's runtime migrator table.
  Do not introduce a second migration executor or pass this ledger to one.
- Deployment must not generate migrations. Drizzle Kit owns explicit
  generation; Alchemy applies only the committed SQL under `drizzle/` through
  the D1 resource dependency before uploading the Worker. A D1 migration and
  Worker upload are ordered but not one distributed transaction.
