# RP1 resource, network, backup, and recovery plan

The five-minute RPO / 60-minute RTO plan required before database-authoritative
content cutover is documented in `database-publication-checkpoint-1.md`. The
legacy backup description below remains the current state, not the cutover
acceptance level.

Checkpoint 5's current production discovery, hard gates, recovery evidence
template, minute-by-minute shadow/cutover runbook, and abort card are in
`database-publication-checkpoint-5.md`. Discovery found `archive_mode=off` and
no visible off-host WAL chain, so no database-reader cutover is currently
authorized.

Checkpoint 2's complete 32-artifact package, shared validation boundary, and
disposable-database backfill evidence are documented in
`database-publication-checkpoint-2.md`. Rebuild the deterministic package with
`pnpm bootstrap:database-publication`. Verify it and its idempotent database
backfill with `DATABASE_URL=<dedicated situation_studio_migration_test_* db>
pnpm verify:database-publication`. These commands do not call Git or a Git
remote. The backfill command refuses a database outside that explicit test-name
pattern and never selects an official or candidate target.

## Live service record

- Public protected route: `https://situation-studio.timsprototypes.com`.
- RP1 origin: `192.168.1.120:3015`.
- Release root: `/home/admin/projects/situation-studio/releases`.
- Active symlink: `/home/admin/projects/situation-studio/current`.
- Shared environment: `/home/admin/projects/situation-studio/shared`.
- PM2 processes: `situation-studio-web`, `situation-studio-worker`, and `situation-studio-publisher`.
- Current recorded release: `20260719T094530Z` (implementation commit `312bf77`).

The route, first administrator, and OpenAI/Codex-first review worker are active. The publisher runs with a least-privilege database login, a repository-scoped Leadership deploy key, and one fixed Leadership candidate activation target. Backup automation and a clean restore rehearsal remain required operational work.

## Codex-first services

The recorded production release runs the real AI worker with OpenAI/Codex first (`gpt-5.6-sol`) and Claude Opus fallback-only. Production worker mode is API-only and requires `OPENAI_API_KEY`; CLI authentication is accepted only with `STUDIO_RUNTIME_ENV=validation`. The credential and AI database password live only in mode-0600 `shared/worker.env`. See `ops/worker.env.example`.

The publisher consumes immutable approvals, validates exact candidate bytes, runs trusted Leadership install/lint/typecheck/content/test/build commands, creates one structured commit, stages that release on the single `leadership.timsprototypes.com` candidate runtime, waits for final human confirmation, compare-and-swap advances remote `main`, and reconciles PostgreSQL without building or operating a second site. Rollback creates a new forward-history commit with the exact prior tree and repeats validation/build/activation. See `ops/publisher.env.example` and `ops/grant-service-privileges.sql`.

An isolated 2026-07-18 rehearsal completed 22 Codex review roles, staging, final confirmation, reconciliation, and rollback without touching the real Leadership remote. Production job `8fd6d658-8d64-4722-87dc-7699c61f7075` separately completed 22/22 Codex roles, 3/3 validations, one proposal, custody return, and visible Check in on `repeatedly-misses-deadlines`. On 2026-07-19 the exact revision-2 bundle `9caa2f0ac652…` was human-approved, staged, and explicitly published by request `d6e3b43c-2d8a-4881-b056-908bf907b30a`. The publisher created commit `b6e40575eb823dc32c62644775895ad84a80d2d1`, activated and externally verified it on `https://leadership.timsprototypes.com`, re-verified that same release after recent-password final confirmation, compare-and-swap advanced protected Git `main`, reconciled PostgreSQL, and released publisher custody. The retired duplicate route is archived and returns 404; its process, listener, runtime directory, and symlink are removed.

## Allocations

- Studio web: port 3015, pool maximum 8.
- Leadership candidate runtime: port 3005.
- AI/orchestrator pool maximum 5.
- validator and publisher pool maximum 2 each.
- operations pool maximum 2.
- one full review, one build, and one publication at a time; at most four interactive provider turns.

The Studio origin binds only the RP1 LAN address needed by the existing gateway. PostgreSQL clients use localhost/SCRAM. A host firewall rule must deny non-required LAN/Internet access to PostgreSQL before the friend beta; existing consumers must be inventoried before changing the listener.

## Backup

- nightly `pg_dump -Fc situation_studio`, encrypted, mode 0600;
- keep 14 daily and 3 monthly copies;
- copy one encrypted backup off RP1 daily;
- record checksum, size, PostgreSQL version, baseline Git commit, and copy result;
- verify checksum/decrypt/list daily;
- restore to a clean disposable database monthly and reconstruct one publication;
- RPO 24 hours, RTO 4 hours.

Database backup alone is incomplete: preserve the protected Git remote and release/publication manifests. Public Leadership can continue serving its last exact release while Studio is restored.

## Deployment order

Frozen install and complete local verification precede every release. The production sequence is backup, migration, compatible worker health, web symlink cutover, outer-gate check, Studio login, readiness/SSE, and one safe read. Studio rollback repoints to the prior schema-compatible release; no automatic down migration occurs.

`deploy.sh` implements the versioned release, migration, explicit web/service grants, idempotent baseline import, build, symlink cutover, deterministic web/worker/publisher PM2 restart, the single Leadership process configuration, health gates, and automatic Studio application rollback. It deliberately does not create credentials, bootstrap passwords, register outer-gate routes, configure backups, or grant Git publication authority. Those are separate security-boundary operations.

For this prototype topology, staging changes what the sole Leadership runtime serves while leaving protected Git `main` unchanged. Final publication re-verifies the same release, compare-and-swap advances `main`, and reconciles Studio; it does not build or deploy a second runtime. The internal `PREVIEW_*` saga names are retained for database compatibility and mean pre-publication candidate build/verification.

The first administrator is created only from an interactive RP1 TTY:

```sh
cd /home/admin/projects/situation-studio/current
set -a
source /home/admin/projects/situation-studio/shared/web.env
set +a
source ~/.nvm/nvm.sh
nvm use
corepack pnpm admin:bootstrap --username <username> --display-name "<display name>"
```

The command refuses a second active administrator and accepts the password only through its non-echoing TTY prompt. Break-glass reset revokes all sessions for the target administrator:

```sh
corepack pnpm admin:reset --username <username>
```

## Repository reviewer identity

Before a human can approve a candidate, an administrator must map that Studio
account to its unique Leadership frontmatter reviewer ID on the Administration
page. The mapping is audited and may not be shared by two accounts. An
unmapped account can inspect and comment on a proposal but cannot prepare or
approve it.

The reviewer then uses **Prepare exact bundle for my approval**. This does not
approve or publish anything. It creates an immutable child bundle with the
reviewer/date provenance, reruns deterministic validation, preserves open
comments, and exposes all exact artifact bodies and hashes for inspection. The
separate **Approve exact bundle** action appears only for the same mapped user;
blocking comments must still be resolved first.

Recent authentication is required for preparation, approval, staging, final
publication confirmation, lifecycle changes, and rollback. If the 15-minute
window has elapsed, the workspace asks for the current Studio password and
automatically retries the original action after successful confirmation.
Cancelling the prompt sends no retry and makes no workflow change. Failed
confirmation attempts use the login throttle and produce generic audited
denials.

See `rp1-assessment.md` for the observed host capacity, database listener risk, and concrete external-beta blockers.
