# Situation Studio handoff

Last updated: 2026-08-01

## Outcome

Situation Studio is deployed on `rpi1` from the immutable release at
`/home/admin/projects/situation-studio/releases/20260729T085659Z`. The deployed
source is commit `70da5cae79d747204eeb6f1f8a4b6f61a997b586` on `main`. The
authenticated production workspace is
`https://situation-studio.timsprototypes.com`.

The workbench now provides ordinary username/password authentication, durable
exclusive checkouts, immutable drafts and history, section and raw-MDX editing,
rendered preview and exact diff, optional durable agent review, selective
proposal application, new-situation creation, reversible retirement,
per-situation restoration, and one-action publication. The rendered production
and saved-draft comparison scrolls in sync, and the selected workspace tab is
stored in the URL so it survives refresh and direct navigation.

This release candidate includes the completed retry-provider and real-time
review-status follow-ups described below.

Publication builds a complete immutable Leadership release, advances the
official pointer with an expected-generation fence, verifies both database and
runtime identities, and automatically restores the prior release if
post-promotion verification fails. Injected process-death tests prove restart
reconciliation after candidate persistence, pointer promotion, and runtime
verification.

## Completed: review the agent revision as a diff

Implementation status: completed in this release candidate. The brief below is
retained as the acceptance record for the immutable agent-candidate model,
normalized finding lineage, fenced per-hunk decisions, atomic bulk acceptance,
and the responsive Saved draft → Agent revision review surface.

The previous bottom-of-page **Agent proposal** card has been removed. The
implemented product direction is a code-review-style experience in which the
agent produces a temporary candidate revision and the Review tab compares the
saved draft with that agent revision.

The candidate must not overwrite or otherwise mutate the authoritative saved
draft before editorial acceptance. It should look editable in the review
surface, but remain isolated review state until an editor accepts changes.

Required editor experience:

- Make the primary review comparison **Saved draft → Agent revision**, with
  inline added, removed, and modified highlighting.
- Attach a concise explanation to each diff hunk: why it changed, what problem
  it addresses, which worker or finding identified the problem, which worker
  wrote the replacement, and the relevant evidence lineage.
- Support **Accept**, **Reject**, and **Edit suggestion** on each hunk. An
  editor-modified suggestion must be visibly marked and the edited result—not
  the original suggestion—must be what acceptance applies.
- Support **Accept all** only when actionable unresolved changes exist. It
  must display the count and apply all eligible changes atomically rather than
  silently skipping unsupported types or partially applying a serial loop.
- Keep the existing production comparison available as a secondary view; do
  not conflate production-versus-draft changes with agent-versus-draft
  suggestions.
- Represent bundle-level changes such as metadata, relationships, scoped
  variants, and embeds as structured diff rows in the same review experience.
  When the agent cannot safely produce a fix, anchor an unresolved inline
  comment to the relevant content or bundle item instead of emitting a long
  report card.
- Preserve checkout fences, immutable review evidence, proposal input
  revision/hash checks, auditability, stale-draft conflict detection, and
  publication provenance.
- Keep explanations compact by default, with deeper rationale and evidence
  available on demand. Preserve responsive layout, keyboard operation,
  semantic status, and reduced-motion behavior.

Worker attribution must describe actual lineage rather than inventing a single
author. For example, an exact replacement may be “Written by Bundle Writer,
responding to a Teaching Designer finding, supported by Coaching and Manager
Tools reviewers.” Candidate edit records therefore need explicit links to the
upstream finding IDs and role codes that informed them.

### Current failure that motivated the redesign

The latest production review for `repeatedly-misses-commitments` materialized
proposal `43f60de2-8e58-47b7-ba5f-4a0f052668b9` with a 1,457-character
summary, five structured findings (two blocking, two important, one note), and
zero candidate edits.

The current implementation:

- stores `summary`, `findings`, and `candidateEdits` separately in
  `apps/review-worker/src/review.ts`;
- permits a summary of up to 12,000 characters and does not require a
  candidate edit in `packages/ai-adapters/src/index.ts`;
- drops `findings` from the workspace view model in
  `apps/web/src/app/situations/[slug]/page.tsx`;
- renders the complete summary as a heading in
  `apps/web/src/components/workspace-editor.tsx`;
- enables **Accept all** without checking for actionable changes; its empty
  loop performs no mutation and only refreshes the route; and
- compares only production and saved draft above the proposal card, so it has
  no agent-candidate visualization even when edits exist.

Current proposal application can automatically apply only `SECTION` and
`SCOPED_VARIANT` changes. `METADATA` and `RELATIONSHIP` changes return a manual
editorial-edit error. The redesign must either add safe typed application for
those targets or present them explicitly as manual structured suggestions; it
must never hide or silently skip them.

Implementation should include schema/migration design, normalized worker output
and provenance, candidate materialization, atomic and individually fenced
decision workflows, editable suggestions, the unified diff UI, and focused
unit/integration/browser coverage. Browser coverage should prove zero-change
behavior, individual accept/reject, edited acceptance, atomic Accept all,
unsupported/manual changes, stale-input conflicts, refresh persistence,
keyboard/accessibility behavior, and narrow/desktop layouts.

## Repository boundary

Situation Studio is at
`/Users/timothybreeding/projects/situation-studio`. The coordinated Leadership
changes are at `/Users/timothybreeding/projects/leadership`. The coordinated
Leadership candidate is commit
`bb0ee441986e1923bce2d7793227f35d4f385923`.

At the start of implementation, Situation Studio was on local `main`, matching
`origin/main`, with an intentional worktree containing the provider-retry
implementation and timeout investigation. Production was inspected read-only
during that incident investigation. No production review retry or content
change was made.

The exact shared situation-contract archive has SHA-256
`9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4`
in both repositories.

## Review timeout incident

The production review for `repeatedly-misses-commitments` did not remain
running. It reached a terminal retryable failure:

- Review job: `6e086a0f-28df-4ac9-8fad-9ea04cc46d9f`
- Queued: 2026-07-24 20:36:44 UTC (22:36:44 CEST)
- Stages 1–17: succeeded with Codex using `gpt-5.6-sol`
- Stage 18, `bundle-writer`: started at 20:47:28 UTC and failed at 20:50:30 UTC
- Final state: `FAILED`
- Job failure code: `TRANSIENT`
- Agent-run failure class: `PROVIDER_TRANSIENT`
- Retryable: `true`
- Stages 19–22: remained `PENDING`

The stage duration was about 181 seconds. `runWithFallback` gives Codex and
then Claude separate 90-second provider deadlines, so the retained evidence
strongly indicates that Codex timed out and the Claude fallback then timed out.
The production adapter at that release persisted only the aggregate failure;
it did not retain safe per-provider timing/failure metadata, so the deeper
upstream cause cannot be recovered. The retry follow-up retains bounded safe
per-provider outcomes for future attempts.

All three PM2 services were online with zero restarts during inspection. The
database and leadership observation were healthy. Both Codex and Claude
authentication were available under `situation-studio-review` on 2026-07-25.
No provider child process remained stuck.

The failed run created no review proposal. The job's pinned input revision is
still the current draft revision and its bundle hash is unchanged. The only
job audit event is `REVIEW_QUEUED`; no retry occurred. The production UI's
“0 changed sections” was therefore consistent with the retained draft.

The existing manual **Retry review** action resumes at stage 18, preserves
stages 1–17, and resets stages 19–22 for the remaining dependency path. It was
not invoked during this investigation.

## Implemented follow-ups

### Unreleased focused review lane and failure explanations

The 2026-08-01 local implementation supersedes the earlier backoff queue
behavior below but has not been deployed. One durable lane owner now remains
focused through automatic retry waits and terminal failures. Later reviews do
not start until the focused review succeeds or the editor explicitly retries,
stops, or closes it. The workspace projects fixed safe reason codes as plain
stage-specific explanations and keeps raw provider output and error text out of
the public status stream. Proposal materialization accepts case-only role-code
differences in evidence links and attributes other assembly failures to the
bundle writer so the writer and downstream audits can run again.

The deployed 2026-07-29 release still uses the earlier behavior described in
the historical retry-provider record that follows.

#### 2026-08-01 read-only production review inventory

At 19:32 UTC, all five active checkouts and their draft resume anchors remained
intact. No review was queued or running, no publication required recovery, and
no publication attempt had a null finish time.

- `high-performer-hurting-team`, job
  `954d2835-8d2a-41e0-b06e-91582827a045`: failed after 23 of 24 stages because
  proposal assembly treated the uppercase `ADJUDICATOR:` prefix in a retained
  finding link as different from the canonical lowercase role code. The
  case-normalization fix makes this the shortest and safest first review to
  resume.
- `stop-taking-delegated-work-back`, job
  `3ebfc8ba-533f-44e2-acf7-1da4cf02feee`: failed at bundle writer after 18 of
  24 stages because the replacement `description` was returned as plain text
  rather than a JSON string.
- `defensive-about-feedback`, job
  `2c3cb00a-4294-4273-adff-9faa9792289d`: failed at bundle writer after 18 of
  24 stages because the replacement `title` was returned as plain text rather
  than a JSON string.
- `tears-during-difficult-conversation`: its 24-stage review succeeded; the
  later publication was restored as documented below, and its checkout and
  revision-2 draft remain active.
- `dominates-team-meetings`: its 24-stage review succeeded and its checkout
  remains active.

The unreleased candidate now JSON-encodes plain replacements only when the
target is an existing string-valued metadata field; malformed non-string or
unknown metadata still fails closed. A selected historical retry atomically
focuses that same job without replacing its ID, steps, runs, queue time, or
enqueue audit. A different lane owner produces `REVIEW_LANE_BUSY` without
mutating either review.

### Unreleased publication prevention and diagnostics

The 2026-08-01 production publication for
`tears-during-difficult-conversation` (job
`50969dba-d82c-4cc8-92ac-9c1d110c0892`) advanced Leadership from release
`481e9d38-6aef-4c31-81b0-6d8fabd6e8e1` to candidate
`2a923324-6837-495f-b256-12d04932b97d`, received HTTP 503 from content health
during every live probe, and automatically restored the prior release. The
checkout and saved draft remained active. Reproduction against the exact
deployed Leadership commit proved the candidate was deterministically invalid:
its managed `PracticeEmbed` had lost
`variant="emotion-without-diagnosis"`, so it no longer matched the situation
frontmatter. The old Studio release did not run Leadership's complete canonical
snapshot validator before pointer promotion and retained only the generic
`VERIFICATION_FAILED_RESTORED` classification.

Commit `3683021` closes that path before promotion by validating the complete
assembled candidate with the same content contract as Leadership and by
rejecting automatic proposal changes that alter managed `PracticeEmbed` or
`PreparedAction` tags. The current unreleased working candidate additionally
uses a 45-second bounded content-health convergence window, renews the
publication lease and publisher heartbeat on every probe, never accepts a
known-mismatching runtime identity, and renews the Studio lease throughout the
separate Leadership release transaction. It rechecks the exact claim,
checkout, and situation fences both immediately before pointer promotion and
after promotion immediately before commit, so a replacement publisher rolls
the entire Leadership transaction back. It persists only an allowlisted
status, attempt count, elapsed time, and observed identity. When automatic restoration
also has retained runtime-health evidence, the original live-verification
evidence and restoration evidence remain distinct so the workspace can explain
both boundaries without exposing raw responses, URLs, headers, errors, or
stacks. Historical generic jobs remain unchanged because those details were not
retained at the time.

A `RECOVERY_REQUIRED` publication is now a global editorial lock rather than
only a publication-worker fence. The inventory and every workspace remain
inspectable, but new situations, new checkouts, saves, check-ins, review
requests or retries, proposal decisions, restoration or retirement drafts, and
publication requests fail closed until publisher reconciliation verifies a
known Leadership release. The workspace does not claim that the previous
release is live while recovery remains unresolved.

The follow-up deployment path now stops web intake and review execution, waits
for every publication attempt to finish even if its job has already entered a
terminal state, refuses any recovery fence, and then stops the idle publisher.
Before the additive lane migration it captures a content-body-free core state
for every active checkout, draft resume anchor, revision/artifact reference,
review job, step, run, proposal, candidate, and proposal decision. It separately
derives the expected normalized queue timestamps and focused owner from the
pre-migration audit/job facts. After migration it compares both the core
before/after hashes and expected/actual lane hashes and writes an
`active-review-state-continuity-v2` receipt only when both match. Migration,
continuity, local-health, or required public-gate failure restores the exact
previous release and must prove that its local live and ready checks pass; an
unverified rollback is a critical deployment failure.

On 2026-08-02 the product owner explicitly approved the follow-up backup and
deployment packet. Preparation provisioned isolated backup accounts on RP1 and
RP2, the protected RP1 environment and toolchain, source-restricted and
host-key-pinned replication to `/srv/situation-studio-backups` on RP2, and a
destination-side 90-day retention timer that preserves the newest encrypted
object. The three historical queued receipts completed sequentially through
the exact deployed worker. Receipt `b76cb38a-b635-4beb-b665-fb0f679bc751`
attests the newest replicated object and has a passed non-empty restore drill.
The first drill exposed legacy PostgreSQL `set_config` output before the JSON
result; the recorder failed closed, then passed only after the candidate was
hardened to accept that exact known noise while rejecting any other prefix.
The protected web environment is now set to required backup readiness and the
exact queue and nightly schedules are installed. Five active checkouts remained
unchanged and no review, publication, or recovery job was active through this
preparation boundary. The first deployment attempt for release
`20260802T075418Z` safely restored and verified the previous release before any
migration, deployment backup anchor, pointer change, or candidate process
start. The remote `pm2 startup` command had consumed the remaining SSH script
from standard input and returned success; every process-manager invocation is
now detached from the script input, with a contract test covering that exact
boundary. Application cutover was still pending when this candidate evidence
was committed. A second deployment attempt for release `20260802T080758Z`
proved the same failure class was not process-manager-specific: an interactive
Docker client used only to capture the database clock consumed the remaining
`bash -s` input after quiescing the old processes. The stateful program again
ended before a backup anchor, migration, pointer change, or candidate start;
the outer health gate restored and verified the previous release, and the
active review-state hash remained
`649abf47d2247264917ee51a4c213b8222190bb70a218127d030a547a5f4b269`.
Post-extraction remote programs are now fully buffered before they execute, so
every subprocess inherits an exhausted input stream; the clock query also no
longer requests interactive Docker input, and executable contract coverage
proves both properties.

A third guarded attempt for release `20260802T082029Z` then reached the real
post-quiescence backup anchor and failed closed because the new preclaimed
worker passed `psql` variables through `--command`; PostgreSQL received the
literal `:'receipt_id'` syntax because psql does not interpolate variables in
command-string mode. The remote trap fenced the new receipt
`ffc62df5-3784-47d0-918d-95c956a8d593` as
`FAILED/DEPLOYMENT_BACKUP_FAILED`, restarted the previous release, and verified
local live and ready health. No migration, pointer change, or candidate start
occurred, and the active review-state hash remained exact. Parameterized worker
queries now use controlled standard-input SQL. The fast harness rejects
command-string SQL and empty input, while a real PostgreSQL integration drives
both preclaimed and ordinary queue paths through claim, stale recovery, a
deliberate backup failure, and the exact fenced terminal states.

The outer launcher deliberately retained that attempt's deployment lease
because a nonzero SSH result is ambiguous even when the remote rollback reports
success. Read-only recovery reconciliation found no surviving local or remote
deployment shell; the complete mode-0700 lease names commit `50e486b...`,
release `20260802T082029Z`, start `2026-08-02T08:20:31Z`, and operator `admin`,
with token SHA-256
`99347426b46b476b836f407f5a1b4da2ced3a376a8f037e5c8ebe3b7547e0538`.
The current pointer and all three online PM2 processes use the prior
`20260729T085659Z` / `70da5ca...` release; local live and ready probes pass,
publication drain is `0|0|0`, the candidate has neither backup nor continuity
marker, and the active and expected-lane hashes remain
`649abf47d2247264917ee51a4c213b8222190bb70a218127d030a547a5f4b269` and
`5a4adcf161a363be72a662d8ec7ef2c9183bbbd25edabf6d3ac32c734913df82`.
The exact token-fenced lease must be released through the candidate helper only
after explicit operator authorization naming this reconciled state; deployment
must then restart from preflight rather than resume mid-attempt.

The product owner provided that authorization in the continuation task. The
lease metadata and exact token hash were re-read, and the candidate helper
safely released only the two fenced files and lease directory. Full preflight
then passed against clean pushed commit `ee2ab3a...` and the compatible
Leadership runtime.

A fourth guarded attempt, release `20260802T095838Z`, completed its clean local
and remote builds, quiesced Studio, and created verified encrypted off-site
backup receipt `c634ec70-0d15-45e8-9c89-e1a46cfe31d8`. Its immutable
pre-migration marker records 746,270 bytes, review hash `649abf47d...`, and
expected-lane hash `5a4adcf161...`. The focused-lane migration applied
successfully, but continuity failed closed before candidate start or pointer
change: with no running review, the pre-migration query represented every
no-owner Boolean as JSON `null`, while the migrated non-null `lane_owner`
column correctly represented the same state as `false`. Queue timestamps and
the null lane owner otherwise matched. The expected and actual lane hashes
were `5a4adcf161a363be72a662d8ec7ef2c9183bbbd25edabf6d3ac32c734913df82`
and `48f0eb54c66386b108f3c3174e59e0becbf53751cd961c6f9e9673048d4472a8`.

The remote trap restarted and locally verified the exact previous release.
Read-only reconciliation found no surviving deployment shell; the current
pointer and all three processes use `20260729T085659Z`, live and ready return
200, publication drain is `0|0|0`, and the active-review hash remains exact.
The candidate has a complete pre-migration backup marker but no continuity
marker. A complete mode-0700 lease remains for commit `ee2ab3a...`, release
`20260802T095838Z`, start `2026-08-02T09:58:40Z`, and operator `admin`; its
token SHA-256 is
`cb2638b53641196a70dea363c64c421fc283b84af7bc61e2e8020d78da8c6216`.
Do not release it without fresh explicit authorization naming this newer
state, and never resume the attempt midway or remove the lease recursively.

This candidate corrects the representation mismatch by coalescing the nullable
pre-migration focused comparison to Boolean `false` and adds a real-PostgreSQL
empty-lane continuity scenario. It also closes the remaining Operations
transparency gap: recent publisher and backup failures are separated by exact
receipt, typed runtime explanations and allow-listed codes remain visible, raw
or legacy unstructured failure text is suppressed, and backup publication
readiness is reported independently of the newest attempt. A new exact pushed
commit and approval are required before another full preflight and deployment.

The current candidate now enforces that prerequisite rather than relying on
the runbook alone. Follow-up deployment preflight requires the dedicated backup
user and protected environment, exact queue/nightly schedules, mandatory
off-host configuration, and a committed read-only database proof of a recent
encrypted backup with receipt-bound off-site replication plus a passed restore
drill before it creates a release. The direct query remains compatible with the
currently deployed release's deferred/older health shape. Publication
submission independently checks the same complete receipt fields and off-site
attestation, a maximum 26-hour backup age, materially future timestamps, and the
latest recorded restore-drill result inside the same serializable transaction
that would create the publication job. If the proof is absent, editing and
review remain available, the submit control shows the safe reason, and no
publication or audit mutation occurs.

The deployed worker predates the new destination marker even though its backup
command already verifies off-site replication. The first follow-up therefore
uses the reviewed `ops/attest-legacy-offsite-backup.sh` transition after a real
legacy receipt exists: it live-verifies the exact configured remote object and
appends an attested receipt while preserving the original verification time.
Deployment also recomputes that destination binding, rechecks the remote
checksum/length, and requires candidate `web.env` to use backup readiness mode
`required`. Missing `current` is not treated as a first deploy when immutable
release history remains. A genuine first deployment now separately proves
candidate `web.env` is explicitly `deferred` before creating any release.
Backup processing is single-flight and time-bounded, recovers abandoned
`RUNNING` claims through a fenced failure, and requires an exact-one fenced
success update. Before inspecting or claiming work, both the queue runner and
follow-up deployment require the source and receipt URLs to normalize to the
same single unambiguous host, port, and `situation_studio` database. Follow-up
deployment also holds a token-fenced atomic host lease through rollback and,
after quiescing all application processes, preclaims an exact backup receipt
whose append-only audit anchor contains the approved release and review-state
hashes. Migration cannot start until that receipt is newly encrypted,
off-site verified against the preflight-frozen destinations and resolved key
fingerprint, and the exact artifact decrypts to a readable PostgreSQL custom
archive while the review projections remain unchanged across the dump. The
configuration fence is checked before the preclaimed worker can transition the
receipt. Once stateful cutover starts, signals, lost SSH acknowledgements, or
unverified rollback retain the deployment lease for explicit recovery instead
of allowing another deployment to compound ambiguous state. Restore results are recorded
through the exact complete receipt only after current local and configured
remote checksum/length verification, and an empty restored production dataset
is rejected;
the shared policy rejects drills older than 30 days, earlier than their receipt,
or materially in the future. The deferred-release bootstrap uses a separately
approved SHA-256 of the candidate recorder, verifies those bytes twice, invokes
only the immutable current release's restore script, and emits both identities
with the receipt result for the approval packet.

The retry-provider implementation now:

- automatically retries only explicitly retryable provider failures, with
  durable 5-second and 30-second schedules and three total stage attempts;
- preserves successful stages and every immutable `AgentRun`, including
  bounded safe provider-attempt timing/outcome metadata;
- releases the global running slot during backoff while retaining claim,
  checkout, cancellation, fence, restart, lease, and serialization behavior;
- appends bounded system-attributed retry audits;
- keeps exhaustion and all non-retryable classes terminal with the existing
  manual **Retry review** action; and
- ages historical provider failures out of the current readiness signal.

The real-time status follow-up adds an authenticated, same-origin Node-runtime
SSE endpoint at `/api/reviews/[id]/events`. Every connection and native
reconnection receives a complete runtime-validated `review-status-v1` snapshot
from PostgreSQL. The endpoint checks the compact projection every 1.5 seconds,
emits only when the deterministic safe snapshot changes, sends 15-second
heartbeat comments, closes at terminal state, and has a two-minute bounded
lifetime that forces fresh authentication and state.

The workspace connects only for `QUEUED` and `RUNNING`, rejects old-review and
superseded-connection events, updates exact progress and the human-readable
stage without reload, presents durable retry countdowns, and refreshes
server-rendered data once after terminal state. Motion is restrained, stops on
failure/cancellation, and is removed by `prefers-reduced-motion`; exact text,
semantic progress, and throttled polite announcements remain available.

The public event includes no content, prompt, evidence, provider output, raw
error, secret, log, lease, checkout fence, or claim token. SSE adds no
migration, database grant, mutation, or CSRF exception. The only schema
migration in this follow-up is the retry-backoff migration.

## Verification state

- Studio unit, integration, publisher lifecycle, crash recovery, type, and
  browser/accessibility suites pass.
- The current local gate passes formatting, lint, typecheck, 140 unit tests, 16
  cross-database integration scenarios, a strict post-build secret scan, and
  an optimized production build.
- The browser suite covers 1280×800, 1440×900, and 390×844; all 10 executed
  scenarios pass and 8 duplicate state-mutating scenarios are intentionally
  skipped.
- The 22 focused review-status tests pass five consecutive repetitions, and the
  seven-scenario review-worker integration file passes three consecutive
  disposable-PostgreSQL repetitions.
- Leadership migration parity and integration suites pass against a
  production-shaped fixture: 32 artifacts, 99 edges, 15 situations, 3 guides,
  and 3 practices.
- A queued encrypted Studio backup persisted a verified database receipt. A
  streamed restore drill recovered all 6 migrations, 15 situations, 15
  production versions, 16 content blobs, and 84 audit events without writing a
  plaintext dump.
- A disposable PostgreSQL 16 rehearsal created the Studio owner and database,
  applied all 6 Studio migrations, granted the 5 runtime roles, injected
  generated passwords through the environment, and proved each restricted role
  could log in with its intended access.
- Leadership's complete production gate passed: database validation, lint,
  typecheck, 38 unit tests, 13 integration tests, and 70 cross-browser
  database/rendering checks with 18 intentional platform-scope skips.
- The deterministic 22-stage route and the production-shaped Codex subscription
  wrapper were qualified for the release. Codex is primary, Claude is fallback,
  child environments exclude application secrets, and secret-shaped model
  output is rejected.

See [docs/checkpoints/07-operations-and-release-candidate.md](docs/checkpoints/07-operations-and-release-candidate.md)
and [docs/checkpoints/independent-review.md](docs/checkpoints/independent-review.md)
for the release evidence and dispositions. The current local gates above were
rerun for the combined retry and real-time status work.

## Pre-deployment production boundary

Before the follow-up deployment, production ran on `rpi1` under root-owned
PM2:

- `situation-studio-web`
- `situation-studio-review-worker`
- `situation-studio-publisher`

PostgreSQL runs there in the `postgres16` Docker container. During the original
incident inspection, `/health/live` responded successfully and
`/health/ready` returned 503 because the review-worker heartbeat mapped the
latest historical `TRANSIENT` review failure to `PROVIDER_UNAVAILABLE`; this
was not a dead worker or database failure. The later pre-deployment inspection
on 2026-07-25 found both endpoints healthy.

The user explicitly deferred backup configuration for the initial launch on
2026-07-24. Production readiness reports `backup.state = "deferred"` rather
than fabricating a receipt. Backup configuration becomes required again before
any content-publication approval, and the current candidate now enforces that
requirement in both publication submission and follow-up deployment preflight.
