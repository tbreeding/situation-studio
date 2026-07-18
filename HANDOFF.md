# Situation Studio handoff

Last updated: 2026-07-18

## Purpose and authority

Situation Studio is the private operations application for creating, reviewing, and publishing coherent Leadership Field Guide learning bundles. PostgreSQL owns workflow state and history; the Leadership Git repository owns exact published artifact bytes and deployable commit history.

The original implementation specification is `/Users/timothybreeding/projects/leadership/SPEC-situation-studio.md`. It remains an untracked file in the Leadership workspace and must not be staged there without explicit direction. This repository is the implementation and deployment authority.

## Repository state

- Local repository: `/Users/timothybreeding/projects/situation-studio`.
- Remote: `git@github.com:tbreeding/situation-studio.git`.
- Branch: `main`.
- Current deployed implementation commit: `ecf18f7` (`Bind approvals to exact reviewer provenance`).
- The acceptance-report commit follows the runtime commits and records the deployed state.
- Leadership baseline commit: `9a870e5c70fef9ae71506cb3138745b88363a190`.
- Approved desktop UX specification: `SPEC-desktop-ui-ux-improvements.md`. The requested implementation is committed, deployed, and live-verified.
- The Codex-first worker, deterministic candidate edit application, cancellation, trusted publisher, final-confirmation cutover, and durable rollback are committed and deployed. Worker execution is enabled; publisher execution remains fail-closed pending restricted Leadership Git authority.
- No tracked published Leadership content was modified by the Studio build or deployments.

Before new work, run `git status --short`, read this file and `artifacts/reports/acceptance.json`, and preserve unrelated user changes.

## Live topology

- Public URL: `https://situation-studio.timsprototypes.com`.
- Outer gate: TimsPrototypes, registered and enabled.
- Private origin: `http://192.168.1.120:3015` on SSH host `rpi1-ts`.
- PM2 processes: `situation-studio-web` and `situation-studio-worker`.
- Release root: `/home/admin/projects/situation-studio/releases`.
- Active symlink: `/home/admin/projects/situation-studio/current`.
- Current recorded release: `20260718T195022Z`.
- Stable launchers: `/home/admin/projects/situation-studio/current/ops/start-web.sh` and `ops/start-worker.sh`.
- Shared environment files: `/home/admin/projects/situation-studio/shared/web.env`, `worker.env`, and `migrator.env`, mode 0600.

Direct private-IP root requests intentionally return only `{"status":"origin-ready"}`. The TimsPrototypes origin probe depends on this non-redirecting response. Requests with the configured public Host receive the Studio application behavior.

## Database and identities

- PostgreSQL container: `postgres16`, PostgreSQL 16.
- Database: `situation_studio`.
- Owner/migration login: `situation_studio_migrator`.
- Web runtime login: `situation_studio_web`.
- `situation_studio_ai` is a login limited to five connections and has explicit worker-only privileges. `situation_studio_validator`, `situation_studio_publisher`, and `situation_studio_backup` remain reserved non-login identities.
- Seven committed migrations are applied.
- The immutable baseline contains 15 situations and 37 artifacts; import is idempotent.
- The first human administrator, username `tim`, is active. Never place its password in arguments, environment variables, Git, documentation, logs, or chat.
- The `tim` account is uniquely mapped to Leadership reviewer ID `timothy-breeding`. The mapping was installed as an audited deployment operation; `agent` remains unmapped and cannot prepare or approve a bundle.
- A non-administrator acceptance account, username `agent`, is active at both the TimsPrototypes gate and Studio. It can inspect the inventory, creation form, Jobs, Capacity, and all 15 situation workspaces, but it cannot access Administration.
- The `agent` credentials are stored only in the local macOS login Keychain. Never copy or retrieve them into source, environment files, command arguments, documentation, logs, commits, or chat.

## Security boundaries

- The TimsPrototypes gate and Studio login are separate authentication layers.
- Studio uses secure host-only cookies, session-bound CSRF protection, exact public Host/Origin policy, Argon2id passwords, throttling, and append-only audit events.
- Provider execution is `api` in production. The separate AI worker identity is enabled; fake adapters are acceptance-only.
- Validator and publisher identities remain disabled.
- No restricted Git deploy key or production publication authority is provisioned.
- Do not substitute the web process, a human administrator credential, or personal CLI credentials for missing service identities.
- OpenAI/Codex is the required primary route. Production uses an OpenAI Responses API credential stored only in `shared/worker.env`; Claude Opus is fallback-only and is not configured. Personal CLI login is validation-only and the worker rejects it in production mode.
- Activation/reset links are single-use secrets. Do not copy them into documentation, logs, commits, or task summaries.
- RP1 PostgreSQL's broad pre-existing listener/firewall exposure still needs a coordinated host review before a wider beta.

## Completed work and evidence

- Next.js/TypeScript workspace, Prisma model, migrations, role-separated components, authentication/RBAC, legacy import, checkouts/drafts, review records, validation contracts, publication saga, and operational deployment tooling are implemented.
- The RP1 web release, database roles, migrations, explicit runtime grants, baseline import, PM2 recovery, public route, and first administrator are operational.
- The Administration layout was repaired after real production screenshots exposed misuse of the editor grid and missing intrinsic-width containment.
- Current local verification: formatting, lint, strict TypeScript, Prisma validation, baseline verification, secret scan, production build, 30 contract/unit tests, database invariants, and the 36-case Chromium matrix pass with 28 executed cases and 8 intentional desktop-scope skips on mobile.
- Browser coverage includes the prior desktop/mobile Administration regression plus the desktop UX behavior at 1280×800 and 1440×900: capability-aware navigation, inventory search/filtering, immutable-brief validation, all 15 published workspaces, proposal sentinel separation, full-screen Source keyboard behavior, dependency navigation, empty-state containment, console checks, and critical/serious accessibility scans.
- Acceptance evidence lives in `artifacts/reports/acceptance.json`.
- A live, authenticated, read-only desktop UX audit was completed on 2026-07-18 at a representative 1440×900 viewport. The audit covered Home, Jobs, Capacity, New Situation, and all 15 imported situation workspaces.
- All 15 audited workspace editors remained read-only without checkout, audited pages had no document-level horizontal overflow at the representative viewport, and the browser console produced no warnings or errors.
- The audit did not create, edit, check out, archive, approve, validate, publish, restore, or roll back any situation. No Leadership artifact bytes or workflow state changed.
- Administration was not audited live because `agent` is not an administrator. The audit found that the visible Administration navigation item silently redirected that account to Home; the local implementation now omits that link using the same server-derived capability that protects the route.
- `SPEC-desktop-ui-ux-improvements.md` records prioritized findings, resolved product decisions, 41 testable success criteria, verification steps, and checkpointed implementation boundaries. The user approved implementation through the 2026-07-18 task request.
- The isolated real-provider rehearsal used workflow `leadership-review-v3` and model policy `2026-07-18-codex-first-v2`. All 22 selected runs resolved to `gpt-5.6-sol`, with zero Claude fallbacks; candidate safety, contradiction audit, and role completion passed.
- The rehearsal also proved running-job cancellation and custody return, a publisher build rejection before preview, approval invalidation after correction, successful trusted preview/final confirmation/cutover, and durable rollback. Publication commit `01babf29268317b3ca9bbddfd61c6dbe264912fc` and rollback commit `e4057416e2627b0d02dc459f25daa66c6248cb10` exist only in the disposable remote. The rollback tree exactly matches Leadership baseline tree `340bef0d08dfababca804e3a811eb7918bb99959`.
- Browser concurrency exposed heartbeat/check-in and parallel-checkout serialization races. Checkout acquisition, draft save, and release now use bounded serializable retries; heartbeat renewal is a single conditional update. The production-runtime browser matrix passed after the repair.
- Production job `8fd6d658-8d64-4722-87dc-7699c61f7075` completed under release `20260718T190654Z`/commit `f54d9fe` and reviewed `repeatedly-misses-deadlines`: 22/22 durable steps and 22/22 `gpt-5.6-sol` runs succeeded, zero fallbacks were selected, one proposal bundle remains, 3/3 validations passed, and one completion audit was committed. Current release `20260718T195022Z`/commit `ecf18f7` runs both web and worker online with seven migrations applied.
- That first production job exposed and verified the repair of a service-role `INSERT … RETURNING` permission gap. Finalization now has audit-event readback privilege, reuses the candidate on retry, and enforces one bundle per AI job. One unreferenced retry duplicate was removed after checking it had no approval, comments, publication, or child references; the pre-deploy mode-0600 backup is `/home/admin/projects/situation-studio/shared/predeploy-backups/20260718T184533Z.dump`.
- The visible Check in action released the production review checkout after completion. The proposal remains in `HUMAN_REVIEW`, the situation has no active checkout, and no approval, publication request, Leadership Git mutation, or Leadership release mutation occurred.
- Release `20260718T195022Z` fixes the human-review trust boundary. Proposal state now renders `bundle_artifacts.content`, exposes all five exact artifact bodies and candidate hashes, and labels the canonical bundle hash. A mapped reviewer must create an immutable provenance-finalized child bundle before approval; the child carries open comments, updates changed public MDX reviewer/date fields, recalculates hashes, and reruns four exact-hash validations. Approval, staging, and publisher gates require that provenance.
- The 2026-07-18 production smoke test used the existing `agent` session read-only. It visibly rendered the revised escalation and checkpoint language from bundle `7c7379dcd992…`, showed five immutable artifacts with one changed, and displayed a disabled **Reviewer identity required** control. No preparation, comment resolution, approval, checkout, or publication occurred.
- The verified pre-deploy backup for this release is `/home/admin/projects/situation-studio/shared/predeploy-backups/20260718T195004Z.dump`, mode 0600.

## Remaining work

The protected web application and first usable AI-review beta are live. Publication is not enabled. Remaining high-priority work:

1. Have `tim` sign in, inspect all exact artifacts, use **Prepare exact bundle for my approval**, confirm the new reviewer/date bytes, and resolve the carried blocking comment only if the corrected candidate is acceptable. Do not treat preparation as approval.
2. Create a restricted publisher Git deploy key and release capability; prove production preview, final confirmation, publication, and rollback without personal credentials.
3. Provision validator and publisher logins only when their service processes are ready to run with documented least privileges. Provision Anthropic only if the optional fallback is desired.
4. Configure encrypted nightly `pg_dump` backups, off-host copy, retention, checksum verification, and a clean restore rehearsal.
5. Coordinate PostgreSQL listener/firewall hardening without disrupting other RP1 applications.
6. Perform the external friend end-to-end acceptance exercise only after publisher and recovery boundaries are ready.

Desktop UX and AI review are deployed:

- The pass covers authenticated desktop operation at 1280×800 and 1440×900. Mobile, the separate TimsPrototypes gate UI, and Administration redesign remain out of scope.
- The implementation provides rendered guidance before Source MDX, omission of unavailable Administration navigation, one structured four-section creation page, attention-first inventory search/filtering, and denser operational typography that preserves the existing visual identity.
- It also distinguishes published bytes from draft/proposal candidate bytes in plain language and verifies the distinction with a disposable sentinel proposal fixture.
- The real production proposal is deliberately unapproved and unpublished so a human can inspect it before crossing the publication authority boundary.

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

1. Confirm the worktree and `origin/main` state before editing. The desktop UX specification and implementation are committed and deployed.
2. Treat production AI review as enabled through the separate service API/database identity. Do not replace it with personal CLI authentication.
3. Treat publisher Git/release authority as absent even though the publication/rollback application code and schema are deployed. Do not approve or publish the live proposal without explicit human approval and a restricted publisher identity.
4. Use disposable local fixtures for publication/rollback verification until the production publisher boundary is provisioned. Production review mutations require explicit task scope and must leave checkouts in an intentional state.
5. Confirm the active RP1 release and both PM2 processes before any live mutation.
6. Treat provider fallback, publisher, backup, gateway, database-role, firewall, and content-publication changes as separate security boundaries.
7. Keep all credentials and activation/reset links out of source, arguments, environment files, documentation, logs, commits, and chat; use the existing local Keychain entries without exposing their values.
8. Run verification proportional to the change, including production-build browser checks at 1280×800 and 1440×900 for approved desktop UI work.
9. Use immutable releases and preserve the last healthy symlink target for rollback.
10. Update this handoff, `README.md`, the relevant runbook, and `artifacts/reports/acceptance.json` whenever deployment state or a remaining boundary changes.
