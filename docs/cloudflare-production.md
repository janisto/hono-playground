# Cloudflare production state and operations

This file is the non-secret manifest and manual runbook for Cloudflare state that is not fully
versioned with the Worker. It is deliberately honest about the current state: **Phase 7 is local
only; no Worker, D1 database, Access application, route, WAF rule, saved query, notification, or
production secret has been provisioned or verified.**

Update this file from live readback during Phase 8. Never add account recovery data, policy-member
email addresses, tokens, cookies, JWTs, secret values, private incident contacts, or actor email/IP
fields from audit records.

## Ownership and change safety

- Owner role: the designated release owner with least-privilege Cloudflare access and account 2FA.
- Private contact: stored in the team's private incident/contact system, not this repository.
- Last repository-only verification: 2026-07-22.
- Last live verification: not performed; deployment state is not provisioned.
- Change rule: read current state first, name the account/resource/change window, and stop concurrent
  deployment or migration work. Remote writes and destructive recovery require explicit release-owner
  approval.
- Separation rule: Worker deployment never applies D1 migrations. CI has no Cloudflare credentials and
  runs only QA plus `wrangler deploy --dry-run`.

What breaks if this manifest is wrong? An operator can deploy to the wrong account, route around Access,
apply a migration to the wrong D1 database, or roll back code while leaving the actual incident active
in D1, Access, DNS/TLS, WAF, rate limiting, notifications, or billing state. Treat live readback as
authoritative.

## External-state manifest

Replace `Not provisioned` only with values copied from authenticated live readback. Dates use ISO 8601.

| Resource/state | Intended value | Live identifier/readback | Owner | Last verified |
| --- | --- | --- | --- | --- |
| Cloudflare account and plans | Workers Free, D1 Free, current Access entitlement for the first synthetic playground | Not provisioned | Release owner | Not verified |
| Worker | `hono-playground`; `workers-dev-demo`; `workers_dev: true`; previews disabled | Not provisioned | Release owner | Not verified |
| Active Worker version | Exact tested revision, version ID, deployment ID, bundle/startup size, and compatibility date `2026-07-22` | Not provisioned | Release owner | Not verified |
| Production URL/route | Assigned `workers.dev` URL initially; no custom route | Not provisioned | Release owner | Not verified |
| D1 | `hono-playground`, EU jurisdiction, binding `DB`, read replication disabled, migrations from `./migrations` | Not provisioned | Release owner | Not verified |
| D1 recovery | Active plan's Time Travel window and pre-change bookmark recorded before every risky migration | Not provisioned | Release owner | Not verified |
| Access application | Whole assigned `workers.dev` Worker initially; Cloudflare IdP restricted to account members; one exact-owner Allow policy; eight-hour session | Not provisioned | Release owner | Not verified |
| Access verifier | Exact team domain, application ID, audience, and Managed OAuth state; member identity stays private | Not provisioned | Release owner | Not verified |
| Rate-limit namespaces | Three reviewed positive-integer namespace IDs, unique in the account, for public 300/minute, profile read 120/minute, profile write 30/minute | `1001`/`1002`/`1003` are reserved local-only Phase 7 values | Release owner | Not verified |
| Worker secrets | Separate Access/audit/rate-limit material; only secret names and rotation date may be recorded | Not provisioned | Release owner | Not verified |
| Workers observability | Persisted logs, invocation logs, traces, and independent log/trace sampling all enabled; source maps uploaded | Config only; live state not verified | Release owner | Not verified |
| Query Builder | Five saved investigations listed below, including owner and dashboard query identifiers | Not provisioned | Release owner | Not verified |
| Audit Logs v2 | Release-window review with action IDs only | Not reviewed | Release owner | Not verified |
| D1 Audit Logs | Read back supported D1 control-plane actions; do not claim row-level coverage | Not reviewed | Release owner | Not verified |
| Access authentication logs | Availability, fields, and retention read back from the active plan | Not reviewed | Release owner | Not verified |
| WAF/Security Events | Not applicable to the domainless profile; conditional after custom-domain promotion | Not provisioned | Release owner | Not verified |
| Notifications/budget | Available plan notifications, thresholds, recipients, and test date; recipients remain private | Not provisioned | Release owner | Not verified |

The committed namespace IDs exist only to exercise the binding locally. Cloudflare does not provision a
separate namespace resource: before the first deployment, choose three reviewed positive-integer values
that are unique in the account, update `wrangler.jsonc` and its reviewed literal gate together, run
`pnpm types`, and verify the deployed bindings and allow/block behavior. Do not deploy the reserved local
IDs as if they were reviewed production configuration.

## Versioned configuration and privacy boundaries

`wrangler.jsonc` is the reviewed source for the Worker-versioned portion of the deployment. The config
gate validates the pinned Wrangler schema and exact security-sensitive literals: no `nodejs_compat`, no
preview URL or invented route, asset-first routing without HTML rewriting/fallback, no public `.html`
asset, persisted logs/traces with independent sampling, invocation logs, source maps, version metadata,
three limiter bindings, disabled Wrangler telemetry, enabled dependency instrumentation, and local-only
D1 access.

After every reviewed `wrangler.jsonc` binding, variable, environment, or route change, run `pnpm types`
and inspect `worker-configuration.d.ts` before `pnpm qa`. The generated binding types include validated
configuration literals, so a stale file is a real failed gate rather than a diff to ignore.

The explicit choices have privacy and cost consequences:

- `send_metrics: false` opts project-local Wrangler telemetry out.
- dependency instrumentation uploads dependency names, declared ranges, and installed versions to
  Cloudflare with the Worker. Re-review this disclosure if the repository becomes private/sensitive.
- source maps expose mapped source to Cloudflare's error tooling; they are not public Static Assets.
- invocation logs are platform-managed and may include URLs/metadata the application cannot redact.
  Credentials and personal data must never be placed in URLs or query strings.
- application logs and custom spans use fixed names and allowlisted low-cardinality fields. They never
  contain bodies, profile fields, subject IDs, cookies, authorization material, raw paths, SQL/bind
  values, arbitrary headers, or exception text.
- full log and trace head sampling is only for the initial low-volume, rate-limited synthetic playground.
  One request can create multiple trace events. Measure events/spans per route and active retention and
  pricing; reduce trace sampling first, then log sampling, before meaningful traffic.
- logs, traces, Query Builder, Access logs, and audit logs have different plan-dependent scopes and
  retention. None is a durable application audit ledger or a completeness/compliance guarantee.
- EU D1 jurisdiction covers the database, not all Worker execution, Access, or telemetry. Do not describe
  the deployment as full EU processing/residency without a separate product/legal review.

Only synthetic profiles are allowed until every boundary has live negative and privacy smoke coverage.

## Local and CI gates

Run from the repository root with the pinned lockfile toolchain:

```sh
pnpm install --frozen-lockfile
node --version
pnpm --version
pnpm exec wrangler --version
pnpm config:check
pnpm licenses:check
pnpm qa
```

`pnpm qa` includes generated docs/OpenAPI freshness, formatting/linting, strict type checks, workerd/D1
tests and coverage, Wrangler binding/config checks, and a deployment dry run. Browser and deployed
log/trace/audit checks remain separate release gates because local workerd cannot prove Cloudflare's
stored telemetry or identity edge.

The license command inventories production dependencies using pnpm and rejects missing, unknown, or
non-allowlisted metadata for direct and transitive production packages. It is intentionally not legal
advice or a source-code/dev-dependency license audit. Review the full lockfile inventory, notices, and
every high-impact dependency update; neither Dependabot nor `pnpm audit` proves safety.

`pnpm audit:prod` is currently clean and runs in QA. As of 2026-07-22, `pnpm audit:all` still reports
the `sharp` 0.34.5/libvips advisory inherited only through the exact Wrangler/Miniflare development
toolchain. It is absent from the Worker runtime graph and bundle. Do not force the native `sharp` 0.35
line underneath Miniflare; update the pinned Cloudflare toolchain when it adopts the patched dependency,
then remove this exception. A patched `js-yaml` 4.3.0 override covers the OpenAPI generator's exact
transitive 4.2.0 pin and is exercised by generated-client checks.

## Authenticated readback commands

These commands are read-only but target remote Cloudflare state. Confirm the active Wrangler identity,
account, and Worker name before running them. Keep JSON output containing account metadata out of the
repository unless a specific non-secret identifier belongs in the manifest.

```sh
pnpm exec wrangler whoami
pnpm exec wrangler deployments status --name hono-playground --json
pnpm exec wrangler deployments list --name hono-playground --json
pnpm exec wrangler versions list --name hono-playground --json
pnpm exec wrangler d1 info hono-playground --json
pnpm db:migrations:list:remote
pnpm exec wrangler d1 insights hono-playground --time-period 1d --sort-type sum --sort-by count --limit 20 --json
pnpm exec wrangler secret list --name hono-playground
```

Also read back in the dashboard/API:

- Worker URL/routes, previews, compatibility date, bindings, dependency metadata, source maps, and active
  version/deployment IDs;
- nested log/trace enablement, persistence, independent sampling, event volume, active plan/retention,
  and Workers metrics/outcomes;
- D1 identifier, jurisdiction, replication state, storage/quota/Time Travel window, migrations, metrics,
  and Query Insights;
- Access application hostname/path, audience, policies, login method, session duration, Managed OAuth,
  authentication log availability, and the absence of a preview-url Access path;
- Audit Logs v2 action IDs around each release and D1 Audit Log entries for the supported control-plane
  operations; and
- custom-domain DNS/TLS/redirect/cache/transform/managed-WAF state and Security Events only after that
  topology exists.

Audit Logs v2 is control-plane history, not API/profile access history. D1 Audit Logs do not establish
row access or mutation history; confirm the active product coverage instead of assuming migrations and
normal SQL appear there. Record release action IDs only, never copied actor identity or IP fields.

## Reproducible investigations

Create these Query Builder investigations from the structured event fields and record each saved query's
dashboard identifier, owner role, and verification date in the manifest:

| Saved name | Definition and evidence goal |
| --- | --- |
| `worker-request-correlation` | Exact `request_id` or `cf_ray`; correlate the single application access record, invocation outcome, and trace without searching bodies/URLs. |
| `worker-5xx-by-version` | `http.access` status 500-599 and platform failure outcomes, grouped by Worker version and stable outcome/error class. |
| `worker-slow-routes` | High wall/CPU duration grouped only by fixed route template and operation ID; inspect version and D1 metadata. |
| `worker-rate-limit` | Status 429 grouped by fixed public/profile-read/profile-write class and version; no actor/rate-limit key. |
| `profile-d1-cost` | Profile operations grouped by fixed operation ID with D1 duration and rows read/written; no subject, SQL, or bound values. |

Use Real-time logs for a bounded current investigation only:

```sh
pnpm tail
```

It can sample/drop events and is not persistence. Run four separate experimental D1 Query Insights views
for top count, average latency, reads, and writes:

```sh
pnpm exec wrangler d1 insights hono-playground --time-period 1d --sort-type sum --sort-by count --limit 20 --json
pnpm exec wrangler d1 insights hono-playground --time-period 1d --sort-type avg --sort-by time --limit 20 --json
pnpm exec wrangler d1 insights hono-playground --time-period 1d --sort-type sum --sort-by reads --limit 20 --json
pnpm exec wrangler d1 insights hono-playground --time-period 1d --sort-type sum --sort-by writes --limit 20 --json
```

Query Insights exposes SQL shapes but not bound parameter values. Verify all shapes remain fixed/prepared
and contain no synthetic privacy marker; never interpolate user values into SQL. Treat the command as
experimental and re-check its pinned Wrangler help after upgrades.

For a release smoke, send only synthetic markers and prove they are absent from every application-owned
log field/custom-span attribute. A platform invocation log may still contain a request URL, which is why
the marker must never be a real secret or personal value. Verify handler, Access JWKS, D1, and fixed-name
custom spans (`access.verify`, `profile.service`, `profile.repository`, `response.validate`) in the trace
UI without depending on Cloudflare-internal span IDs or names.

## Manual provisioning and release checklist

This section prepares Phase 8; running it is not part of local Phase 7. Every mutation needs an explicit
release-owner decision and live target readback.

1. Name the account, owner, change window, active Workers/D1/Access plans, least-privilege deploy token,
   account 2FA, and synthetic smoke identity. Freeze concurrent deployment/migration work.
2. Run the full local/CI gates from the exact revision. Record Node, pnpm, Wrangler, revision, compatibility
   date, dry-run bundle/startup size, and test result.
3. Create D1 once with EU jurisdiction, copy its real ID into config, set `ENVIRONMENT=production`, and
   read back jurisdiction, replication, plan/quota, storage, and Time Travel window. Never fabricate an
   ID. The mode-aware config gate accepts a real database ID only with the production environment.
4. Choose three reviewed positive-integer limiter namespace IDs that are unique in the account, and
   provision separate audit/rate-limit secrets. Replace the reserved local IDs, run `pnpm types`, inspect
   the generated binding diff, run the config gate again, and verify every deployed binding and its
   allow/block behavior.
5. Test migrations locally. Immediately before a remote migration, confirm target/account/database,
   list remote migrations, and obtain a Time Travel bookmark. Apply a remote migration only as a separate
   approved step; never hide it in deploy/build/CI.
6. Run QA and the dry run again. The first bootstrap upload exists only to establish/read back the
   assigned `workers.dev` origin before its Access application has an audience. With empty/synthetic D1,
   explicit release-owner approval, and profile verification expected to fail closed, run the pinned
   `WRANGLER_WRITE_LOGS=false pnpm exec wrangler deploy --strict` command. Record the bootstrap
   version/deployment ID before changing identity state. Do not call this the production-ready version.
7. Immediately configure/read back whole-Worker Access on the assigned `workers.dev` route, exact audience,
   Cloudflare login/account membership restrictions, one exact-owner policy, eight-hour session, and
   Managed OAuth. Identity membership remains private. Until this is correct, profile verification fails
   closed and only synthetic/empty D1 data is permitted.
8. Replace `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` with that live readback and set
   `MANAGED_OAUTH_ENABLED` to the verified capability. Run `pnpm types`, inspect the generated binding
   diff, run `pnpm production:check`, then
   `pnpm deploy:production`; the latter reruns full QA, the production preflight, and strict Wrangler
   conflict detection before uploading. Read back the final version, variables/bindings, source maps,
   previews, and Access audience. Never leave the bootstrap placeholder configuration active.
9. Prove unauthenticated Access denial on every route, authenticated public/docs behavior, browser-cookie
   and Managed OAuth user profile CRUD, cleanup, no preview URL, real limiter behavior, and deployed docs
   CSP/same-origin behavior. Do not save cookies/tokens/Playwright storage state.
10. Inspect metrics, logs, queries, automatic/custom traces, D1 insights, Access logs, D1/Audit Logs v2, and
   privacy markers. Record only non-secret IDs, results, limits, sampling, retention, and dates here.

Production deploy, remote migration, Access changes, and D1 restore are intentionally absent from CI and
the default `Justfile` flow.

## Rollback and recovery

A Worker rollback restores a retained Worker code/assets/configuration version by creating a new active
deployment. It does **not** restore D1 schema/data or reverse Access, rate-limit/WAF, DNS/TLS,
notification, or billing changes.

Before rollback, identify the last known-good version and prove it remains compatible with the current D1
schema and bound resources. With release-owner approval, run interactively (do not add `--yes`):

```sh
pnpm exec wrangler rollback <verified-version-id> --name hono-playground --message "incident rollback"
pnpm exec wrangler deployments status --name hono-playground --json
```

Then re-run health/public/Access/profile/static-asset negative and positive smoke, inspect the active
version and telemetry, and update the manifest/change record. Keep migrations immutable, forward-only,
and additive/backward-compatible across at least the previous and new Worker. Fix a failed migration with
a new migration; never edit one already applied remotely.

D1 Time Travel is whole-database destructive recovery, not row undo and not an automatic rollback step.
Its window is plan/state dependent and offers no promised row-level RPO/RTO. First freeze mutations,
verify the exact database, incident time, authority, and current recovery window, then obtain and record
both the intended restore bookmark and a current undo bookmark:

```sh
pnpm exec wrangler d1 time-travel info hono-playground --timestamp <verified-rfc3339-time> --json
```

Only after explicit destructive approval may the owner run the interactive restore:

```sh
pnpm exec wrangler d1 time-travel restore hono-playground --bookmark <verified-bookmark> --json
```

Afterward, read D1 metadata/migrations, verify synthetic profile invariants and Worker compatibility,
inspect D1 Audit Logs/Audit Logs v2, and record the restore and undo bookmarks privately where needed.

## Incident runbooks

For every incident, capture timestamps, `CF-Ray`, request ID, active version/deployment ID, stable error
codes, plan/quota state, and relevant dashboard/action IDs. Never copy credentials, profile data, raw
URLs, actor identities/IPs, SQL values, or private contacts into this repository.

| Incident | Evidence | Safe containment/recovery | Authority and verification |
| --- | --- | --- | --- |
| Elevated `5xx`, CPU/runtime limit | Metrics/outcomes by version, invocation log, source-mapped error, fixed route/operation, CPU/wall time, trace and D1 metadata; check Cloudflare status | Stop rollout/traffic changes; preserve fail-closed profile behavior; rollback only to a schema-compatible retained version; tune CPU only after measured Paid-plan promotion | Release owner; verify active version plus public/profile/docs smoke and normalized errors |
| Access/JWKS outage | Access auth logs, verifier safe codes, JWKS fetch trace/status, team domain/audience readback, Cloudflare status | Do not bypass Access or JWT verification; keep profile fail closed; communicate synthetic playground unavailability and retry only transient JWKS failures | Access/release owner; verify unauthenticated denial and both authorized browser/Managed OAuth user flows |
| Access policy lockout | Application hostname/path, policy order/includes/requires, login method, account membership, audience/session and audit action IDs | Use a separately authenticated authorized account administrator; correct the narrow policy, never add `Everyone`, permanent bypass, or Service Auth ownership | Account/Access admin; two-person readback and negative/positive route matrix |
| D1 outage/quota exhaustion | D1 status, quota/billing/storage, metrics, rows/duration, Query Insights, Worker binding errors | Stop mutations/load smoke, preserve fail-closed profile limiter, keep public routes if safe; upgrade plan only with owner approval | Release owner/account billing owner; verify migrations and synthetic CRUD/cleanup |
| Bad Worker deploy | Deployment/version IDs, revision, config/bindings diff, logs/traces, dry-run artifact | Roll back code only when current D1/bindings remain compatible; separately reverse external-state changes if implicated | Release owner; deployment readback and full edge/application smoke |
| Failed migration/schema mismatch | Exact target ID/name, migration lists, error/action ID, pre-change bookmark, schema expectations | Stop deploy/migrations, never edit an applied file, add a forward repair migration; restore only for confirmed destructive loss | Database/release owner; list migrations and run real D1 contract plus synthetic lifecycle |
| Destructive D1 restore | Incident time, verified target/restore/undo bookmarks, current Time Travel window, current version/schema | Freeze writes; use the approval and whole-database procedure above; never treat it as single-profile undo | Explicit database owner approval; readback, migration/schema and synthetic data verification |
| Leaked deploy token, Access session, audit/rate-limit secret | Secret name/usage, audit actions, token/session scope and timestamps without copying values | Revoke/rotate at the source, invalidate sessions where supported, replace affected Worker secrets and redeploy; review unexpected control-plane changes | Account security plus release owner; old credential rejected, new version/bindings and audit review |
| Limiter/WAF false positive or abuse | 429s by fixed limiter class, shared-NAT sample, configured namespace IDs and deployed binding behavior; WAF Security Events only on custom domain | Adjust the narrow threshold/scope or disable only the faulty optional WAF rule; never accept caller `X-Forwarded-For` or remove profile fail-closed behavior | Release/security owner; valid and bounded blocked corpus plus route/host scope readback |
| Cost/event-volume spike | Workers/D1 usage, rows, CPU/wall time, log/trace events per route, version and traffic class | Stop abusive smoke, keep rate limits, reduce trace sampling before logs, investigate fixed D1 shapes, set/review plan notifications; upgrades require billing owner | Release plus billing owner; usage trend, sampling/config and representative route smoke |
| Orphaned Access subject | Authorized user reports no profile after identity change; compare only safe pseudonymous operational evidence | Never authorize/reassign by email; preserve old row; require owner-approved, narrowly targeted cleanup/recovery design | Privacy/data owner; new identity owns only its own row and old data remains inaccessible |
| Profile privacy incident | Access/audit history, safe request/version IDs, telemetry marker review, affected data scope outside public repo | Stop profile mutations/traffic as needed, revoke credentials, preserve evidence, follow private notification/legal process; do not dump rows/logs here | Privacy/security owner; negative authorization tests, telemetry redaction, synthetic CRUD cleanup |

This playground has no formal availability SLO or on-call promise. For the initial domainless Free profile,
native dashboards and manual smoke do not provide independent continuous uptime probing. Revisit Workers
Paid, active alerting, a custom domain, and plan-appropriate health checks before real traffic or
availability expectations.
