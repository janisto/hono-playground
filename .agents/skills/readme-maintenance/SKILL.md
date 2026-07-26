---
name: readme-maintenance
description: Audit or update hono-playground README.md when routes, JSON:API contracts, configuration, setup, development commands, architecture, Cloudflare bindings, D1 persistence, observability, deployment, CI, or supported versions change; keep human documentation separate from agent rules.
---

# README maintenance

Read `AGENTS.md`, then verify every affected `README.md` claim against the current repository. Write `README.md` for human users and contributors. Put agent execution rules, detailed implementation constraints, and reusable workflows in `AGENTS.md` or `.agents/skills/`.

## Sources of truth

- application and routes: `src/app.ts`, `src/index.ts`, `src/api/routes.ts`, and route-resolution tests;
- schemas and errors: `src/models/`, `src/core/errors.ts`, `src/core/http-policy.ts`, and contract tests;
- configuration: `src/core/config.ts`, `infra/`, `alchemy.run.ts`, and `.env.example`;
- commands: `Justfile` and `package.json`;
- dependencies and versions: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `tsconfig*.json`;
- persistence and deployment: `src/db/schema.ts`, `drizzle/`, `drizzle.config.ts`, `alchemy.run.ts`, and `docs/cloudflare-production.md`;
- automation and contribution entry points: `.github/ISSUE_TEMPLATE/`,
  `.github/workflows/`, `.github/dependabot.yml`, and
  `.github/labeler.yml`.

## Accuracy

- Require every named path, route, command, default, environment variable, and version to exist.
- Describe implemented behavior, not aspirational production readiness.
- Keep the project layout concise and mention `.agents/skills/` as portable agent workflows.
- Keep setup, API usage, architecture, configuration, operations, and contribution entry points in the README.
- Remove coding-agent directives, exhaustive style rules, and duplicated test policy from the README; link to `AGENTS.md` instead.
- Remove stale material instead of preserving an obsolete structure.
- Do not claim Cloudflare deployment, Access protection, rate limiting, tracing, migration application, or CI checks that are not implemented and verified.

## Verification

Dry-run named recipes where practical, search route registration and settings directly, validate links and paths, and run `git diff --check`. For documentation accompanying behavior changes, run the narrowest relevant test followed by `just check`, `just typecheck`, and `just test`. Run `just e2e` when Swagger UI, OpenAPI rendering, CSP, or browser behavior changes. Reread the full README for contradictions and duplicated agent guidance.
