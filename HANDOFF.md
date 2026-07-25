# Situation Studio handoff

Last updated: 2026-07-25

## Outcome

Before the 2026-07-25 follow-up deployment, Situation Studio was deployed on
`rpi1` from the immutable release created at
`/home/admin/projects/situation-studio/releases/20260725T124500Z`.
The workbench now provides ordinary username/password authentication, durable
exclusive checkouts, immutable drafts and history, section and raw-MDX editing,
rendered preview and exact diff, optional durable agent review, selective
proposal application, new-situation creation, reversible retirement,
per-situation restoration, and one-action publication.

This release candidate includes the completed retry-provider and real-time
review-status follow-ups described below.

Publication builds a complete immutable Leadership release, advances the
official pointer with an expected-generation fence, verifies both database and
runtime identities, and automatically restores the prior release if
post-promotion verification fails. Injected process-death tests prove restart
reconciliation after candidate persistence, pointer promotion, and runtime
verification.

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
