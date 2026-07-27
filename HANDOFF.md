# Situation Studio handoff

Last updated: 2026-07-27

## Outcome

Situation Studio is deployed on `rpi1` from the immutable release at
`/home/admin/projects/situation-studio/releases/20260727T171556Z`. The deployed
source is commit `b422f4384f1edd71e329a3524f8bff97a33b2960` on `main`. The
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
any content-publication approval.
