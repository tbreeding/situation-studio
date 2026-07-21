# Situation Studio handoff

Last updated: 2026-07-21, after live validation of the private-review handoff

## Purpose and authority

Situation Studio is the private operations application for creating, reviewing,
and publishing coherent Leadership Field Guide learning bundles. PostgreSQL is
now the authority for public Leadership reads through immutable content
snapshots, an official/candidate pointer, and a hash-verified last-known-good
cache. The separate database materializer has created the first private
database publication candidate, but the official pointer has not moved. Git is
still application source control and Git-era publication history/configuration
is retained until Checkpoint 8; it is no longer the active reader or publisher
backend.

The original implementation specification is `/Users/timothybreeding/projects/leadership/SPEC-situation-studio.md`. It remains an untracked file in the Leadership workspace and must not be staged there without explicit direction. This repository is the implementation and deployment authority.

## Repository and deployment state

- Local repository: `/Users/timothybreeding/projects/situation-studio`.
- Remote: `git@github.com:tbreeding/situation-studio.git`.
- Branch: `main`.
- Current deployed implementation commit: `794c268fdde6485a7f3e30123cbc7c8fb3657491` (`Keep editor clean across proposal refresh`).
- Current RP1 release: `20260720T195142Z`.
- Production PostgreSQL is at all 15 forward migrations. The guarded bootstrap
  created target generation 1 and was idempotent on rerun; the active candidate
  has reserved generation 2 without changing the official pointer.
- The complete corrected gate passed formatting, lint, strict TypeScript,
  Prisma validation, bootstrap guards, 634 tests, secret scan, and the
  production web build.
- The 36-case Chromium matrix passed 28 applicable cases with 8 intentional
  desktop-only mobile skips against a production build and a disposable clone
  of production. The run exercised two synthetic proposal workflows without
  changing production content.
- Leadership application release `20260721T052419Z` runs exact pushed commit
  `7d8802371303958387eec177713f511c361a4556`.

### Authoritative production migration status

- Checkpoints 0–4 are complete. The independent final implementation review
  accepted the corrected trees at 2026-07-20T03:58:50Z.
- Checkpoint 5 is accepted for this deployment under the owner's explicit
  off-host PITR/RPO/RTO waiver. The waiver did not make backup recovery pass:
  `archive_mode=off` and the lack of a proven encrypted off-host WAL chain
  remain catastrophic-recovery risk.
- Production shadow comparison was exact for manifest
  `cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`.
  All 24 canonical routes returned 200 and the not-found probe returned 404.
- The database-outage drill served public `/` with HTTP 200 from the verified
  last-known-good snapshot while health correctly returned 503/degraded, then
  reconverged to the database. Both Leadership and Studio prior-release
  symlink rehearsals passed and returned to the current releases.
- Checkpoint 6 is complete and independently accepted. Leadership serves
  snapshot `0a43cd58-5690-4c2b-ac2e-9a0c4ad86df3` directly from PostgreSQL,
  with one query per refresh and the exact manifest above. Studio and
  Leadership alone were restarted; unrelated services remained online.
- Checkpoint 7 is in progress. Human review and approval created immutable
  bundle revision 3, hash
  `9debf20662c65a508a35665b834ff4f527d3bd9084ef07d34b413abd9a03d2d9`.
  Publication request `c078a261-9a02-41e4-9825-cddbd51ed428` is safely paused
  at `CANDIDATE_AVAILABLE` on snapshot
  `184cc9d9-6bc9-4833-90e2-ffac573e3d69`, hash
  `ca8d523a5a4acef439a368c3511296d6058fccd20fb02c7d50cfa17ec7868a34`.
  The official snapshot is unchanged. The first private-review attempt exposed
  a Leadership continuation bug: a Next.js client transition preserved the
  pre-cookie root layout, so the candidate observer never mounted. Leadership
  commit `7d8802371303958387eec177713f511c361a4556` forces the required
  same-site document navigation and is independently accepted and deployed as
  release `20260721T052419Z`. Production still has zero candidate
  authorizations and zero candidate observations. Recent password
  reauthentication, private-candidate observation, and exact final human
  confirmation remain mandatory; neither may be manufactured or bypassed.
- A subsequent signed-in live validation reproduced another blocker before any
  authorization was created. Selecting **Review private candidate** in the
  Codex in-app browser replaced the Studio tab with `about:blank`; the
  asynchronous authorization request did not complete. A read-only production
  query immediately afterward still showed `CANDIDATE_AVAILABLE`, zero
  candidate authorizations, zero candidate observations, and no final
  confirmation. The Studio tab was restored to the situation workspace.
- The apparent cause is Studio's preauthorization
  `window.open("about:blank", "leadership-candidate")` strategy, which is not
  safe in a constrained single-tab browser. A local, uncommitted patch removes
  the popup and submits the one-time candidate exchange in the current tab. It
  also adds a pure regression for the `_self` handoff. Those changes are
  formatted but have **not** been verified, independently reviewed, committed,
  pushed, or deployed. They currently modify
  `apps/web/src/components/workspace-editor.tsx`,
  `apps/web/src/lib/publication-presentation.ts`, and
  `apps/web/test/publication-presentation.test.ts`.
- Checkpoint 8 remains blocked until the first database publication and the
  real approved observation period (proposed seven days) complete, followed by
  recovery revalidation and explicit decommission approval.

### Historical predeployment implementation evidence

The bullets in this subsection record the state before the 2026-07-20
deployment and are superseded for live status by the section above.

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
- The local schema now contains 15 forward migrations. The fresh top-level
  `pnpm verify:database-publication` run under the actual least-privilege
  materializer role completed `RECONCILED` publication and `RECONCILED`
  rollback with 14 exact ordered events, rejected cross-table target
  contention, released failed rollback candidate custody, and durably recorded
  an exhausted recovery as `RECONCILIATION_REQUIRED`. Git SSH and askpass were
  forced to fail throughout.
- Candidate exchange now requires an exact Leadership-to-Studio bearer secret;
  Studio's CSP allows forms only to the configured Leadership origin. Candidate
  cookies are HttpOnly/Secure/SameSite=Strict with a same-site continuation,
  and candidate routes/sessions force no-store, no-referrer, noindex and omit
  analytics/advertising. Observation receipts require the configured key ID.
- Leadership observation requests have a per-call abort and finite live and
  restoration deadlines. Exhausted automatic recovery writes a terminal
  reconciliation receipt/event instead of retrying indefinitely.
- At that predeployment point, `pnpm verify` passed in Studio with 623 tests
  and in Leadership with 42 tests. The current corrected gates pass 634 Studio
  tests and 43 Leadership tests, with 22 and 51 generated routes/pages.
- No production mutation occurred during the local Checkpoint 1–5
  implementation/review work described here; guarded production execution was
  subsequently completed as recorded in the authoritative status above.
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
- Active verified release: `/home/admin/projects/leadership/releases/20260721T052419Z`.
- The published page for `repeatedly-misses-deadlines` visibly reports `Reviewed: 7/18/2026`.
- The retired duplicate prototype is archived and returns 404. Its PM2 process, listener, runtime directory, and symlink are gone.

TimsPrototypes hosting is itself the candidate environment. There is intentionally no second Leadership runtime or hostname.

## Current publication state

- Target: `leadership-production`, candidate generation 2.
- Official snapshot: `0a43cd58-5690-4c2b-ac2e-9a0c4ad86df3`.
- Official manifest: `cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`.
- Candidate snapshot: `184cc9d9-6bc9-4833-90e2-ffac573e3d69`, hash
  `ca8d523a5a4acef439a368c3511296d6058fccd20fb02c7d50cfa17ec7868a34`.
- Database publication rows: one; the first row is `CANDIDATE_AVAILABLE` and is
  not an official publication.
- Active publication request: `c078a261-9a02-41e4-9825-cddbd51ed428`.
  Active rollback requests and candidate authorizations: zero. A short-lived
  authorization is created only after recent human reauthentication.
- Latest signed-in validation also found zero candidate observations and no
  final confirmation. The official pointer and public Leadership bytes remain
  unchanged.
- Public Leadership source: `database`; the verified last-known-good cache is
  populated with the same snapshot/hash.
- Studio web and separate publisher backends: `database`. The publisher is
  waiting for the signed private-candidate observation and final confirmation.

The reconciled Git-era publication for `repeatedly-misses-deadlines` remains
readable historical provenance. Its request
`d6e3b43c-2d8a-4881-b056-908bf907b30a`, commit
`b6e40575eb823dc32c62644775895ad84a80d2d1`, and publication record
`82be5ea1-5f3f-412f-b223-46e082497ec9` are not the current authority pointer.
The database materializer has exercised candidate preparation in production;
the public official pointer has not moved and database rollback has not been
exercised there. Do not manufacture candidate observation or final confirmation,
and do not trigger rollback without the exact human workflow.

## Database and identities

- PostgreSQL container: `postgres16`, PostgreSQL 16.
- Database: `situation_studio`.
- All 15 committed forward migrations are applied.
- The immutable official snapshot contains 32 active managed artifacts and 99
  edges. The reconciled registry also retains eight explicitly inactive legacy
  artifacts; bootstrap reruns are idempotent.
- `situation_studio_migrator`, `situation_studio_web`, `situation_studio_ai`,
  `situation_studio_publisher`, `leadership_content_reader`, and
  `situation_studio_materializer` are distinct identities with explicit grants
  and small connection pools.
- Leadership uses the read-only identity. The database publisher uses
  `situation_studio_materializer`, which cannot read sessions. Git-era
  publisher credentials remain mode 0600 only for Checkpoint 8 cleanup and are
  not the active backend.
- The first administrator, username `tim`, is active and uniquely mapped to Leadership reviewer ID `timothy-breeding`.
- The non-administrator acceptance account `agent` remains active but unmapped; it cannot prepare, approve, stage, publish, or access Administration.
- Never place passwords, service keys, activation/reset links, or credential values in arguments, Git, documentation, logs, or chat.

### Checkpoint 5 discovery, waiver, and completed drills

The original discovery found PostgreSQL 16.12 with `archive_mode=off`, no
working archive command, and no proven encrypted off-host WAL chain. The
required five-minute RPO, off-host PITR restore, and 60-minute RTO are still
not established. The owner explicitly waived that gate for this deployment;
the independent reviewer accepted Checkpoint 5 only under that scoped waiver
and required the residual catastrophic-recovery risk to stay explicit.

The guarded release, 15 migrations/grants, exact bootstrap, shadow reader,
cache, metrics, and abort controls are deployed. Shadow comparison was exact;
the frozen-cache outage/reconvergence drill and both prior-release symlink
rehearsals passed. At the final gate, load was 0.38/0.38/0.28, 4.55 GiB memory
was available, about 400 GiB disk was available, PostgreSQL and all intended
origins were healthy, and unrelated services remained online. `poledne-web`
continued its pre-existing clean PM2 recycling with exit code 0 and zero
unstable restarts; no migration command targeted it.

## Security boundaries

- The TimsPrototypes gate and Studio login are separate authentication layers.
- Studio uses secure host-only cookies, session-bound CSRF protection, exact Host/Origin policy, Argon2id passwords, throttling, recent reauthentication, and append-only audit events.
- OpenAI/Codex is primary for every review role. Production uses the Responses API with `gpt-5.6-sol`; Claude Opus is fallback-only and is not configured.
- Personal Codex or Claude CLI authentication is validation-only and rejected by production worker mode.
- AI identities cannot approve or publish. The web process cannot push Git or activate releases.
- The publisher accepts only a non-invalidated human approval over the exact bundle/base/validation hashes and can mutate only the allowlisted Leadership artifact paths.
- RP1 PostgreSQL's broad pre-existing listener/firewall exposure still needs a coordinated host review before a wider beta.

## Completed evidence

- Production diagnostic job `1364ca78-ff7e-4c9b-acf1-672dc08a9013` ran a
  complete review for `nothing-in-one-on-ones`: all 22 durable stages and all
  22 primary `gpt-5.6-sol` calls succeeded with zero retries, failures, or
  fallbacks. Proposal `87bdf2bb-f4cb-4c6d-9470-a1eccb7283fc`, hash
  `d4d6f199306c3dbf621aa4f970dfe51bf8f2486f29686d3c17ce5f0291cd2f52`,
  reached `HUMAN_REVIEW` with 3/3 approval-sensitive validations passed. It was
  not approved or published. Its checkout was released with the saved revision
  preserved and an explicit `AUTHORIZED_DIAGNOSTIC_CHECK_IN` service audit.
- That real review exposed a false unsaved-change warning when an automatic
  server refresh replaced a draft body with a proposal body. Release
  `20260720T195142Z` synchronizes untouched editor state while preserving real
  local edits. The independent reviewer accepted the correction; the full gate
  passes 634 tests and the production-runtime Chromium matrix passes 28/28
  applicable cases with 8 intentional mobile skips.
- The first production private-review attempt exposed a separate Leadership
  navigation defect. The strict candidate cookies were issued correctly, but
  the continuation used a client-side transition and preserved the root
  layout rendered before those cookies were available. The observer therefore
  never mounted and Studio remained at `CANDIDATE_AVAILABLE`. Leadership
  commit `7d8802371303958387eec177713f511c361a4556` replaces that transition
  with a full document navigation. The full Leadership gate (43 tests and
  production build), the focused regression on Chromium, Firefox, WebKit, and
  mobile, and an independent review all passed. Guarded release
  `20260721T052419Z` is healthy; its source hash matches the local commit and
  `/health/content` reports the unchanged official database snapshot.
- At 2026-07-20 16:42 UTC, a raw PM2 diagnostic emitted protected Studio
  environment values into the operator tool output. Every exposed application
  secret and the affected database credential were immediately rotated without
  printing replacements; live sessions were revoked. The four intended
  Studio/Leadership process definitions were deleted and recreated under a
  minimal environment, and both PM2's live metadata and saved dump now contain
  zero protected keys. Post-rotation Studio live/ready, database connectivity,
  Leadership exact UUID/hash/query count, database publisher identity, all 24
  routes, 404 behavior, target/candidate/publication counts, and every unrelated
  PM2 process passed. The old values must remain treated as compromised.
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

1. Resume from the three-file uncommitted Studio patch described above. Verify
   it, obtain independent review, commit/push it, deploy it through the guarded
   exact-commit release path, and reproduce the handoff in the in-app browser.
   Do not ask the owner to retry the current production review button first;
   its popup behavior is the active blocker.
2. After that correction is deployed, the owner must sign in, choose **Review
   private candidate**, enter their password if prompted, and then choose
   **Continue to private candidate** in Leadership for exact candidate
   `ca8d523a5a4acef439a368c3511296d6058fccd20fb02c7d50cfa17ec7868a34`.
   Leadership must return the signed healthy private-candidate receipt while
   anonymous routes continue serving official hash `cb57e758...54ea8e`.
3. After personally inspecting those exact private bytes, the owner must use
   the separate final confirmation for the same hash. Then verify the official
   pointer, public routes, cache, durable events, reconciliation, and custody
   release before declaring the first database publication complete.
4. Observe the reconciled publication for the owner-approved duration
   (proposed seven real days) with no unexplained snapshot, cache,
   authorization, availability, or audit mismatch.
5. After the elapsed observation and explicit decommission approval, complete
   Checkpoint 8: revoke/remove Git publisher credentials/config/code, retain
   readable Git-era history, apply only forward schema contraction, and rerun
   recovery and production smoke evidence.
6. The waived PITR/RPO/RTO capability remains resilience debt. Configure and
   rehearse encrypted off-host recovery when backup work resumes; do not record
   the deployment waiver as recovery proof.
7. Coordinate PostgreSQL listener/firewall hardening without disrupting other
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
3. Production readers and publisher are now database-backed. Prepare a private
   immutable snapshot candidate and atomically select only that exact
   human-confirmed hash; never recreate a second Leadership runtime.
4. Do not click the final confirmation or rollback control without exact human
   direction over the reviewed target.
5. Keep provider, publisher, backup, gateway, database-role, firewall, and content-publication changes as separate security boundaries.
6. Keep all credentials and activation/reset links out of source, arguments, documentation, logs, commits, and chat.
7. Use immutable releases and preserve the last healthy symlink target for rollback.
8. Run verification proportional to every change and update this handoff, the relevant runbook, and `artifacts/reports/acceptance.json` whenever deployment or publication state changes.
