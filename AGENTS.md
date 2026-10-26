# AGENTS.md

Instructions for coding agents. Keep execution rules here; `README.md` serves
human users and contributors. Do not duplicate agent instructions into it.

## Engineering priorities

- Prioritize correctness, readability, maintainability, then performance.
- Inspect the implementation, callers, and tests before changing behavior.
- Prefer the smallest safe change; reuse or refactor local patterns and utilities
  before adding abstractions or dependencies.
- Validate review findings against requirements and reproducible behavior.
  Simplify unnecessary behavior instead of adding machinery to defend it.
- State the failure mode before architectural, security, persistence, or
  production-impacting changes.
- Report implementation, validation, and remaining risks before completion.
- Keep instructions, comments, and documentation concise. Explain and obtain
  explicit approval before removing, merging, or relocating guidance, including
  obsolete rules, completed-task narration, and duplicates.
- Do not add progress narration, generated banners, emojis, or speculative TODOs.
- Keep public code, instructions, comments, documentation, commits, and PR text
  self-contained. Do not disclose private coordination repositories, paths,
  revisions, or discussions.

## Epistemic honesty and scope discipline

- Report defects, corrupted data, unmet requirements, and unfinished work plainly.
  Never conceal them in justifications or relabel them as simplifications,
  provisional scope, or expected limitations. If a problem is deeper than
  expected, stop at a safe boundary and report the exact failure, affected
  behavior or records, and remaining work.
- Counts, checksums, and passing tests show consistency, not semantic correctness.
  Before claiming JSON:API validation, D1 queries, or Drizzle migrations work,
  inspect accepted payloads and rows treated as valid using synthetic fixtures
  or authorized data. Hunt for false positives; report the worst counterexamples,
  or describe the sample when none were found.
- Fix the bug class behind cited failures: correct the grammar, validation, query,
  or logic and audit all affected paths or records within the authorized scope.
  Do not hardcode cited values into exceptions or blocklists, or patch only named
  IDs.
- Do not weaken specifications, `AGENTS.md`, or active plans to excuse defects or
  shortcuts. Follow current task scope and stop gates. For review-only or
  report-only work, edit only an explicitly requested report.
- After the final code, schema, or generator change, replay reviewed migrations
  against affected local D1 test databases, rebuild affected OpenAPI and Worker
  artifacts, and rerun relevant checks. Earlier results do not validate later
  edits.

## Commits and pull requests

- Use [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):
  `type: imperative description`. Add a scope only when it materially improves
  clarity. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
  `ci`, `chore`, and `revert`.
- Use the same format for PR titles, suitable for the final merge commit. Keep PRs
  focused; describe the problem, resulting behavior, validation, and remaining
  risks.
- Mark breaking changes with `!` and a `BREAKING CHANGE:` footer explaining the
  impact.
- Work on task branches; never commit directly to the default branch.
- Before committing, always run `just qa` and `git diff --check`.
- Use one atomic PR when layers would require manual settings changes between
  merges. A stack must be mergeable as a whole.

## Skills and validation

### Required guidance

- Use `.agents/skills/edit-agent-instructions/SKILL.md` when reviewing or editing
  root or nested agent instructions.
- Use `.agents/skills/adversarial-testing/SKILL.md` whenever planning, creating,
  modifying, reviewing, debugging, or evaluating tests. Apply relevant language,
  framework, and infrastructure testing guidance alongside it.
- Use `.agents/skills/readme-maintenance/SKILL.md` for README audits and edits.
  Assess README impact when API behavior/contracts, persistence, configuration,
  setup, commands, architecture, tooling, deployment, CI, or supported versions
  change. Edit the README only for stale or missing reader-facing claims.

### Validation

- Run the narrowest relevant tests first, then `just qa`. Run
  `pnpm test:e2e` when Worker bundling, OpenAPI, Swagger UI, CSP, or browser
  behavior changes, and run `pnpm run audit` after dependency changes.
- Prefer adversarial assertions over snapshots of generated files: exercise
  malformed and duplicate protocol inputs, dependency failures, raw response
  bodies and headers, committed migrations in workerd, and observable side
  effects. Unit and integration tests must fail unexpected outbound network
  access.

## GitHub automation

- Preserve independent pure lint for early feedback. When modernizing workflows,
  use stable `ci` and `lint` check names and fail CI for any mandatory
  non-success result. Keep workflow scanners independent of language quality.
- Before workflow changes, use Chrome to inspect GitHub Settings > Rules >
  Rulesets, required check names, and GitHub App sources. Preserve existing
  enforcement until replacements reach trunk. Verify final rulesets and actual
  PR checks in Chrome; CLI/API evidence supplements this. Report blocked access
  and never weaken protection to make a PR pass.
- Use matching local/CI actionlint and offline pedantic zizmor, with one enforcing
  read-only plain-mode scan and no SARIF or security-event write permissions.
- Keep Dependabot security alerts and automated security updates disabled, while
  retaining scheduled updates and native audits. Do not add replacement alert
  bots or repeat unchanged upstream triage. Keep auto-merge limited to verified
  Dependabot minor/patch updates behind required checks, without duplicate
  package filters, state queries, enablement triggers, or revocation machinery.
- Upgrade Biome deliberately, including patches, with migration, configuration,
  diagnostics, pins, and native validation. Use all-version Dependabot ignore
  entries when configuring dependency automation so these changes remain manual.
- Reference GitHub Actions by explicit full release tags such as
  `owner/action@v1.2.3`, not full commit SHAs or floating major-version tags.
  Dependabot updates those release tags.

## Project scope

This repository is a playground for current Cloudflare Workers technology.
Prefer a coherent current design over compatibility with an unpublished
earlier shape. Keep implementations small, explicit, and backed by current
first-party web documentation. Keep `README.md` and
`docs/cloudflare-production.md` limited to stable public architecture,
configuration, and procedures. Put transient deployment progress, dates,
revision hashes, live counts, and control-plane snapshots in an ignored
`plans/` file when a task needs them.

This is a public repository. Keep all deployment-specific values and secrets in
the ignored `.env.dev`, `.env.staging`, and `.env.prod` files; commit only
names and safe placeholders in `.env.example`. Never print or copy environment
file contents into source, documentation, tests, logs, commits, issues, or pull
requests.

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
- Keep `alchemy`, `effect`, `drizzle-orm`, and `drizzle-kit` at their exact
  compatible prerelease versions. Upgrade them only after the live registry
  shows a newer accepted-channel release and current docs, peer ranges,
  generated migration output, and runtime tests prove the new set together.
  Do not select snapshots or upgrade only one Drizzle package.

## Dependency documentation verification

- Never use Context7 for this repository. Its indexed documentation can lag
  the release candidates and betas used here. Use current first-party web
  documentation, registries, release notes, and upstream source. Model memory
  alone is not evidence for current versions or APIs.
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

## Infrastructure and compatibility dates

Before infrastructure, Alchemy/workerd or Vitest/Miniflare dependency, or Worker
compatibility-date changes, read [infra/AGENTS.md](infra/AGENTS.md). The date must be
supported by every pinned execution path. Provider mutations still require the
explicit authority and target checks under [External operations](#external-operations).

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

Before Drizzle, D1, schema, migration, or deployment changes, read
[src/db/AGENTS.md](src/db/AGENTS.md), including work outside that directory.
`src/db/schema.ts` owns the schema; Drizzle Kit owns generated migration files.
Never hand-edit generated output or rewrite applied or possibly applied history.
Discarding unapplied committed/shared history requires explicit user authority
and proof that no persistent stage applied it. Do not use `drizzle-kit push` or
add a second migration executor. Deployment applies reviewed committed migrations;
it must not generate them.

## JSON:API 1.1 contract

- Item and profile endpoints use JSON:API 1.1. Health, hello, and GitHub use
  plain JSON successes and Problem Details failures; OpenAPI and documentation
  remain descriptive surfaces.
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
- Request `hreflang` is an ignored link hint. Keep its validation deliberately
  lightweight: require an alphabetic primary chunk and bounded alphanumeric
  subtags, rejecting major syntax errors such as numeric-only or whitespace
  values. Do not add a registry, dependency, or full RFC parser for this hint.
- Strict JSON parsing caps container nesting before Zod validation. That global
  guard also bounds recursive `describedby` link objects; do not add a second
  schema-specific depth limiter unless the validation order changes.
- Implementation-defined JSON members use ASCII lower camel case, following
  the JSON:API recommendation. Standard members retain their specified names.
- Item collection URLs use the plural resource type. Profile is a singleton at
  `/v1/profile`; its mutation uses `PATCH`, not `PUT`, and its creation uses
  `POST` on the singleton URL. Creation returns `201` plus the created resource
  and a matching `Location`/resource `links.self`. Successful deletion returns
  an empty `204`.
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
  `updateProfile`. Component schema names are PascalCase.
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
- Keep Cloudflare invocation logs and traces enabled. Cloudflare retains full
  request URLs and parameterized D1 SQL statement text, while D1 Query Insights
  omits bound parameter values. Never put credentials, Access subjects, profile
  values, or other sensitive data in URL paths or query strings, and never
  interpolate values into SQL. Application logs use route templates, safe
  fixed fields, and keyed pseudonyms; they never log request or response bodies.
- A telemetry privacy audit must inspect both application-owned events and the
  enriched Cloudflare event/trace details plus D1 Query Insights. Alchemy's
  compact log output does not expose every persisted automatic attribute.
- Known issue: Cloudflare Precursor injects a request-specific inline bootstrap
  into `/api-docs`. The strict hash-based policy blocks that bootstrap and
  Chromium logs a CSP violation, while Swagger UI continues to render. Keep
  Precursor enabled and do not weaken the CSP to suppress this expected log.
  Ignore only this known violation during live smoke tests; other console
  errors remain failures.
- A `204` response has no body or content type. All other success and error
  media types must match their documented representation exactly.

## External operations

- Use `just dev` for the Alchemy development loop. It explicitly selects
  `.env.dev`, profile `dev`, and personal stage `dev_$USER`, and serves on
  `http://127.0.0.1:8787`. Use `just plan staging|prod`,
  `just deploy staging|prod`, and `just logs|tail dev|staging|prod`; the
  Justfile derives and passes the matching environment file, profile, and
  stage. Never bypass these pairings with raw Alchemy or package commands in
  agent work. Bare `just plan` and `just deploy` must fail rather than choose a
  persistent stage. The development loop needs native file watching and remote
  Cloudflare access; in a sandboxed agent session, acquire those permissions
  before running it instead of treating a sandbox-denied watcher as an
  application failure.
- A green local suite is not deployment proof. Do not claim Cloudflare
  readiness until the exact revision has been planned, deployed, smoke tested,
  and read back from the live control plane.
- `alchemy dev` uses remote Cloudflare resources in the pinned beta, and the
  first `alchemy plan` can bootstrap remote state. Do not run development,
  plan, deploy, state, or removal operations without task authority for
  external Cloudflare changes, a verified account, and an exact resolved target
  environment file, profile, and stage. For `just dev`, those selectors are
  `.env.dev`, profile `dev`, and the explicit `dev_$USER` stage.
- Treat stable `workers.dev` and version-preview URLs as separate ingress
  surfaces. The pinned Alchemy beta enables previews with the stable URL and
  does not honor `subdomain.previewsEnabled`; keep `url: false` so both remain
  disabled.
- On an Alchemy-managed custom domain, keep the Cloudflare Access application
  scoped to the exact hostname and Path `v1/profile`; that path covers the
  singleton root and descendants. Do not leave Path empty, because that would
  protect `/health`, item routes, OpenAPI, documentation, and every future
  route on the hostname. Keep the Worker authentication and profile-limit
  middleware on the verified Hono `/v1/profile/*` scope, which covers the
  singleton root and descendants; do not also register the root and double-run
  those controls. Before exposing a protected route family outside that
  namespace, add a reviewed Access destination or application and matching
  Worker middleware. Prove allowed and denied requests and read back both
  direct URL settings.
