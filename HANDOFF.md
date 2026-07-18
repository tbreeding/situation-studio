# Situation Studio handoff

Last updated: 2026-07-18

## Purpose and authority

Situation Studio is the private operations application for creating, reviewing, and publishing coherent Leadership Field Guide learning bundles. PostgreSQL owns workflow state and history; the Leadership Git repository owns exact published artifact bytes and deployable commit history.

The original implementation specification is `/Users/timothybreeding/projects/leadership/SPEC-situation-studio.md`. It remains an untracked file in the Leadership workspace and must not be staged there without explicit direction. This repository is the implementation and deployment authority.

## Repository state

- Local repository: `/Users/timothybreeding/projects/situation-studio`.
- Remote: `git@github.com:tbreeding/situation-studio.git`.
- Branch: `main`.
- Runtime repair commit: `083d1d1` (`Fix administration responsive layout`).
- The acceptance-report commit follows the runtime commit and records the deployed state.
- Leadership baseline commit: `9a870e5c70fef9ae71506cb3138745b88363a190`.
- No tracked published Leadership content was modified by the Studio build or deployments.

Before new work, run `git status --short`, read this file and `artifacts/reports/acceptance.json`, and preserve unrelated user changes.

## Live topology

- Public URL: `https://situation-studio.timsprototypes.com`.
- Outer gate: TimsPrototypes, registered and enabled.
- Private origin: `http://192.168.1.120:3015` on SSH host `rpi1-ts`.
- PM2 process: `situation-studio-web`.
- Release root: `/home/admin/projects/situation-studio/releases`.
- Active symlink: `/home/admin/projects/situation-studio/current`.
- Current recorded release: `20260718T131848Z`.
- Stable launcher: `/home/admin/projects/situation-studio/current/ops/start-web.sh`.
- Shared environment files: `/home/admin/projects/situation-studio/shared/web.env` and `migrator.env`, mode 0600.

Direct private-IP root requests intentionally return only `{"status":"origin-ready"}`. The TimsPrototypes origin probe depends on this non-redirecting response. Requests with the configured public Host receive the Studio application behavior.

## Database and identities

- PostgreSQL container: `postgres16`, PostgreSQL 16.
- Database: `situation_studio`.
- Owner/migration login: `situation_studio_migrator`.
- Web runtime login: `situation_studio_web`.
- Reserved non-login identities: `situation_studio_ai`, `situation_studio_validator`, `situation_studio_publisher`, and `situation_studio_backup`.
- Four committed migrations are applied.
- The immutable baseline contains 15 situations and 37 artifacts; import is idempotent.
- The first human administrator, username `tim`, is active. Never place its password in arguments, environment variables, Git, documentation, logs, or chat.

## Security boundaries

- The TimsPrototypes gate and Studio login are separate authentication layers.
- Studio uses secure host-only cookies, session-bound CSRF protection, exact public Host/Origin policy, Argon2id passwords, throttling, and append-only audit events.
- Provider execution is `disabled` in production. Fake adapters are acceptance-only.
- No production AI worker, validator, or publisher identity is enabled.
- No restricted Git deploy key or production publication authority is provisioned.
- Do not substitute the web process, a human administrator credential, or personal CLI credentials for missing service identities.
- Activation/reset links are single-use secrets. Do not copy them into documentation, logs, commits, or task summaries.
- RP1 PostgreSQL's broad pre-existing listener/firewall exposure still needs a coordinated host review before a wider beta.

## Completed work and evidence

- Next.js/TypeScript workspace, Prisma model, migrations, role-separated components, authentication/RBAC, legacy import, checkouts/drafts, review records, validation contracts, publication saga, and operational deployment tooling are implemented.
- The RP1 web release, database roles, migrations, explicit runtime grants, baseline import, PM2 recovery, public route, and first administrator are operational.
- The Administration layout was repaired after real production screenshots exposed misuse of the editor grid and missing intrinsic-width containment.
- Current verification: formatting, lint, strict TypeScript, Prisma validation, baseline verification, secret scan, production build, 23 contract/unit tests, and 8 Chromium browser tests pass.
- Browser coverage includes desktop and mobile Administration layout before and after invitation creation, including document containment and usable inner widths.
- Acceptance evidence lives in `artifacts/reports/acceptance.json`.

## Remaining work

The protected manual web application is live. The first usable AI/publication beta is not complete. Remaining high-priority work:

1. Provision approved OpenAI/Anthropic service/API credentials and qualify the real adapters, or leave provider execution disabled.
2. Provision separate worker, validator, publisher, and backup login identities only with their documented least privileges.
3. Create a restricted publisher Git deploy key and release capability; prove publication and rollback without personal credentials.
4. Configure encrypted nightly `pg_dump` backups, off-host copy, retention, checksum verification, and a clean restore rehearsal.
5. Coordinate PostgreSQL listener/firewall hardening without disrupting other RP1 applications.
6. Perform the external friend end-to-end acceptance exercise only after the provider, publisher, and recovery boundaries are ready.

## Safe operational commands

Full local gate:

```sh
cd /Users/timothybreeding/projects/situation-studio
pnpm verify
pnpm test:browser
```

Deploy the committed `main` state:

```sh
cd /Users/timothybreeding/projects/situation-studio
./deploy.sh
```

Health probes:

```sh
curl http://192.168.1.120:3015/
curl -H 'Host: situation-studio.timsprototypes.com' http://192.168.1.120:3015/health/live
curl -H 'Host: situation-studio.timsprototypes.com' http://192.168.1.120:3015/health/ready
```

Interactive administrator bootstrap or reset must run through an attached RP1 TTY after loading `shared/web.env`; see `docs/operations.md`. Never automate the password through command arguments or environment variables.

## Continuation checklist

1. Confirm the worktree and `origin/main` state before editing.
2. Confirm the active RP1 release and PM2 status before any live mutation.
3. Treat provider, publisher, backup, gateway, database-role, firewall, and content-publication changes as separate security boundaries.
4. Run verification proportional to the change, including production-build browser checks for UI changes.
5. Use immutable releases and preserve the last healthy symlink target for rollback.
6. Update this handoff, `README.md`, the relevant runbook, and `artifacts/reports/acceptance.json` whenever deployment state or a remaining boundary changes.
