# AGENTS.md

Instructions for coding agents working in this repository.

`README.md` is for human users and contributors: setup, capabilities,
architecture, operations, and contribution entry points. `AGENTS.md` is for
coding agents: execution rules, implementation constraints, and validation
policy. Do not duplicate agent instructions into the README or turn this file
into human onboarding documentation.

## Engineering priorities

- Correctness first, then readability and maintainability, then performance.
- Inspect the relevant implementation, callers, and existing tests before
  changing behavior.
- Prefer the smallest safe change that solves the problem.
- Reuse existing local patterns and utilities, refactoring them when needed,
  instead of creating parallel abstractions or adding dependencies.
- State the failure mode before architectural, security, persistence, or
  production-impacting changes.
- Do not declare completion until implementation, validation, and remaining
  risks are reported.
- Keep source comments and documentation concise. Do not add progress
  narration, generated banners, emojis, or speculative TODOs.

## Pull requests

- Format titles as `type[optional scope]: description`. Prefer no scope;
  include one only when it materially improves clarity.
- Use `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`,
  or `revert` as the type. Example: `feat: add response size field`.
- Keep each pull request focused. In the body, explain why the change is
  needed, what changed, how it was validated, and any remaining risk.
- Keep the title suitable for the final squash or merge commit.

## Commits

- Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/).
- Prefer no scope; include one only when it materially improves clarity. Write
  a short, imperative description. Example: `fix: preserve request ID`.
- Mark breaking changes with `!` and explain them in a `BREAKING CHANGE:`
  footer.
- Before committing, run `just qa` and `git diff --check`.

## Mandatory skills

- Use `.agents/skills/adversarial-testing/SKILL.md` for every task that
  plans, creates, modifies, reviews, debugs, or evaluates Vitest,
  workerd/D1, Playwright, contract, property, or CI test behavior. Apply it
  alongside any relevant Hono, Cloudflare, or persistence testing guidance.
- Use `.agents/skills/readme-maintenance/SKILL.md` for every README audit or
  change. Also use it to assess README impact whenever JSON:API or OpenAPI
  behavior, Cloudflare or Alchemy configuration, D1 or Drizzle persistence,
  setup, commands, architecture, deployment, CI, or supported versions
  change. Edit the README only when the audit finds a stale or missing
  reader-facing claim.

## GitHub automation

- Reference GitHub Actions by explicit full release tags such as
  `owner/action@v1.2.3`, not full commit SHAs or floating major-version tags.
  Dependabot updates those release tags.

## Project scope

This repository is a pre-deployment playground for current Cloudflare Workers
technology. Prefer a coherent current design over compatibility with an
unpublished earlier shape. Keep implementations small, explicit, and backed by
current first-party web documentation.

This is a public repository. Keep all deployment-specific values and secrets in
the ignored `.env`; commit only names and safe placeholders in `.env.example`.
Never print or copy `.env` contents into source, documentation, tests, logs,
commits, issues, or pull requests.

The project-owned Cloudflare zone is `hono-playground.dev`. Treat that zone as
fixed deployment input unless the user explicitly changes it; do not substitute
`workers.dev` or another domain.

## Locked stack and boundaries

- Hono is the HTTP router on Cloudflare Workers.
- Alchemy is the only application-owned development, planning, deployment,
  binding, secret, and infrastructure-state surface. Do not add Wrangler
  configuration, commands, generated binding types, or compatibility scripts.
- Drizzle ORM is the only application database access layer. Drizzle Kit owns
  schema migration generation and validation. Alchemy applies the reviewed
  migrations to D1 as part of the infrastructure graph.
- Effect is infrastructure-only. Do not wrap ordinary Hono request handling,
  repositories, or domain code in Effect without a concrete need.
- Check current first-party web documentation before changing this
  fast-moving stack.
- Do not use Context7 for documentation in this repository. Its indexed
  content may lag the RC and beta libraries used here. Model memory is also not
  sufficient evidence for current versions or APIs.
- Keep `alchemy`, `effect`, `drizzle-orm`, and `drizzle-kit` at their exact
  compatible prerelease versions. Upgrade them only after the live registry
  shows a newer accepted-channel release and current docs, peer ranges,
  generated migration output, and runtime tests prove the new set together.
  Do not select snapshots or upgrade only one Drizzle package.

## Dependency documentation verification

- Never use Context7 for this repository. Its indexed documentation can lag
  the release candidates and betas used here. Use current first-party web
  documentation, registries, release notes, and upstream source.
- Start from the exact versions in `package.json`, the package-manager version,
  and the exact GitHub Action tags. Query the live registry using the channel
  this repository accepts: stable `latest`, Drizzle `rc`, and the pinned
  Alchemy/Effect beta channel. A newer unrelated major or snapshot is not an
  applicable update.
- Check the current official documentation and migration or release notes for
  every directly used package before adopting an API. Prefer a versioned page
  or source tag. Record when a page is unversioned, redirects to an older major,
  or shows an API from a different release channel.
- For prerelease packages, the installed package's exported declarations,
  shipped source, package metadata, and peer ranges are the executable
  contract. If prose documentation disagrees with them, do not copy the prose
  example. Use the API present in the exact installed version and verify it
  with TypeScript plus the smallest local runtime probe.
- Verify related packages as a set. In particular, reconcile
  Alchemy/Effect/platform peers, Drizzle ORM/Kit, Hono/Zod OpenAPI/Zod, and
  Vitest/Cloudflare pool/Vite before changing any member.
- Distinguish a global latest version from the correct maintained track. For
  example, keep Node type declarations on the Node major selected by
  `engines`, and honor the repository's minimum-release-age policy instead of
  bypassing it for a just-published package.
- Validate generated or provider-sensitive behavior with non-mutating local
  commands: typecheck config APIs, run focused tests, inspect Drizzle's dry-run
  output, and exercise Worker behavior in the existing Vitest/Miniflare
  harness. Do not run Alchemy development, plan, deploy, or state operations
  merely to confirm documentation.
- If current first-party sources still conflict or the exact prerelease cannot
  be proved locally, stop and report the mismatch. Do not silently fall back to
  model memory, an older tutorial, an old package major's docs, or a guessed
  replacement API.

## Repository shape

- Put recurring contributor and CI commands in `package.json`. Keep `Justfile`
  recipes as thin aliases. Do not create a `scripts/` directory for agent-only
  instructions, generated-policy checks, or wrappers around an existing CLI.
- Colocate test-only infrastructure with the test that owns it. The Playwright
  Worker fixture belongs under `test/e2e/`; it is not a general deployment
  command.
- Commit generated output only when it is a required source artifact with a
  real consumer. Drizzle migration SQL and snapshots qualify. Generated API
  clients, duplicate schema graphs, binding declarations, Swagger assets,
  checksum manifests, and dependency notices do not without a stated
  repository requirement.
- Do not add a dependency patch or custom Alchemy provider merely to hide an
  upstream beta limitation. If the limitation blocks safe deployment, stop and
  require an explicit version or architecture decision. Otherwise document the
  boundary and reassess it on upgrade.

## TypeScript and naming

- Use explicit `.ts` extensions for relative imports between TypeScript source
  files. This no-emit project is bundled or executed directly from TypeScript,
  including `alchemy.run.ts`; do not use emitted-JavaScript `.js` specifiers for
  TypeScript modules. Keep genuine JavaScript asset names and external URLs
  unchanged.
- Use `camelCase` for variables, functions, object properties, domain fields,
  and JSON:API implementation-defined members: `createdAt`, `phoneNumber`,
  `marketingOptIn`.
- Use `PascalCase` for types, classes, schemas, and components. Use
  `UPPER_SNAKE_CASE` only for true module-level constants.
- Use affirmative, domain-specific boolean names. Prefer `inStock`,
  `termsAccepted`, and `marketingOptIn`; avoid `isEnabled`-style prefixes when
  the noun or adjective is already unambiguous.
- Include the unit in numeric names when the unit is not intrinsic. Money is an
  integer in its smallest currency unit, for example `priceCents`; never store
  or expose binary floating-point currency amounts.
- Use `Date` inside runtime and repository boundaries. Serialize timestamps as
  UTC RFC 3339 strings with millisecond precision and `Z`. Store them in D1 as
  integer Unix epoch milliseconds through Drizzle's `timestamp_ms` mode.
- `createdAt` is immutable. Change `updatedAt` only when a persisted attribute
  actually changes. Omitted optional members mean “not supplied”; use `null`
  only when it is a real domain state.

## D1 schema and Drizzle migrations

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
- `drizzle_migrations` is Alchemy's Wrangler-compatible ledger for the
  Drizzle-generated SQL files. It is not Drizzle ORM's runtime migrator table.
  Do not introduce a second migration executor or pass this ledger to one.
- Deployment must not generate migrations. Drizzle Kit owns explicit
  generation; Alchemy applies only the committed SQL under `drizzle/` through
  the D1 resource dependency before uploading the Worker. A D1 migration and
  Worker upload are ordered but not one distributed transaction.

## JSON:API 1.1 contract

- Every application resource endpoint under `/v1` follows JSON:API 1.1. Health,
  OpenAPI, and documentation endpoints are operational or descriptive
  surfaces and are the only format exceptions.
- JSON:API request and response payloads use
  `application/vnd.api+json`. Implement the specification's `415` and `406`
  media-type negotiation rules; do not silently accept `application/json` for
  resource documents.
- Every JSON:API document has at least one of top-level `data`, `errors`, or
  `meta`. `data` and `errors` never coexist; `meta` may accompany either, and a
  meta-only document is valid when the endpoint has no primary data. Successful
  resource documents include `jsonapi.version = "1.1"`, primary `data`, and a
  usable top-level `links.self`.
- Resource objects use a stable plural `type`, a string `id`, an `attributes`
  object for non-relationship data, and `links.self` only when that URL is
  fetchable. Never duplicate `id`, foreign keys, or relationships inside
  `attributes`.
- Implementation-defined JSON members use ASCII lower camel case, following
  the JSON:API recommendation. Standard members retain their specified names.
- Collection URLs use the plural resource type. Individual mutation uses
  `PATCH`, not `PUT`. Creation uses `POST` on a collection URL and returns
  `201` plus the created resource and a matching `Location`/resource
  `links.self`. Successful deletion returns an empty `204`.
- Pagination and filtering use the reserved parameter families, for example
  `page[limit]`, `page[cursor]`, and `filter[category]`. Collection pagination
  links live in the document's top-level `links` object. Reject unknown or
  unsupported JSON:API query parameters with `400`; never ignore a misspelling.
  Each supported parameter is a singleton: reject repeated parameters and
  empty cursor values instead of choosing a caller-dependent first or last
  value.
- JSON:API errors use a top-level `errors` array. Each error provides string
  `status`, stable lower-snake `code`, stable `title`, safe `detail`, and,
  where applicable, exactly one `source.pointer`, `source.parameter`, or
  `source.header`. Pointers are RFC 6901 JSON Pointers to request members, not
  dotted paths. Never echo submitted profile data, credentials, or internals.
- Resource `type` or update `id` conflicts return `409`. An unsupported
  client-generated create ID returns `403`, as required by JSON:API.
- OpenAPI operation IDs use lower-camel verb-noun names such as `listItems` and
  `updateCurrentProfile`. Component schema names are PascalCase.
- `/openapi.json` is the single OpenAPI 3.1 contract and is generated from the
  same registered Hono route schemas used for runtime validation.
  `/api-docs` is only a renderer for that document. Do not add a duplicate
  registry, generated client, standalone schema graph, or asset build pipeline
  without a concrete consumer requirement.

## Other HTTP and observability conventions

- Use lowercase, plural, hyphen-free resource path segments unless a domain
  term requires otherwise. Keep a version prefix for application resources.
- Validate requests and serialized responses at runtime from the same schemas
  that generate OpenAPI. Reject unknown application fields; do not add aliases
  for old casing or old document shapes.
- Operational RFC 9457 responses use `application/problem+json` with `type`,
  `title`, numeric `status`, safe `detail`, and stable `code`.
- Structured log and trace field names intentionally use lower `snake_case` to
  match observability query conventions. Environment variables use
  `UPPER_SNAKE_CASE`. These are separate contracts and are not JSON:API member
  names.
- A `204` response has no body or content type. All other success and error
  media types must match their documented representation exactly.

## Validation and external operations

- Run the narrowest relevant tests first, then `pnpm qa`. Run
  `pnpm test:e2e` when Worker bundling, OpenAPI, Swagger UI, CSP, or browser
  behavior changes, and run `pnpm audit` after dependency changes.
- Prefer adversarial assertions over snapshots of generated files: exercise
  malformed and duplicate protocol inputs, dependency failures, raw response
  bodies and headers, committed migrations in workerd, and observable side
  effects. Unit and integration tests must fail unexpected outbound network
  access.
- A green local suite is not deployment proof. Do not claim Cloudflare
  readiness until the exact revision has been planned, deployed, smoke tested,
  and read back from the live control plane.
- `alchemy dev` uses remote Cloudflare resources in the pinned beta, and the
  first `alchemy plan` can bootstrap remote state. Do not run development,
  plan, deploy, state, or removal operations without task authority for
  external Cloudflare changes and a verified account and explicit stage.
- Treat stable `workers.dev` and version-preview URLs as separate ingress
  surfaces. The pinned Alchemy beta enables previews with the stable URL and
  does not honor `subdomain.previewsEnabled`; keep `url: false` so both remain
  disabled. Before exposing profile routes on an Alchemy-managed custom
  domain, apply the exact reviewed Cloudflare Access policy, prove allowed and
  denied requests, and read back both direct URL settings.
