# Situation Studio handoff

Last updated: 2026-07-19, after fresh independent Checkpoint 4 acceptance

## Purpose and authority

Situation Studio is the private operations application for creating, reviewing,
and publishing coherent Leadership Field Guide learning bundles. Production
still uses the protected Leadership Git repository as the public-content
authority. The approved migration in
`SPEC-database-publication-migration.md` replaces that boundary with immutable
PostgreSQL content snapshots, an official/candidate pointer, and a
hash-verified Leadership last-known-good cache. Git remains application source
control only after cutover.

The original implementation specification is `/Users/timothybreeding/projects/leadership/SPEC-situation-studio.md`. It remains an untracked file in the Leadership workspace and must not be staged there without explicit direction. This repository is the implementation and deployment authority.

## Repository and deployment state

- Local repository: `/Users/timothybreeding/projects/situation-studio`.
- Remote: `git@github.com:tbreeding/situation-studio.git`.
- Branch: `main`.
- Current deployed implementation commit: `312bf7749a83388f3fe57433d9457efcdce4f743` (`Make baseline import safe for existing production data`).
- Current RP1 release: `20260719T094530Z`.
- The deployed release includes SSE-backed complete-review progress, clearer review/publication presentation, expanded workflow and deploy safety tests, and the corrected artifact-inspector/comment-composer spacing.
- The complete local gate passed: formatting, lint, strict TypeScript, Prisma validation, immutable-baseline verification, 594 tests, secret scan, and the production web build.
- The 36-case Chromium matrix most recently passed 28 applicable cases with 8 intentional desktop-only mobile skips.
- Leadership protected `main` is `b6e40575eb823dc32c62644775895ad84a80d2d1`.

### Local database-publication migration state

- Checkpoints 0–3 are complete locally. The first independent Checkpoint 4
  security/recovery review returned **changes required**. Its candidate-boundary,
  bounded-recovery, rollback-cleanup/contention, and durable-event findings are
  remediated. The same reviewer independently reran both application gates, a
  fresh PostgreSQL verifier, built-header probes, and concurrent cross-table
  races, then recorded **accepted** at 2026-07-19T18:57:26Z. Checkpoint 5
  read-only discovery and local release/runbook preparation are complete, but
  off-host PITR/RPO/RTO evidence is blocked and deferred. Production has not
  received these changes.
- Checkpoint 1 added the expand-only snapshot, target, publication, event,
  candidate-authorization, observation, fencing, immutability, and
  least-privilege model plus recovery/runbook evidence.
- Checkpoint 2 produced canonical snapshot
  `cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`:
  32 managed artifacts, 99 relationships, 349,232 canonical bytes, and 24
  dynamic-route probes.
- The previous 29-file inventory omitted the workshop README, booklist CSV,
  and PNG logo. All three are now included; binary content has additive,
  immutable database support.
- Leadership tool content moved from executable `lib/tools.ts` data to
  validated `content/tools/tools.json` without changing the public tool API.
- `@situation-studio/content-contracts` is shared by Studio/backfill and by
  Leadership through its versioned vendored package.
- Fresh PostgreSQL 16 migration/backfill, a second no-op backfill, and a
  custom-format dump/restore all preserved the exact 32 bodies and 99 edges.
- Leadership now has filesystem, shadow, and database modes, a persistent
  verified last-known-good cache, one-time private candidate exchange, exact
  signed observations, and public/candidate isolation. The rebuilt production
  browser rendered the exact private candidate and then returned the same route
  to the unchanged official content after candidate cookies were cleared.
- The database materializer completes exact snapshot publication and
  database-native rollback without Git, including durable SSE events,
  duplicate/idempotent delivery, active-target contention, crash resume, exact
  confirmation, and automatic restoration after failed publication or rollback
  live verification.
- Production launchers now support fail-closed Git/database publisher
  selection and mode-0600 Leadership content-reader configuration outside
  immutable releases. Defaults remain the currently deployed Git publisher
  and filesystem reader.
- Leadership's former broad `rsync` deployment was replaced locally with an
  exact-approved, clean/pushed-main, committed-archive release flow with a 50
  MiB cap, full verification, atomic cutover, sanitized content health, the
  one Studio-owned PM2 launcher, and automatic prior-release restoration.
- The exact production bootstrap is guarded by target name and canonical
  manifest-hash approval. A disposable production-shaped run created
  generation 1 at the exact official snapshot and a second run was a no-op.
- Studio has an administrator-only safe publication-health endpoint;
  Leadership has sanitized official content/cache health endpoints. UI tests
  identify exact reconciliation hashes and the frozen-cache action.
- The local schema now contains 13 forward migrations. The fresh top-level
  `pnpm verify:database-publication` run completed `RECONCILED` publication and
  `RECONCILED` rollback with 14 exact ordered events, rejected cross-table
  target contention, released failed rollback candidate custody, and durably
  recorded an exhausted recovery as `RECONCILIATION_REQUIRED`. Git SSH and
  askpass were forced to fail throughout.
- Candidate exchange now requires an exact Leadership-to-Studio bearer secret;
  Studio's CSP allows forms only to the configured Leadership origin. Candidate
  cookies are HttpOnly/Secure/SameSite=Strict with a same-site continuation,
  and candidate routes/sessions force no-store, no-referrer, noindex and omit
  analytics/advertising. Observation receipts require the configured key ID.
- Leadership observation requests have a per-call abort and finite live and
  restoration deadlines. Exhausted automatic recovery writes a terminal
  reconciliation receipt/event instead of retrying indefinitely.
- `pnpm verify` passes in Studio with 623 tests and 22 generated routes/pages;
  Leadership `pnpm verify` passes with 42 tests and 51 generated routes/pages.
- No production migration, backfill, target selection, reader mode, cache,
  publication, deployment, or Git remote mutation occurred in Checkpoints 1–5.
- Detailed evidence: `docs/database-publication-checkpoint-1.md` and
  `docs/database-publication-checkpoint-2.md`,
  `docs/database-publication-checkpoint-3.md`, and
  `docs/database-publication-checkpoint-4.md`. Checkpoint 5 discovery,
  entrance gates, recovery template, minute-by-minute runbook, and abort card
  are in `docs/database-publication-checkpoint-5.md`.

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

### Leadership runtime

- Sole URL: `https://leadership.timsprototypes.com`.
- Sole private origin: `http://192.168.1.120:3005`.
- Sole PM2 process: `leadership-field-guide`.
- Active symlink: `/home/admin/projects/leadership/current`.
- Active verified release: `/home/admin/projects/leadership/releases/ae9f5987-017e-4a80-8c47-c10b5de8b994-b6e40575eb82`.
- The published page for `repeatedly-misses-deadlines` visibly reports `Reviewed: 7/18/2026`.
- The retired duplicate prototype is archived and returns 404. Its PM2 process, listener, runtime directory, and symlink are gone.

TimsPrototypes hosting is itself the candidate environment. There is intentionally no second Leadership runtime or hostname.

## Current publication state

- Situation: `repeatedly-misses-deadlines`.
- Approved bundle hash: `9caa2f0ac652015fcba0839fd83f87d0ebe19a0e675b97cc9114c6b237688aeb`.
- Publication request: `d6e3b43c-2d8a-4881-b056-908bf907b30a`.
- Publication UUID: `ae9f5987-017e-4a80-8c47-c10b5de8b994`.
- Published commit: `b6e40575eb823dc32c62644775895ad84a80d2d1`.
- State: `RECONCILED` at internal step `RECONCILED`.
- Final confirmation: recorded at `2026-07-19 07:55:43.540 UTC` after recent password reauthentication.
- Publication record: `82be5ea1-5f3f-412f-b223-46e082497ec9`, health `VERIFIED`.
- Protected Git `main`: `b6e40575eb823dc32c62644775895ad84a80d2d1`.
- Publisher checkout: released at `2026-07-19 07:55:50.919 UTC` with reason `PUBLICATION_SUCCEEDED`; no active checkout remains.

The internal `PREVIEW_*` state names mean candidate build and candidate verification. They do not imply another running site.

The UI now reports **Published successfully**, identifies `b6e40575` as the official protected-Git baseline, displays the live published guidance, and shows checkout as available. There is no current candidate or pending publication.

The publication semantics are:

1. **Stage approved bundle** validates and commits the exact approved bytes, builds them for the sole Leadership hostname, activates that candidate release on the sole Leadership process, and verifies its marker and health. Protected Git `main` does not move.
2. **Confirm and publish b6e40575** re-verifies that same staged release, compare-and-swap advances protected Git `main` to the already-staged commit, and reconciles PostgreSQL. It does not build, deploy, or operate a second version. After confirmation, the Studio page automatically tracks confirmation, protected-main advancement, Leadership verification, and reconciliation/custody release.

Production Git finalization has been exercised successfully. Production rollback has not; do not trigger it without explicit human direction.

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

### Checkpoint 5 read-only discovery

Read-only discovery at 2026-07-19 15:22 UTC confirmed the active Studio and
Leadership symlinks are unchanged, both application origins are healthy, the
`postgres16` container is healthy, and the production database still has seven
migrations. The host had 5.2 GiB memory available, zero swap in use, 401 GiB
disk free, and load averages 0.19/0.10/0.08. All named PM2 processes were
online; `poledne-web` already showed seven restarts and only three minutes of
uptime before this migration made any production change, so that unrelated
baseline needs rechecking at the deployment window.

The same discovery found that PostgreSQL 16.12 has `archive_mode=off` and a
disabled archive command. The newest visible Studio database dump remains
`shared/predeploy-backups/20260719T053331Z.dump`; no encrypted `.gpg`/`.age`,
WAL archive, or off-host backup evidence was present under the Studio shared
tree. Therefore the required five-minute RPO, off-host PITR restore, and
60-minute RTO are not established. This is a hard Checkpoint 5 gate, not a
warning to waive. The user explicitly deferred backup/PITR configuration for
now; no backup settings or production data were changed. This still blocks
Checkpoint 5 acceptance and every public cutover checkpoint.

The local Checkpoint 5 preparation added guarded runtime backend selection,
external mode-0600 Leadership content configuration, exact-hash production
bootstrap, safe health metrics, a recovery evidence record, and a timed
shadow/cutover/abort runbook. None is deployed. Production must not be changed
until the independent review is accepted and off-host PITR passes.

## Security boundaries

- The TimsPrototypes gate and Studio login are separate authentication layers.
- Studio uses secure host-only cookies, session-bound CSRF protection, exact Host/Origin policy, Argon2id passwords, throttling, recent reauthentication, and append-only audit events.
- OpenAI/Codex is primary for every review role. Production uses the Responses API with `gpt-5.6-sol`; Claude Opus is fallback-only and is not configured.
- Personal Codex or Claude CLI authentication is validation-only and rejected by production worker mode.
- AI identities cannot approve or publish. The web process cannot push Git or activate releases.
- The publisher accepts only a non-invalidated human approval over the exact bundle/base/validation hashes and can mutate only the allowlisted Leadership artifact paths.
- RP1 PostgreSQL's broad pre-existing listener/firewall exposure still needs a coordinated host review before a wider beta.

## Completed evidence

- At 2026-07-19 07:17 UTC, the former workspace-wide deploy transfer began copying an 878 MB / 40,101-file payload that included ignored `artifacts/runtime` data. RP1 stopped answering IP traffic after 318 MB transferred; the deploy never reached dependency installation, build, symlink cutover, or PM2 reload. A physical power cycle at 07:28 UTC restored the preserved Studio release `20260719T070439Z`, preserved Leadership candidate release, all PM2 processes, and healthy PostgreSQL. The exact kernel-level cause is unproven because the previous boot journal was not persistent. The deploy path is now guarded by exact-commit approval, clean/pushed-main checks, a healthy-host preflight, a 50 MB source-archive cap, and Git-committed-source-only transfer.
- At 2026-07-19 09:48 UTC, guarded release `20260719T094530Z` deployed commit `312bf7749a83388f3fe57433d9457efcdce4f743`. The transferred committed archive was 1,341,440 bytes. An initial release attempt stopped before build or cutover when the bootstrap-only baseline importer encountered the initialized production database; the live symlink and processes remained untouched. The importer now imports only into an empty database, safely no-ops for initialized production, and fails closed on partial initialization. The corrected attempt passed 594 tests, reported the existing 15 situations and 37 artifacts without rewriting them, built before atomic cutover, and verified Studio live/ready, PostgreSQL, Leadership, and all named PM2 processes. Unrelated RP1 process PIDs remained unchanged.
- The branded SVG favicon is live at `/icon.svg` with the expected `image/svg+xml` content type. Its deployed SHA-256 exactly matches the committed source, and the mark remains legible in a 16×16 raster check.
- Production review job `8fd6d658-8d64-4722-87dc-7699c61f7075` completed 22/22 durable roles using `gpt-5.6-sol`, with zero fallbacks, one proposal bundle, and 3/3 validations.
- The reviewer-provenance flow created revision 2, wrote `timothy-breeding` and review date `2026-07-18` into the exact changed MDX, reran exact-byte validation, and produced the approved bundle above.
- Visible Check in, saved-revision preservation, unsaved-change cancellation, recent reauthentication, active-job cancellation, publisher custody transfer, and immutable approval gates are implemented and production exercised.
- The published/candidate comparison is an aligned line diff with additions, removals, exact line numbers, blank counterparts, and synchronized vertical and horizontal scrolling.
- The guarded final-publication flow completed in production after recent password reauthentication. Protected Git `main` advanced exactly from `9a870e5c` to `b6e40575`; the existing Leadership release was re-verified without another build or runtime; PostgreSQL reconciled publication `82be5ea1-5f3f-412f-b223-46e082497ec9`; and publisher custody released with no active checkout.
- Candidate staging acquired publisher custody after human Check in, created one exact candidate commit, activated one Leadership runtime, and preserved that same verified release through final publication.
- The candidate was rebuilt for the sole Leadership hostname; generated output contains no retired hostname. The publisher's stable PM2 launcher was verified against the active Leadership PID.
- The retired duplicate TimsPrototypes route is archived, the route returns 404, only port 3005 listens for Leadership, and only `leadership-field-guide` exists in PM2.
- An isolated disposable rehearsal completed publication and forward-history rollback without touching the real Leadership remote. Publication commit `01babf29268317b3ca9bbddfd61c6dbe264912fc` and rollback commit `e4057416e2627b0d02dc459f25daa66c6248cb10` exist only in that disposable remote.
- Latest recorded predeployment backup: `/home/admin/projects/situation-studio/shared/predeploy-backups/20260719T053331Z.dump`, mode 0600.

## Remaining work

1. Obtain and record the required independent Checkpoint 4 security/recovery
   review from someone other than the implementation agent using
   `docs/database-publication-independent-review.md`. The review must challenge
   schema invariants, candidate authorization, confirmation, crash-resume
   behavior, automatic restoration, database-native rollback, and the recovery
   runbook.
2. Execute Checkpoint 5 from `docs/database-publication-checkpoint-5.md`:
   configure encrypted off-host WAL archiving, prove the five-minute RPO and
   60-minute restore, deploy only the additive/shadow boundary, prove frozen
   cache and prior-release rollback, and record zero production mismatches.
3. Complete Checkpoints 6–7 only after their live gates: public reader cutover,
   first database-authoritative publication, and the approved observation
   period.
4. Complete Checkpoint 8 only after observation: remove Git publication
   authority and active-state UI/code, retain Git-era history, and revalidate
   database/frozen-cache recovery.
5. Coordinate PostgreSQL listener/firewall hardening without disrupting other
   RP1 applications. Configure Anthropic only if optional fallback is desired.

## Safe operational commands

Full local gate:

```sh
cd /Users/timothybreeding/projects/situation-studio
pnpm verify
pnpm test:browser
```

Database-publication acceptance uses a newly migrated, grant-provisioned
`situation_studio_migration_test_*` database with no publication target:

```sh
DATABASE_URL="$DISPOSABLE_DATABASE_URL" \
ACCEPTANCE_FIXTURE_KEY="unique-disposable-fixture" \
pnpm verify:database-publication
```

The acceptance suite has also passed with Git SSH transport and askpass forced
to `/usr/bin/false` and an unreachable loopback remote.

Production bootstrap is intentionally a separate, exact-hash action after the
forward migration and before shadow mode. Use only the canonical hash recorded
in the approved checkpoint and the migrator identity:

```sh
DATABASE_PUBLICATION_BOOTSTRAP_TARGET=leadership-production \
DATABASE_PUBLICATION_BOOTSTRAP_APPROVAL="bootstrap:leadership-production:<approved-manifest-hash>" \
pnpm bootstrap:database-publication:apply
```

The command refuses non-test databases without both exact values and refuses a
non-clean existing target. It must be rerun once to prove idempotence before
Leadership shadow mode.

Deploy an explicitly approved, committed, and pushed `main` SHA. The script refuses
unapproved commits, dirty worktrees, unhealthy hosts, and oversized source archives;
it transfers committed Git source only:

```sh
cd /Users/timothybreeding/projects/situation-studio
SITUATION_STUDIO_APPROVED_COMMIT="$(git rev-parse HEAD)" ./deploy.sh
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
3. Until cutover, treat production Stage as candidate activation and Publish as
   exact Git finalization/reconciliation. In the new database backend, prepare
   a private snapshot candidate and atomically select only that confirmed hash;
   never recreate a second Leadership runtime.
4. Do not click the final publication or rollback controls without explicit human direction.
5. Keep provider, publisher, backup, gateway, database-role, firewall, and content-publication changes as separate security boundaries.
6. Keep all credentials and activation/reset links out of source, arguments, documentation, logs, commits, and chat.
7. Use immutable releases and preserve the last healthy symlink target for rollback.
8. Run verification proportional to every change and update this handoff, the relevant runbook, and `artifacts/reports/acceptance.json` whenever deployment or publication state changes.
