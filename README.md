# Hono Playground

A greenfield Cloudflare Workers API demonstrating a small, current stack:
Hono, Alchemy, Drizzle, D1, and JSON:API 1.1.

Staging is deployed at
[staging.hono-playground.dev](https://staging.hono-playground.dev) from commit
`26af818`. The Worker, D1 database, committed migration, bindings, custom
domain, logs, and traces have been read back from Cloudflare. The profile path
is protected by the owner-only Access policy; anonymous denial and a signed-in
owner reaching the application were verified on 2026-07-26. Full live
synthetic profile CRUD remains pending, and production has not been deployed.

## Stack

- Hono `4.12.32` routes requests and generates OpenAPI 3.1.
- Alchemy `2.0.0-beta.64` owns Worker development, infrastructure, bindings,
  secrets, state, and deployment.
- Drizzle ORM and Drizzle Kit `1.0.0-rc.4` own database access and migration
  generation.
- Effect `4.0.0-beta.101` is limited to the Alchemy program.
- Cloudflare D1 persists profiles; Cloudflare Access authenticates profile
  owners.

There is no application-owned Wrangler configuration or command. Alchemy
infers the Worker binding type from its resource graph, so the runtime type,
declared bindings, and deployment definition stay together. Values loaded
through Effect Config become `secret_text` bindings in the same Worker upload
as the code and other bindings. This removes the separate code/type/secret
workflow, but it does not make D1 migrations or external Access policy atomic
with a Worker upload.

## API

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | operational JSON |
| `GET` | `/v1/items` | cursor-paginated JSON:API collection |
| `GET` | `/v1/items/{itemId}` | JSON:API resource |
| `POST` | `/v1/profiles` | create the Access identity's profile |
| `GET` | `/v1/profiles/current` | read the current profile |
| `PATCH` | `/v1/profiles/current` | update the current profile |
| `DELETE` | `/v1/profiles/current` | empty `204` |
| `GET` | `/openapi.json` | OpenAPI `3.1.0` |
| `GET` | `/api-docs` | Swagger UI |

Resource requests and responses use `application/vnd.api+json`. Profile routes
derive ownership from the verified Cloudflare Access `sub`; callers cannot
choose an owner ID. Missing or invalid origin assertions return a JSON:API
`403`. Unsupported query parameters return a JSON:API `400` on every resource
route instead of being ignored.

Application and JSON:API fields use `camelCase`, such as `createdAt` and
`marketingOptIn`. SQL identifiers use `snake_case`, such as `created_at` and
`marketing_opt_in`. Drizzle v1 `snakeCase.table` declares that mapping once.
See [AGENTS.md](AGENTS.md) for the complete repository contract.

Swagger UI is provided by the official Hono middleware and loads the exact
`swagger-ui-dist@5.32.11` assets from jsDelivr. That avoids a generated asset
pipeline, but makes the documentation UI depend on that CDN. The OpenAPI JSON
endpoint itself has no CDN dependency, and “Try it out” plus the online
validator are disabled.

## Setup

Use the pinned Node 24 and pnpm 11 toolchain:

```sh
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env
```

Populate `.env` with the three Cloudflare rate-limit namespace IDs, the exact
Access team domain and audience, and two distinct HMAC keys. `WORKER_DOMAIN`
is also required for `staging` and `prod` and must be a hostname within the
project-owned `hono-playground.dev` zone; local development may leave it empty.
Generate each key independently:

```sh
openssl rand -hex 32
```

Never commit `.env` or reuse one key for both purposes.
Alchemy rejects malformed or duplicate namespace IDs, invalid Access
configuration, weak HMAC keys, and key reuse before creating the Worker.

Start the Alchemy development loop:

```sh
pnpm dev
```

This is not a cloud-free emulator. In the pinned Alchemy beta, the Worker runs
locally in workerd while D1 and several other bindings resolve to real,
stage-isolated Cloudflare resources. Development therefore requires
Cloudflare authentication and can create remote state. Use the Vitest and
Playwright suites for secretless local validation. Infrastructure accepts only
`prod`, `staging`, and Alchemy's personal `dev_<name>` stages; a typo or
pull-request stage fails before D1 or Worker provider operations can run.

## Database migrations

[src/db/schema.ts](src/db/schema.ts) is the code schema.
[drizzle/](drizzle/) contains reviewed SQL migrations and snapshots.

For every schema change:

```sh
pnpm db:preview
pnpm db:generate describe_schema_change
pnpm db:check
```

The first command is a dry run. If its SQL is wrong, fix the Drizzle model
instead of patching generated output. Review and commit both generated files,
but never edit either one. Replace the example generation name with a specific
lower-snake-case description; generation fails when the name is omitted.
`pnpm db:check` checks migration-branch consistency and fails when a
non-mutating Drizzle dry run finds model changes without generated artifacts.
CI also rejects modifications, deletions, or renames of migrations already in
the target branch. Never remove a migration that may have been applied; change
the model and generate a forward migration. Deployment does not generate
migrations. Alchemy's D1 resource applies only the committed SQL under
`drizzle/` before the Worker that depends on that database is uploaded.

`drizzle_migrations` is Alchemy's Wrangler-compatible tracking table for these
Drizzle-generated files; this application does not use Drizzle ORM's runtime
migration executor.

That ordering is not a distributed transaction. A successful D1 migration
remains applied if a later Worker upload fails, so code and migrations must be
designed for that partial-failure boundary.

## Validation

```sh
pnpm test:unit
pnpm test:integration
pnpm test:d1
pnpm coverage
pnpm test:e2e
pnpm qa
pnpm audit
```

`pnpm qa` runs non-mutating formatting and lint checks, strict TypeScript
checks, Drizzle migration consistency and freshness checks, and coverage. The
configured workflows run Biome independently, preserve append-only migration
history plus type, migration, coverage, production dependency audit, and
real-browser documentation gates, publish the coverage artifact, and audit
GitHub Actions with zizmor.

The D1 tests run the committed migrations in workerd and exercise the Drizzle
repository against the resulting database. The Playwright test bundles the
Worker and runs it in Miniflare; it verifies that a browser can load Swagger UI
and fetch the OpenAPI 3.1 document without application or network failures.
Cloudflare's official Vitest pool currently brings Wrangler transitively, but
Wrangler is not a direct dependency or an application development/deployment
surface.

## Plan and deploy

```sh
pnpm infra:plan --stage staging
pnpm infra:deploy --stage staging

pnpm infra:plan --stage prod
pnpm infra:deploy --stage prod
```

The first Alchemy operation can bootstrap account state even when the command
is `plan`. Confirm the Cloudflare account and stage before approving it.
`staging` and `prod` D1 databases use a retain removal policy. The Worker sets
Alchemy's `url` property to `false`, which disables its stable `workers.dev`
URL and version-preview URLs in the pinned provider. Staging and production
require a validated `WORKER_DOMAIN`; Alchemy attaches that custom hostname
while Cloudflare Access application and policy management remain external.
Read back the custom domain and both direct URL settings after deployment, and
reassess the provider behavior on every Alchemy upgrade.

Cloudflare Access application and policy management remains external to this
repository. Complete the checklist in
[docs/cloudflare-production.md](docs/cloudflare-production.md) before claiming
staging or production readiness.

## Contributing

Use the repository's
[GitHub issue chooser](https://github.com/janisto/hono-playground/issues/new/choose)
for reproducible bug reports and well-scoped feature requests. Report
security vulnerabilities through the private security-advisory link there,
never in a public issue.

Before opening a pull request, run:

```sh
pnpm qa
pnpm audit
pnpm test:e2e
```

Coding-agent execution rules and the full project contract live in
[AGENTS.md](AGENTS.md).

## Current documentation

- [Alchemy Workers](https://alchemy.run/cloudflare/workers/workers/)
- [Alchemy secrets and environment bindings](https://alchemy.run/cloudflare/security/secrets-env/)
- [Alchemy D1](https://alchemy.run/cloudflare/data/d1/)
- [Drizzle Kit migrations](https://orm.drizzle.team/docs/migrations)
- [Drizzle Kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate)
- [Hono OpenAPI](https://hono.dev/examples/zod-openapi)
- [Hono Swagger UI](https://hono.dev/examples/swagger-ui)
- [JSON:API 1.1](https://jsonapi.org/format/)
