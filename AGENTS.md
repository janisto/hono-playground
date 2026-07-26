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

## Project scope

This repository is a pre-deployment playground for current Cloudflare Workers
technology. Prefer a coherent current design over compatibility with an
unpublished earlier shape. Keep implementations small, explicit, and backed by
current first-party web documentation.

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
- Check current official web documentation before changing this fast-moving
  stack. Context7 and model memory are not sufficient evidence for versions or
  APIs.
- Keep `alchemy`, `effect`, `drizzle-orm`, and `drizzle-kit` at their exact
  compatible prerelease versions. Upgrade them only after the live registry
  shows a newer accepted-channel release and current docs, peer ranges,
  generated migration output, and runtime tests prove the new set together.
  Do not select snapshots or upgrade only one Drizzle package.

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

## D1 and Drizzle naming

- SQL identifiers use lower `snake_case`: plural table names, singular column
  names, `id` primary keys, `<resource>_id` foreign keys, and timestamp columns
  such as `created_at`.
- Define SQLite tables with Drizzle v1 `snakeCase.table`. TypeScript schema keys
  stay camelCase and Drizzle performs the declared mapping. Do not hand-write
  duplicate casing conversion code or explicit SQL column aliases unless an
  external schema forces an exception and the exception is documented.
- Use `integer({ mode: "boolean" })` for D1 booleans and enforce domain
  invariants with database checks. Use `STRICT` SQLite tables.
- Application repositories use Drizzle queries. Raw SQL is limited to reviewed
  migrations and tests that verify D1 behavior.
- Migration directories are versioned rollout history. Run
  `pnpm db:generate`, then review and commit both `migration.sql` and
  `snapshot.json`. Run `pnpm db:check` for Drizzle's migration-branch
  consistency check. Never edit, reorder, rename, or remove a migration that
  may have been applied; add a new forward migration instead.
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
  does not honor `subdomain.previewsEnabled`. Before exposing profile routes,
  protect both surfaces with reviewed Cloudflare Access policies and prove
  allowed and denied requests, or do not deploy.
