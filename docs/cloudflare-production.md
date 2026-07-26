# Cloudflare deployment runbook

This repository has not been deployed. Every live-state item below is pending
until it has been read back from Cloudflare after a successful apply.

## Failure boundary

What breaks if deployment fails?

- A D1 migration can commit before the Worker upload fails.
- A correct source revision can be deployed with the wrong stage or account.
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
| Worker | `hono-playground-<stage>` | not created |
| Runtime | compatibility date `2026-07-25` | config only |
| D1 | `hono-playground-db-<stage>`, EU jurisdiction, replication disabled | not created |
| Migration ledger | `drizzle_migrations` | not created |
| Rate limiting | public 300/min, profile reads 120/min, profile writes 30/min | config only |
| Secrets | distinct rate-limit and audit HMAC bindings | not uploaded |
| Observability | persisted logs/traces and version metadata | config only |
| Access | exact production Worker hostname and reviewed allow policy | external, not created |
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
ACCESS_TEAM_DOMAIN
ACCESS_AUD
RATE_LIMIT_KEY_HMAC_KEY
AUDIT_SUBJECT_HMAC_KEY
```

Before deployment:

- choose three distinct positive-integer strings that do not collide with
  another binding namespace in the target account (these bindings are not
  visible in the Cloudflare dashboard);
- copy the team domain and audience from the exact Access application;
- generate the two lowercase 64-hex HMAC values independently;
- keep Cloudflare credentials and every secret outside Git; and
- confirm the selected account and explicit stage.

Alchemy resolves these values at deployment. Effect Config inputs become
`secret_text` bindings in the same Worker upload as code and ordinary
bindings. A rotation is therefore a Worker deployment. Rotating the
rate-limit key starts new application buckets; rotating the audit key breaks
pseudonym continuity.

## Migration review

The only supported schema-change flow is:

```sh
pnpm db:generate
pnpm db:check
```

Review and commit every generated `migration.sql` and `snapshot.json`.
Deployment never generates migrations. Alchemy applies pending committed SQL
before uploading the dependent Worker.

Never edit a migration after it may have reached any stage. Alchemy's D1
ledger identifies applied migrations by file name, not by a stored content
hash. Git review and the forward-only policy are therefore the integrity
boundary for already-applied files.

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

6. Read back the Worker name/URL/version, D1 identity/schema/ledger, binding
   types, compatibility date, logs, traces, and rate-limit behavior.
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

1. Determine the stable production Worker hostname from staging-equivalent
   Alchemy output.
2. Create the self-hosted Access application and exact reviewed allow policy.
3. Read back the hostname/path scope, audience, policy order, identity
   providers, session duration, and unauthenticated denial.
4. Put that exact team domain and audience into the production deployment
   environment.
5. Verify both an allowed identity and a denied/absent identity at the edge.

Do not add an application authentication bypass, service-token profile
ownership, or a local development identity shortcut.

## Production apply

Repeat the staging process with `--stage prod` from the exact approved
revision. Freeze concurrent changes, explicitly accept the D1/Worker
partial-failure boundary, and inspect a second plan after deployment.

Pinned Alchemy `2.0.0-beta.64` currently enables version-preview URLs whenever
the stable `workers.dev` URL is enabled. Its `subdomain.previewsEnabled` input
is not honored by the provider, so the repository does not claim previews are
disabled. Verify this live and reassess the provider on upgrade.

After deployment verify:

- Worker URL, source version, compatibility date, binding types, and secrets
  present without reading their values;
- D1 name, jurisdiction, replication mode, schema, migration ledger, and
  recovery availability;
- actual allow/block behavior for every rate-limit class;
- Access allow and deny behavior with the exact audience;
- `/health`, JSON:API content negotiation, `/openapi.json`, and `/api-docs`;
- create/read/update/delete for one synthetic profile; and
- absence of bodies, profile values, raw subjects, tokens, SQL, and bound
  values in application-owned logs and traces.

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
