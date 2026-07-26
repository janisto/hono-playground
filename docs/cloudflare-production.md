# Cloudflare deployment runbook

This repository has not been deployed. Every live-state item below is pending
until it has been read back from Cloudflare after a successful apply.

## Failure boundary

What breaks if deployment fails?

- A D1 migration can commit before the Worker upload fails.
- The accepted stage can target the wrong Cloudflare account.
- A Worker can be healthy while its external Access policy protects the wrong
  hostname or audience.
- A source rollback cannot reverse D1 or recover an older secret value.

Alchemy gives the repository one desired resource graph and one Worker upload
containing code, bindings, and secrets. Cloudflare's D1, Worker, Access, and
account APIs do not form a whole-stack transaction. Always verify observed
live state after an apply.

## Intended state

| Resource | Intended configuration | Current status |
| --- | --- | --- |
| Stack | `HonoPlayground`, explicit stage | not created |
| Worker | `hono-playground-<stage>`, `workers.dev` and previews disabled | not created |
| Runtime | compatibility date `2026-07-25` | config only |
| D1 | `hono-playground-db-<stage>`, EU jurisdiction, replication disabled | not created |
| Migration ledger | `drizzle_migrations` | not created |
| Rate limiting | public 300/min per route and actor, profile reads 120/min, profile writes 30/min | config only |
| Secrets | distinct rate-limit and audit HMAC bindings | not uploaded |
| Observability | persisted logs; authenticated trace propagation; 1% production traces; version metadata | config only |
| Ingress | Alchemy-managed custom hostname; no direct Worker URL | not created |
| Access | exact custom hostname and reviewed allow policy | external, not created |
| Alchemy state | Cloudflare-backed state | not bootstrapped |

Alchemy owns the Worker, D1 database, committed migration application,
rate-limit bindings, runtime variables/secrets, compatibility settings, and
observability. Access applications and identity policies, DNS/custom domains,
WAF, alerts, budgets, and recovery procedures are external state.

Staging and production D1 databases have a retain removal policy. There is no
destroy script in this repository.

## Required input

Copy `.env.example` to the ignored `.env` and supply:

```text
PUBLIC_RATE_LIMIT_NAMESPACE_ID
PROFILE_READ_RATE_LIMIT_NAMESPACE_ID
PROFILE_WRITE_RATE_LIMIT_NAMESPACE_ID
WORKER_DOMAIN
ACCESS_TEAM_DOMAIN
ACCESS_AUD
RATE_LIMIT_KEY_HMAC_KEY
AUDIT_SUBJECT_HMAC_KEY
```

Before deployment:

- choose three distinct positive-integer strings that do not collide with
  another binding namespace in the target account (these bindings are not
  visible in the Cloudflare dashboard);
- select the lowercase custom hostname for this stage;
- copy the team domain and audience from the exact Access application;
- generate the two lowercase 64-hex HMAC values independently;
- keep Cloudflare credentials and every secret outside Git; and
- confirm the selected account and explicit stage.

Only `prod`, `staging`, and a personal `dev_<name>` stage are accepted.
Unsupported stages fail before D1 or Worker provider operations can run. Do
not add a pull-request stage until its retention, ingress, Access, and removal
policy are designed and tested.

Alchemy resolves these values at deployment. `WORKER_DOMAIN` controls the
Alchemy-managed custom domain and is not a runtime binding. Effect Config
inputs declared in the Worker's `env` become `secret_text` bindings in the
same upload as code and ordinary bindings. A rotation is therefore a Worker
deployment. Rotating the rate-limit key starts new application buckets;
rotating the audit key breaks pseudonym continuity.

The Alchemy program validates namespace syntax and uniqueness, the Access team
domain and audience, HMAC strength, and HMAC separation before it can create
the Worker. Runtime validation remains in place as defense in depth.

## Migration review

The only supported schema-change flow is:

```sh
pnpm db:preview
pnpm db:generate describe_schema_change
pnpm db:check
```

The first command is a dry run. If it is wrong or incomplete, correct the
Drizzle model or stop for a dependency/architecture decision; never patch the
generated SQL or snapshot. Replace the example generation name with a specific
lower-snake-case description; generation fails when the name is omitted.
`pnpm db:check` checks migration-branch consistency and fails when Drizzle's
non-mutating dry run finds ungenerated model changes. Review and commit every
generated `migration.sql` and `snapshot.json` unchanged. Deployment never
generates migrations. Alchemy applies pending committed SQL before uploading
the dependent Worker.

Never edit a migration. Never remove one after it may have reached any
persistent stage. Alchemy's D1 ledger identifies applied migrations by file
name, not by a stored content hash. CI rejects modifications, deletions, and
renames of generated files already present in the target branch; add a forward
migration instead.

The configured `drizzle_migrations` table is Alchemy's Wrangler-compatible
ledger for Drizzle-generated files. It is not Drizzle ORM's runtime migrator
table, and this repository does not use a second migration executor.

D1 migration plus ledger insertion are sent together, but the database
migration and later Worker upload are not atomic. Use an additive/expand-first
change when a deployed schema must coexist with old and new Worker versions.
This repository does not preserve compatibility for unpublished API shapes;
that does not permit unsafe changes to deployed data.

## First staging apply

1. Confirm the Cloudflare account, exact source revision, stage `staging`, and
   absence of another apply for the same stack.
2. Run:

   ```sh
   pnpm qa
   pnpm audit
   pnpm test:e2e
   pnpm infra:plan -- --stage staging
   ```

3. Review every proposed resource, binding, secret change, and migration. The
   first Alchemy command may bootstrap its state store; `plan` is not
   guaranteed to be zero-write on an uninitialized account.
4. Apply:

   ```sh
   pnpm infra:deploy -- --stage staging
   ```

5. Plan again and explain any residual change:

   ```sh
   pnpm infra:plan -- --stage staging
   ```

6. Read back the Worker name/version, confirm both `workers.dev` and preview
   URLs are disabled, and verify the D1 identity/schema/ledger, binding types,
   compatibility date, logs, traces, and rate-limit behavior.
7. Run positive and negative HTTP smoke tests with synthetic data, then delete
   the synthetic profile.

Do not use `pnpm dev` as deployment proof. In the pinned Alchemy beta it runs
the Worker locally but connects D1 and several bindings to real
stage-isolated Cloudflare resources.

## Access

Profile routes fail closed in the Worker unless the Access assertion verifies
with RS256, the exact issuer and audience, required time claims, `type=app`,
and a bounded subject.

Before production:

1. Select an owned custom hostname. Direct
   `workers.dev` and version-preview ingress remain disabled.
2. Create the self-hosted Access application and exact reviewed allow policy
   for that custom hostname.
3. Set the exact hostname as `WORKER_DOMAIN`; Alchemy attaches it to the
   Worker during deployment and Cloudflare infers the existing zone.
4. Read back the hostname/path scope, audience, policy order, identity
   providers, session duration, and unauthenticated denial.
5. Put that exact team domain and audience into the production deployment
   environment.
6. Verify both an allowed identity and a denied/absent identity at the edge.

Do not add an application authentication bypass, service-token profile
ownership, or a local development identity shortcut.

Cloudflare Access `sub` is unique to an email address within an account, but
Cloudflare assigns a different value after a user is removed and re-added.
Revoking or deprovisioning an Access user stops authentication; it does not
delete the profile owned by the old subject in D1. The authenticated
`DELETE /v1/profiles/current` route supports self-service erasure while the
identity is active. Before production, define and prove an operator
offboarding path that can erase a profile by its old subject, set a retention
and evidence policy, and order erasure before Access removal when possible.
Do not switch ownership to mutable or recyclable email addresses. Production
is blocked until this external identity/data lifecycle exists.

## Production apply

Repeat the staging process with `--stage prod` from the exact approved
revision. Freeze concurrent changes, explicitly accept the D1/Worker
partial-failure boundary, and inspect a second plan after deployment.

Pinned Alchemy `2.0.0-beta.64` ties version-preview URLs to its `url` property
and ignores a separate `subdomain.previewsEnabled` input. This repository sets
`url: false`, which disables both direct surfaces in the pinned provider.
Verify both settings live and reassess this behavior on every Alchemy upgrade.

After deployment verify:

- custom Worker hostname, disabled direct/preview URLs, source version,
  compatibility date, binding types, and secrets present without reading
  their values;
- D1 name, jurisdiction, replication mode, schema, migration ledger, and
  recovery availability;
- actual allow/block behavior for every rate-limit class;
- Access allow and deny behavior with the exact audience;
- `/health`, JSON:API content negotiation, `/openapi.json`, and `/api-docs`;
- create/read/update/delete for one synthetic profile; and
- absence of bodies, profile values, raw subjects, tokens, SQL, and bound
  values in application-owned logs and traces.

Application access logs intentionally do not estimate D1 scans or writes from
returned array lengths. Use Cloudflare's automatic D1 span attributes for
exact rows read, rows written, changes, SQL duration, and retry attempts.
Application logs do not copy caller-supplied `traceparent` identifiers.
Cloudflare trace propagation accepts authenticated contexts, and production
trace head sampling is `0.01`; staging and development retain full trace
sampling for validation. Public rate-limit keys combine the normalized actor
with the fixed route template, but Cloudflare's binding remains intentionally
approximate and location-local rather than a global exact counter.

Use Alchemy for application logs and live tailing:

```sh
pnpm infra:logs -- --stage prod
pnpm infra:tail -- --stage prod
```

Tail output is diagnostic, not a durable audit ledger.

## Recovery

A code rollback is a new, planned Alchemy deployment from a known-good revision
that is compatible with the current D1 schema and explicitly supplied secret
versions. It does not reverse migrations, data, Access, DNS, or secret
rotations.

After a partial failure:

1. stop concurrent applies and preserve non-secret error/plan output;
2. read the actual Worker version, D1 schema/ledger, and Access state;
3. choose a forward repair or compatible known-good Worker; and
4. deploy through Alchemy, plan again, and repeat the live smoke tests.

Do not perform D1 Time Travel or another destructive recovery operation from
this repository without separate approval and a current Cloudflare procedure.

## References

- [Alchemy state store](https://alchemy.run/state-store/)
- [Alchemy secrets and environment bindings](https://alchemy.run/cloudflare/security/secrets-env/)
- [Alchemy D1](https://alchemy.run/cloudflare/data/d1/)
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Cloudflare Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [Cloudflare Worker preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Cloudflare D1 trace attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)
