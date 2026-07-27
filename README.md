# Hono Playground

A greenfield Cloudflare Workers API demonstrating a small, current stack:
Hono, Alchemy, Drizzle, D1, and JSON:API 1.1.

Hosted documentation:
[Swagger UI](https://hono-playground.dev/api-docs) and the
[OpenAPI 3.1 document](https://hono-playground.dev/openapi.json).

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

Cloudflare invocation telemetry can retain full request URLs, and automatic D1
telemetry can retain parameterized SQL statement text. Never place credentials,
identity subjects, profile fields, or other sensitive values in URLs, and never
interpolate them into SQL. Application-owned logs use route templates and
pseudonymous owners instead of request bodies or raw identities. See the
[deployment runbook](docs/cloudflare-production.md#telemetry-privacy-validation)
for the required privacy validation.

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

The Worker Custom Domain routes every path on its hostname to this application.
Cloudflare Access is deliberately scoped to `/v1/profiles` and its descendants,
so health, item, OpenAPI, and documentation routes remain public. A future
protected route family outside that namespace requires its own reviewed Access
destination and matching Worker middleware before deployment. See the
[deployment runbook](docs/cloudflare-production.md#access) for the complete
boundary.

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
cp .env.example .env.dev
```

Operators should create only the additional environment files they are
authorized to use:

```sh
cp .env.example .env.staging
cp .env.example .env.prod
```

Install [just](https://just.systems/man/en/packages.html) for thin repository
command aliases such as `just dev`.

Populate each stage environment file with its own three Cloudflare rate-limit
namespace IDs, exact Access team domain and audience, and two distinct HMAC
keys. `WORKER_DOMAIN` is required in `.env.staging` and `.env.prod` and must be
a hostname within the project-owned `hono-playground.dev` zone;
`.env.dev` may leave it empty. Generate each key independently:

```sh
openssl rand -hex 32
```

Never commit stage environment files, share namespace IDs between stages, or
reuse one key for both purposes.
Alchemy rejects malformed or duplicate namespace IDs, invalid Access
configuration, weak HMAC keys, and key reuse before creating the Worker.

Configure and authenticate one Alchemy profile per environment you use:

```sh
pnpm exec alchemy login --profile dev --env-file .env.dev --configure
pnpm exec alchemy login --profile staging --env-file .env.staging --configure
pnpm exec alchemy login --profile prod --env-file .env.prod --configure
```

Start the Alchemy development loop:

```sh
just dev
```

`just dev` runs `alchemy dev` with `.env.dev`, profile `dev`, and the explicit
personal [stage](https://alchemy.run/environments/stages/) `dev_$USER`, then
serves the Worker at `http://127.0.0.1:8787`. Passing every selector prevents a
shell or environment-file default from redirecting development to staging or
production. The personal stage has isolated state and physical resource names,
so it does not overlap teammates, staging, or production.

Alchemy stores named profiles outside this repository. Re-run
`pnpm exec alchemy login` with the matching `--profile` and `--env-file`
arguments, without `--configure`, to refresh an existing profile.

This is not a cloud-free emulator. In Alchemy's
[local development loop](https://alchemy.run/environments/local-development/),
the Worker runs locally in workerd with hot reloading, but D1 and several other
bindings are real, stage-isolated Cloudflare resources. Development therefore
requires Cloudflare authentication, can create remote state, and does not
delete that state when the watcher stops. The source pins compatibility date
`2026-07-11`, the newest date accepted by the local workerd nested under
Alchemy `2.0.0-beta.64`; the hosted edge supports newer dates, but selecting
one would break this development command. Use the Vitest and Playwright suites
for secretless local validation. Infrastructure accepts only `prod`,
`staging`, and Alchemy's personal `dev_<name>` stages; a typo or pull-request
stage fails before D1 or Worker provider operations can run.

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
pnpm run audit
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
The pinned Cloudflare Vitest pool brings Wrangler transitively, but Wrangler is
not a direct dependency or an application development/deployment surface.

## Plan and deploy

```sh
just plan staging
just deploy staging

just plan prod
just deploy prod
```

`plan` and `deploy` have no default environment: bare `just plan` or
`just deploy` fails before Alchemy starts. Each recipe accepts only `staging`
or `prod` and passes the matching `.env.<environment>` file, profile, and stage
explicitly. `just logs <environment>` and `just tail <environment>` use the
same pairing; `dev` maps to the personal `dev_$USER` stage.

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
staging or production readiness. The runbook also defines the operator
procedure for erasing a profile after its Access identity has been removed.

## Contributing

Use the repository's
[GitHub issue chooser](https://github.com/janisto/hono-playground/issues/new/choose)
for reproducible bug reports and well-scoped feature requests. Report
security vulnerabilities through the private security-advisory link there,
never in a public issue.

Before opening a pull request, run:

```sh
pnpm qa
pnpm run audit
pnpm test:e2e
```

Coding-agent execution rules and the full project contract live in
[AGENTS.md](AGENTS.md). Reusable repository-specific agent workflows live in
[.agents/skills/](.agents/skills/).

## Documentation

- [Alchemy Workers](https://alchemy.run/cloudflare/workers/workers/)
- [Alchemy profiles](https://alchemy.run/environments/profiles/)
- [Alchemy secrets and environment bindings](https://alchemy.run/cloudflare/security/secrets-env/)
- [Alchemy D1](https://alchemy.run/cloudflare/data/d1/)
- [Drizzle Kit migrations](https://orm.drizzle.team/docs/migrations)
- [Drizzle Kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate)
- [Hono OpenAPI](https://hono.dev/examples/zod-openapi)
- [Hono Swagger UI](https://hono.dev/examples/swagger-ui)
- [JSON:API 1.1](https://jsonapi.org/format/)
