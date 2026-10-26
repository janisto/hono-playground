# Worker compatibility-date maintenance

Scope: `infra/`. The root `AGENTS.md` also applies.
Repository paths are root-relative. Run commands from the repository root unless
another working directory is explicitly stated.

- `infra/config.ts` is the compatibility-date source of truth. Set it to the
  newest date supported by every pinned execution path, not automatically to
  today's date or the newest date accepted by Cloudflare's hosted edge. With
  the current lock, Alchemy `2.0.0-beta.65` resolves
  `@distilled.cloud/cloudflare-runtime@0.13.10` and its
  `workerd@1.20260704.1`; that local binary accepts compatibility dates only
  through `2026-07-11`, so the project date is `2026-07-11`.
- Before changing dependencies or the date, query the accepted live registry
  channels and current first-party release notes, then run
  `pnpm why --recursive workerd`. Inspect the exact Alchemy-to-runtime-to-
  workerd path and the separate Vitest/Miniflare path. A top-level `workerd`
  release, Workers Types date, or hosted-edge capability does not prove what
  `alchemy dev` can execute.
- Review Cloudflare's compatibility-flags history for every date between the
  current and proposed values. Identify affected APIs and add focused runtime
  tests before opting into changed behavior. Do not advance the date through
  dependency automation or as an unrelated cleanup.
- Upgrade the locked dependency set first, without overrides, package patches,
  or a custom provider for Alchemy's nested runtime. Select the newest date
  accepted by the oldest actual runtime in the resulting lock. If that
  intersection cannot be proved, retain the last verified date and report the
  upstream blocker.
- Validate the candidate with the secretless test gates and, only with explicit
  Cloudflare authority, a personal canary using the repository's canonical
  `just dev` command. Confirm its resolved selectors are `.env.dev`, profile
  `dev`, and an exact personal `dev_<name>` stage before launching. A successful
  provider summary is insufficient: wait for the local port, probe at least
  `/health` and `/openapi.json`, stop the watcher, and remove the personal stage
  if it was created only for verification. Do not publish the canary's date,
  revision, or live-state snapshot in the README, this file, or the deployment
  runbook.
