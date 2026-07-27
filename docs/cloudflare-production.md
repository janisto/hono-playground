# Cloudflare deployment runbook

This runbook defines the recommended Cloudflare configuration and repeatable
deployment, verification, and recovery procedures for this service. Verify the
target stage in the live control plane before and after every change.

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

## Recommended settings

These recommendations are specific to an API served entirely by a Worker
Custom Domain. The Worker returns `Cache-Control: no-store`, exposes no local
image assets or password login, and uses Cloudflare Access for profile
identity.

- **Infrastructure ownership:** Use Alchemy for the Worker, D1 database,
  committed migration application, rate-limit bindings, runtime
  variables/secrets, compatibility settings, and observability. Manage Access
  policies, DNS, zone security, notifications, and recovery in Cloudflare.
- **Stages and retention:** Accept only `prod`, `staging`, and personal
  `dev_<name>` stages. Use retain removal policy for persistent D1 databases
  and do not provide a general destroy command.
- **Ingress:** Use an Alchemy-managed custom hostname inside
  `hono-playground.dev`. Disable the stable `workers.dev` URL and version
  previews. Protect profile routes with an Access application for the exact
  hostname and the `v1/profiles` path, plus a reviewed allow policy. Keep the
  path populated so public health, item, OpenAPI, and documentation routes do
  not inherit Access authentication.
- **Runtime:** Use the compatibility date in `infra/config.ts`. Select the
  newest date supported by every pinned local and hosted execution path; do not
  infer support from the hosted edge alone.
- **D1 and migrations:** Use an EU-jurisdiction D1 database with replication
  disabled unless a measured need justifies it. Apply only committed
  Drizzle-generated migrations through Alchemy and retain the
  `drizzle_migrations` ledger.
- **Application rate limits:** Keep separate bindings for public traffic,
  profile reads, and profile writes. Treat counters as approximate and
  location-local, and require `Retry-After` on `429` responses.
- **Secrets:** Use distinct HMAC keys for rate-limit partitioning and audit
  pseudonyms. Store secret values only in the ignored `.env.dev`,
  `.env.staging`, and `.env.prod` files and deploy them as encrypted Worker
  bindings.
- **Access:** Derive profile ownership only from a verified Access `sub`.
  Require `type=app`, the exact issuer and audience, RS256, valid time claims,
  and a bounded subject. Do not use email addresses or service-token identities
  as profile owners.
- **Observability:** Keep invocation logs and traces enabled. Use 1% head
  sampling in production and full sampling in non-production. Application
  events must use route templates, fixed fields, request IDs, and keyed owner
  pseudonyms; never log bodies, raw subjects, credentials, or bound SQL values.
- **Caching:** Keep Worker Cache and zone cache rules disabled for application
  responses, and preserve `Cache-Control: no-store`.
- **DNS:** Enable DNSSEC and verify the zone DNSKEY, parent DS, and validation
  through an independent recursive resolver. Do not treat zone signing alone
  as completed DNSSEC.
- **Email spoofing:** While the domain does not send email, publish the
  restrictive records Cloudflare recommends: apex SPF `v=spf1 -all`, wildcard
  DKIM `v=DKIM1; p=`, and DMARC
  `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s;`. Before introducing email
  sending or routing, replace them with the provider's authenticated MX, SPF,
  DKIM, and DMARC configuration and verify that only one SPF record exists.
- **TLS and protocols:** Enable Always Use HTTPS, set the minimum TLS version to
  1.2, and enable TLS 1.3, HTTP/2, and HTTP/3. Use Automatic SSL/TLS mode while
  the Worker Custom Domain is the origin; require Full (strict) if an external
  origin is introduced.
- **HSTS:** Keep the application's short
  `Strict-Transport-Security: max-age=300` policy. Enable a long-lived
  zone-level policy, `includeSubDomains`, or preload only after every intended
  hostname is permanently HTTPS-only and the rollback consequence is accepted.
- **0-RTT:** Enable it only while `GET`, `HEAD`, and `OPTIONS` remain
  side-effect free. Cloudflare limits early data to those methods; mutations
  must continue to use `POST`, `PATCH`, and `DELETE`.
- **Smart Shield:** The Free base package may remain enabled, but do not expect
  material benefit while the Worker is the origin and responses are
  non-cacheable. Do not purchase Argo or advanced origin features without
  measured latency or origin-load evidence.
- **Speed Brain:** Disable it for this service. Cloudflare does not prefetch
  routes that invoke Workers or responses that are ineligible for cache, while
  enabling it still adds `Speculation-Rules` to the API's JSON responses.
- **Early Hints:** Disable it until a public HTML response intentionally emits
  stable `Link` headers for preload or preconnect. This API emits no such
  headers, and Cloudflare may send cached hints before Access or the Worker
  evaluates a request.
- **Hotlink Protection:** Disable it while this service hosts no supported
  image assets. If image hosting is added, enable it only after deciding
  whether search engines, social sites, feeds, or external documentation may
  embed those images.
- **Managed security:** Enable the Cloudflare Managed Free Ruleset and Browser
  Integrity Check. Keep Bot Fight Mode disabled because the Free-plan control
  challenges all traffic across the domain and cannot be scoped for API
  clients.
- **Leaked credentials:** Keep the Free-plan default detection enabled, but do
  not consume the zone's rate-limit rule with leaked-credential mitigation
  while authentication is delegated to Access and the application accepts no
  username/password login. Add a narrowly scoped mitigation only if a password
  authentication endpoint is introduced.
- **Precursor:** Enable Precursor in Minimize Friction mode for this API
  hostname. Do not use Maximize Security on API paths used by `curl`,
  server-to-server, or other non-browser clients that cannot establish a
  `cf_clearance` session.
- **JavaScript Detections:** Keep JavaScript Detections disabled whenever
  Precursor is enabled. On the Free plan, JavaScript Detections is coupled to
  Bot Fight Mode and cannot be disabled independently, so keep Bot Fight Mode
  disabled instead of enabling both features.
- **Notifications:** Prefer Certificate Transparency Monitoring as the only
  zone security notification when account members will triage certificate
  issuance. Do not add the standard Free-plan HTTP DDoS alert, which reports
  attacks Cloudflare has already mitigated and requires no operator action.
  Add a budget alert only after moving to Pay-as-you-go; it informs but does not
  cap spend.

## Required input

Copy `.env.example` separately to the ignored `.env.dev`, `.env.staging`, and
`.env.prod` files and supply:

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

- choose three distinct positive-integer strings per environment that do not
  collide with another stage or binding namespace in the target account (these
  bindings are not visible in the Cloudflare dashboard);
- select the lowercase custom hostname for this stage within the owned
  `hono-playground.dev` zone;
- copy the team domain and audience from the exact Access application;
- generate the two lowercase 64-hex HMAC values independently;
- keep Cloudflare credentials and every secret outside Git; and
- configure the matching `dev`, `staging`, or `prod` Alchemy profile; and
- confirm the selected account, environment file, profile, and explicit stage.

The Justfile is the deployment selector. It pairs `dev` with `.env.dev`,
profile `dev`, and the personal `dev_$USER` stage. For persistent environments,
`just plan <environment>`, `just deploy <environment>`,
`just logs <environment>`, and `just tail <environment>` pass the matching
`.env.<environment>` file, profile, and stage. `plan` and `deploy` accept only
`staging` or `prod` and have no default; a missing argument or environment file
fails before Alchemy starts.

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

## Staging apply

1. Confirm the Cloudflare account, exact source revision, stage `staging`, and
   absence of another apply for the same stack.
2. Run:

   ```sh
   pnpm qa
   pnpm audit
   pnpm test:e2e
   just plan staging
   ```

3. Review every proposed resource, binding, secret change, and migration. The
   first Alchemy command may bootstrap its state store; `plan` is not
   guaranteed to be zero-write on an uninitialized account.
4. Apply:

   ```sh
   just deploy staging
   ```

5. Plan again and explain any residual change:

   ```sh
   just plan staging
   ```

6. Complete the deployment verification checklist below.

Do not use `pnpm dev` as deployment proof. In the pinned Alchemy beta it runs
the Worker locally but connects D1 and several bindings to real
stage-isolated Cloudflare resources.

## Deployment verification

After every staging or production deployment:

- run a second Alchemy plan and explain any residual change;
- read back the Worker source version, custom hostname, compatibility date,
  binding types, secret names without values, and disabled `workers.dev` and
  preview URLs;
- inspect the D1 identity, jurisdiction, replication mode, schema, migration
  ledger, Query Insights, and recovery availability;
- verify the documented media type and contract for `/health`,
  `/v1/items`, `/openapi.json`, and `/api-docs`, and confirm `/.env`,
  `/.env.dev`, `/.env.staging`, `/.env.prod`, and `/.git/HEAD` return safe RFC
  9457 `404` documents;
- load `/api-docs` in a real browser and require the pinned assets and OpenAPI
  document to load without failed requests, console errors, or page errors;
- verify Access denial without an allowed identity and application access with
  an allowed `type=app` identity for the exact audience;
- create, read, update, and delete one synthetic profile, then require a
  post-delete `404`;
- exercise every rate-limit class with a bounded canary, checking normal
  responses, `429`, `Retry-After`, and the absence of unintended D1 mutation.
  Do not claim an exact global threshold because Cloudflare's counters are
  approximate and location-local;
- complete the telemetry privacy validation below with the same synthetic
  values; and
- inspect Access and account audit logs, notification and budget settings,
  TLS and cache state, and representative Worker CPU and D1 read/write
  measurements.

Keep task-specific dates, revisions, request counts, and control-plane
snapshots in an ignored `plans/` file when needed; do not publish them in this
runbook.

## Telemetry privacy validation

Cloudflare [invocation events][workers-logs] and traces can retain full request
URLs. [Automatic D1 spans][worker-spans] and
[Query Insights][d1-metrics] can retain parameterized SQL statement text;
Query Insights omits bound parameter values. These platform-managed fields are
outside the application's structured-event schema.

Use unique synthetic markers for every sensitive profile field and identity
test value, then inspect all of these surfaces:

- application `http.access`, `profile.audit`, and `operator.error` events;
- enriched Cloudflare invocation events and trace spans, not only Alchemy's
  compact output;
- D1 spans and Query Insights; and
- Access authentication and account audit logs.

Require the profile fields, raw Access subject, Access assertion, authorization
and cookie values, request and response bodies, sensitive query values, and SQL
bound values to be absent. Full route URLs, including any query string sent,
and parameterized SQL text are expected platform telemetry, so sensitive values
must never enter URL paths or query strings and SQL values must always use
placeholders.

Application events use fixed fields. `profile.audit` contains only the schema
version, event, level, action, result, request ID, and keyed owner pseudonym.
It never contains a raw subject or profile value. Delete the synthetic profile
after inspection and confirm its absence.

## Access

Profile routes fail closed in the Worker unless the Access assertion verifies
with RS256, the exact issuer and audience, required time claims, `type=app`,
and a bounded subject.

Set the Access application's optional Path field to `v1/profiles`; Cloudflare's
UI omits the leading slash. That scope protects both `/v1/profiles` and its
descendants unless a more-specific Access application overrides it. Do not
leave the field empty: an empty path protects every route on the hostname,
including `/health`, `/v1/items`, `/openapi.json`, and `/api-docs`.

The Worker Custom Domain already sends every path on the hostname to the same
Worker, so adding a Hono route does not require another DNS record, Worker
route, or custom domain. The Worker must independently apply Access assertion
verification and profile-specific rate limiting through the verified Hono
`/v1/profiles/*` middleware scope, which covers the collection root and its
descendants. Body validation remains route-specific. Before deploying a
protected route family outside the profile namespace, add a reviewed Access
destination or application and matching Worker authentication middleware.

Before production:

1. Select an owned custom hostname. Direct
   `workers.dev` and version-preview ingress remain disabled.
2. Create or verify the self-hosted Access application for the exact custom
   hostname and `v1/profiles` path, with an exact reviewed allow policy.
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
identity is active. Do not switch ownership to mutable or recyclable email
addresses.

### Operator profile erasure

Prefer self-service deletion before Access removal. If an identity is already
removed, use this audited operator procedure; do not add an administrative
HTTP API and do not use a Drizzle migration:

1. Open a restricted offboarding ticket that authorizes erasure and identifies
   the exact Cloudflare account, stage, and D1 database. Keep the raw Access
   subject in an approved secret channel, not the ticket, source control, chat,
   or shell history.
2. Use a least-privilege, short-lived Cloudflare API token with D1 Read and D1
   Write for only the target account. Keep the token in a separate ignored
   `.env.operator` file that the Justfile never loads; never print it.
3. Call the [D1 REST query endpoint][d1-query-api] with
   `SELECT count(*) AS matches FROM profiles WHERE id = ?` and pass the raw
   subject only in the request body's `params` array. Stop if the count is not
   exactly one.
4. Call the same endpoint with
   `DELETE FROM profiles WHERE id = ? RETURNING id`, again using `params`.
   Require one returned row and `meta.changes = 1`.
5. Repeat the bound count query and require zero. Read D1 Query Insights and
   confirm the statement is parameterized and no subject value is present.
6. Record the ticket ID, operator, UTC time, account, stage, database, pre/post
   counts, affected-row count, and the same 32-hex HMAC owner pseudonym used by
   `profile.audit`. Never record the raw subject, profile fields, token, SQL
   parameter value, or response row.
7. Revoke the short-lived API token and close the ticket only after the
   postcondition and audit evidence are independently reviewed.

A zero-row precondition means the profile is already absent or the identity is
wrong; do not turn it into a successful deletion claim. More than one row is a
schema/integrity incident even though `id` is the primary key.

Cloudflare documents seven days of D1 Time Travel retention on the Free plan.
Do not use Time Travel for routine erasure. Any restore to a point before an
erasure can resurrect the row; before reopening profile traffic after a
restore, re-run every erasure recorded after the restore point and verify the
postconditions. Rehearse the operator-token procedure in staging before
production use.

## Production apply

Repeat the staging process with `just plan prod` and `just deploy prod` from
the exact approved revision. Freeze concurrent changes, explicitly accept the
D1/Worker partial-failure boundary, and inspect a second plan after deployment.

Pinned Alchemy `2.0.0-beta.64` ties version-preview URLs to its `url` property
and ignores a separate `subdomain.previewsEnabled` input. This repository sets
`url: false`, which disables both direct surfaces in the pinned provider.
Verify both settings live and reassess this behavior on every Alchemy upgrade.

Complete the deployment verification checklist after the apply.

Application access logs intentionally do not estimate D1 scans or writes from
returned array lengths. Use Cloudflare's automatic D1 span attributes for
exact rows read, rows written, changes, SQL duration, and retry attempts.
Application logs do not copy caller-supplied `traceparent` identifiers.
The Worker does not set Cloudflare's gated trace propagation policy. Production
trace head sampling is `0.01`; staging and development retain full trace
sampling for validation. Public rate-limit keys combine the normalized actor
with the fixed route template, but Cloudflare's binding remains intentionally
approximate and location-local rather than a global exact counter.

Use Alchemy for application logs and live tailing:

```sh
just logs prod
just tail prod
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
After any restore, reapply and verify every profile erasure recorded after the
selected restore point before profile traffic resumes.

## References

- [Alchemy state store](https://alchemy.run/state-store/)
- [Alchemy profiles](https://alchemy.run/environments/profiles/)
- [Alchemy CLI](https://alchemy.run/cli/)
- [Alchemy secrets and environment bindings](https://alchemy.run/cloudflare/security/secrets-env/)
- [Alchemy D1](https://alchemy.run/cloudflare/data/d1/)
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Cloudflare Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Cloudflare Access application tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- [Cloudflare Access session management](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/)
- [Cloudflare Worker preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Cloudflare Access authentication logs](https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/access-authentication-logs/)
- [Cloudflare Audit Logs v2](https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/)
- [Cloudflare D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
- [Cloudflare Registrar DNSSEC](https://developers.cloudflare.com/registrar/get-started/enable-dnssec/)
- [Cloudflare Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
- [Cloudflare Minimum TLS Version](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/minimum-tls/)
- [Cloudflare Certificate Transparency Monitoring](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/certificate-transparency-monitoring/)
- [Cloudflare HSTS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/)
- [Cloudflare Managed Rules](https://developers.cloudflare.com/waf/managed-rules/)
- [Cloudflare Bot Fight Mode](https://developers.cloudflare.com/bots/plans/free/)
- [Hono middleware path matching](https://hono.dev/docs/guides/middleware)
- [Cloudflare DDoS alerts](https://developers.cloudflare.com/ddos-protection/reference/alerts/)
- [Cloudflare 0-RTT](https://developers.cloudflare.com/speed/optimization/protocol/0-rtt-connection-resumption/)
- [Cloudflare Smart Shield](https://developers.cloudflare.com/smart-shield/get-started/)
- [Cloudflare Speed Brain](https://developers.cloudflare.com/speed/optimization/content/speed-brain/)
- [Cloudflare Early Hints](https://developers.cloudflare.com/cache/advanced-configuration/early-hints/)
- [Cloudflare Hotlink Protection](https://developers.cloudflare.com/waf/tools/scrape-shield/hotlink-protection/)
- [Cloudflare leaked credentials detection](https://developers.cloudflare.com/waf/detections/leaked-credentials/)
- [Cloudflare Precursor](https://developers.cloudflare.com/cloudflare-challenges/precursor/)
- [Cloudflare JavaScript Detections](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/)
- [Cloudflare restrictive email records](https://www.cloudflare.com/learning/dns/dns-records/protect-domains-without-email/)
- [Cloudflare Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

[d1-metrics]: https://developers.cloudflare.com/d1/observability/metrics-analytics/
[d1-query-api]: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
[worker-spans]: https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/
[workers-logs]: https://developers.cloudflare.com/workers/observability/logs/workers-logs/
