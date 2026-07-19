# Situation Studio handoff

Last updated: 2026-07-19 05:56 UTC

## Purpose and authority

Situation Studio is the private operations application for creating, reviewing, and publishing coherent Leadership Field Guide learning bundles. PostgreSQL owns mutable workflow state and history. The protected Leadership Git repository owns published artifact bytes and commit history.

The original implementation specification is `/Users/timothybreeding/projects/leadership/SPEC-situation-studio.md`. It remains an untracked file in the Leadership workspace and must not be staged there without explicit direction. This repository is the implementation and deployment authority.

## Repository and deployment state

- Local repository: `/Users/timothybreeding/projects/situation-studio`.
- Remote: `git@github.com:tbreeding/situation-studio.git`.
- Branch: `main`.
- Current implementation commit: `974e6db4f8ae073b55570dd3e6a9900fe04ec8a7` (`Use candidate terminology throughout Studio`).
- Current RP1 release: `20260719T055257Z`.
- The worktree was clean after the release.
- The complete local gate passed: formatting, lint, strict TypeScript, Prisma validation, immutable-baseline verification, 35 tests, secret scan, and the production web build.
- The 36-case Chromium matrix most recently passed 28 applicable cases with 8 intentional desktop-only mobile skips.
- Leadership protected `main` remains `9a870e5c70fef9ae71506cb3138745b88363a190`.

Before new work, run `git status --short`, read this file and `artifacts/reports/acceptance.json`, and preserve unrelated user changes.

## Live topology

### Situation Studio

- Public URL: `https://situation-studio.timsprototypes.com`.
- Private origin: `http://192.168.1.120:3015` on SSH host `rpi1-ts`.
- Outer gate: TimsPrototypes, active and managed only through its owner UI.
- PM2 processes: `situation-studio-web`, `situation-studio-worker`, and `situation-studio-publisher`.
- Release root: `/home/admin/projects/situation-studio/releases`.
- Active symlink: `/home/admin/projects/situation-studio/current`.
- Shared mode-0600 environments: `web.env`, `worker.env`, `publisher.env`, and `migrator.env` under `/home/admin/projects/situation-studio/shared`.
- Stable publisher activation launcher: `/home/admin/projects/situation-studio/current/ops/publisher-pm2.sh`.

Direct private-IP root requests intentionally return only `{"status":"origin-ready"}`. The TimsPrototypes origin probe depends on that non-redirecting response. Requests with the configured public Host receive the Studio application.

### Leadership candidate

- Sole URL: `https://leadership.timsprototypes.com`.
- Sole private origin: `http://192.168.1.120:3005`.
- Sole PM2 process: `leadership-field-guide`.
- Active symlink: `/home/admin/projects/leadership/current`.
- Active candidate release: `/home/admin/projects/leadership/releases/ae9f5987-017e-4a80-8c47-c10b5de8b994-b6e40575eb82`.
- The candidate page for `repeatedly-misses-deadlines` visibly reports `Reviewed: 7/18/2026`.
- The retired duplicate prototype is archived and returns 404. Its PM2 process, listener, runtime directory, and symlink are gone.

TimsPrototypes hosting is itself the candidate environment. There is intentionally no second Leadership runtime or hostname.

## Current publication state

- Situation: `repeatedly-misses-deadlines`.
- Approved bundle hash: `9caa2f0ac652015fcba0839fd83f87d0ebe19a0e675b97cc9114c6b237688aeb`.
- Publication request: `d6e3b43c-2d8a-4881-b056-908bf907b30a`.
- Publication UUID: `ae9f5987-017e-4a80-8c47-c10b5de8b994`.
- Candidate commit: `b6e40575eb823dc32c62644775895ad84a80d2d1`.
- State: `AWAITING_CONFIRMATION` at internal step `PREVIEW_VERIFIED`.
- Final confirmation: not recorded.
- Protected Git `main`: still `9a870e5c70fef9ae71506cb3138745b88363a190`.
- Publisher checkout: held in publisher custody while the request awaits confirmation.

The internal `PREVIEW_*` state names mean candidate build and candidate verification. They do not imply another running site.

The UI now says **Candidate staged on Leadership** and links **Open staged Leadership** to the sole Leadership URL. **Publish this reviewed bundle** remains visible because the request is deliberately paused before final confirmation.

The publication semantics are:

1. **Stage approved bundle** validates and commits the exact approved bytes, builds them for the sole Leadership hostname, activates that candidate release on the sole Leadership process, and verifies its marker and health. Protected Git `main` does not move.
2. **Publish this reviewed bundle** re-verifies that same staged release, compare-and-swap advances protected Git `main` to the already-staged commit, and reconciles PostgreSQL. It does not build, deploy, or operate a second version.

Do not trigger final publication without explicit human direction. Production Git finalization and production rollback have not yet been exercised.

## Database and identities

- PostgreSQL container: `postgres16`, PostgreSQL 16.
- Database: `situation_studio`.
- Seven committed migrations are applied.
- The immutable baseline contains 15 situations and 37 artifacts; import is idempotent.
- `situation_studio_migrator`, `situation_studio_web`, `situation_studio_ai`, and `situation_studio_publisher` are active, distinct identities with explicit grants and small connection pools.
- The publisher has a repository-scoped read/write Leadership deploy key and a separate mode-0600 service environment. Production does not use a human Git credential.
- The first administrator, username `tim`, is active and uniquely mapped to Leadership reviewer ID `timothy-breeding`.
- The non-administrator acceptance account `agent` remains active but unmapped; it cannot prepare, approve, stage, publish, or access Administration.
- Never place passwords, service keys, activation/reset links, or credential values in arguments, Git, documentation, logs, or chat.

## Security boundaries

- The TimsPrototypes gate and Studio login are separate authentication layers.
- Studio uses secure host-only cookies, session-bound CSRF protection, exact Host/Origin policy, Argon2id passwords, throttling, recent reauthentication, and append-only audit events.
- OpenAI/Codex is primary for every review role. Production uses the Responses API with `gpt-5.6-sol`; Claude Opus is fallback-only and is not configured.
- Personal Codex or Claude CLI authentication is validation-only and rejected by production worker mode.
- AI identities cannot approve or publish. The web process cannot push Git or activate releases.
- The publisher accepts only a non-invalidated human approval over the exact bundle/base/validation hashes and can mutate only the allowlisted Leadership artifact paths.
- RP1 PostgreSQL's broad pre-existing listener/firewall exposure still needs a coordinated host review before a wider beta.

## Completed evidence

- Production review job `8fd6d658-8d64-4722-87dc-7699c61f7075` completed 22/22 durable roles using `gpt-5.6-sol`, with zero fallbacks, one proposal bundle, and 3/3 validations.
- The reviewer-provenance flow created revision 2, wrote `timothy-breeding` and review date `2026-07-18` into the exact changed MDX, reran exact-byte validation, and produced the approved bundle above.
- Visible Check in, saved-revision preservation, unsaved-change cancellation, recent reauthentication, active-job cancellation, publisher custody transfer, and immutable approval gates are implemented and production exercised.
- The published/candidate comparison is an aligned line diff with additions, removals, exact line numbers, blank counterparts, and synchronized vertical and horizontal scrolling.
- Candidate staging acquired publisher custody after human Check in, created one exact candidate commit, activated one Leadership runtime, and stopped before final confirmation.
- The candidate was rebuilt for the sole Leadership hostname; generated output contains no retired hostname. The publisher's stable PM2 launcher was verified against the active Leadership PID.
- The retired duplicate TimsPrototypes route is archived, the route returns 404, only port 3005 listens for Leadership, and only `leadership-field-guide` exists in PM2.
- An isolated disposable rehearsal completed publication and forward-history rollback without touching the real Leadership remote. Publication commit `01babf29268317b3ca9bbddfd61c6dbe264912fc` and rollback commit `e4057416e2627b0d02dc459f25daa66c6248cb10` exist only in that disposable remote.
- Latest recorded predeployment backup: `/home/admin/projects/situation-studio/shared/predeploy-backups/20260719T053331Z.dump`, mode 0600.

## Remaining work

1. Have the human reviewer inspect the staged Leadership candidate. If and only if it is acceptable, explicitly use **Publish this reviewed bundle** and verify Git `main`, the release marker, Studio reconciliation, and custody return.
2. After a real publication exists, exercise one explicitly authorized production rollback and verify the forward-history commit and restored tree.
3. Configure encrypted nightly `pg_dump`, off-host copy, retention, checksum verification, and a clean restore rehearsal.
4. Coordinate PostgreSQL listener/firewall hardening without disrupting other RP1 applications.
5. Configure Anthropic only if the optional fallback is desired.
6. Perform the external-friend end-to-end acceptance exercise after publication and recovery boundaries are proven.

## Safe operational commands

Full local gate:

```sh
cd /Users/timothybreeding/projects/situation-studio
pnpm verify
pnpm test:browser
```

Deploy committed `main`:

```sh
cd /Users/timothybreeding/projects/situation-studio
./deploy.sh
```

Read-only RP1 checks:

```sh
ssh rpi1-ts 'readlink -f /home/admin/projects/situation-studio/current'
ssh rpi1-ts 'readlink -f /home/admin/projects/leadership/current'
ssh rpi1-ts 'source ~/.nvm/nvm.sh && pm2 status'
ssh rpi1-ts "ss -ltn '( sport = :3005 or sport = :3015 )'"
```

Studio origin health:

```sh
curl -H 'Host: situation-studio.timsprototypes.com' http://192.168.1.120:3015/health/live
curl -H 'Host: situation-studio.timsprototypes.com' http://192.168.1.120:3015/health/ready
```

Public URLs require the TimsPrototypes gate session and may return 403 to an unauthenticated CLI even when healthy. Gateway registration, disablement, and archival must use the TimsPrototypes owner UI; do not edit proxy configuration directly.

## Continuation checklist

1. Confirm the worktree, `origin/main`, active RP1 release, PM2 process list, Leadership symlink, and protected Leadership `main` before mutation.
2. Preserve the one-runtime model: one Leadership hostname, process, port, and active symlink.
3. Treat Stage as candidate activation and Publish as exact Git finalization/reconciliation; never recreate a second running version.
4. Do not click the final publication or rollback controls without explicit human direction.
5. Keep provider, publisher, backup, gateway, database-role, firewall, and content-publication changes as separate security boundaries.
6. Keep all credentials and activation/reset links out of source, arguments, documentation, logs, commits, and chat.
7. Use immutable releases and preserve the last healthy symlink target for rollback.
8. Run verification proportional to every change and update this handoff, the relevant runbook, and `artifacts/reports/acceptance.json` whenever deployment or publication state changes.
