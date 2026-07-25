# Checkpoint 4 — Review worker and proposals

Status: deterministic route, live subscription route, and durable automatic
retry handling complete.

The review worker implements the full durable 22-stage DAG with one global
running job and FIFO claiming. Jobs pin an immutable input revision and remain
read-only while queued or running. Cancellation and force-check-in fence late
work. Retry resumes at the first incomplete stage.

Pinned subscription CLIs are the production adapters: Codex first and Claude
fallback. They parse output through strict schemas and record
requested/resolved provider, model, reasoning effort, evidence/output hashes,
structured output, token usage, and failure classification. Child processes
receive no Studio database, session, publisher, backup, or Leadership
credentials. Claude tools are disabled. Codex ignores user/project
configuration and rules, runs ephemerally in a temporary read-only sandbox,
and receives a stripped tool-command environment.

Deterministic integration tests execute all 22 stages in order and prove
durable evidence, one global runner, cancellation, proposal isolation, and
idempotent retries. Adapter tests prove Codex-first ordering, Claude fallback,
secret-minimal child environments, strict output validation, and rejection of
secret-shaped output. A live Codex wrapper smoke used ChatGPT subscription
authentication with `gpt-5.6-sol` and returned valid structured output. The
production review user has authenticated Codex and Claude subscription
sessions.

## Automatic provider retry

Only an `AdapterFailure` explicitly marked retryable is automatically retried.
A stage receives three total automatic attempts. Failures after attempts one
and two return the job to `QUEUED`, keep the failed stage as the first ready
incomplete stage, and persist a 5-second or 30-second `retry_not_before`
timestamp. Claims filter on that timestamp, so a restart cannot bypass the
backoff. The job releases its lease and the one-global-runner slot while it
waits.

Succeeded stages are never reset. Each retry appends a new `AgentRun`; the
prior run retains its safe failure class, retryability, and at most two
provider-attempt records containing provider, model, bounded duration, safe
outcome, and safe failure class. Provider stdout, stderr, error messages, and
credentials are not retained. Each schedule appends a system-attributed
`REVIEW_AUTOMATIC_RETRY_SCHEDULED` audit with the stage, safe class, attempt,
maximum attempts, and scheduled time.

Authentication, application, cancellation, unsafe-output, and every other
non-retryable failure remain terminal. Attempt-three exhaustion also remains
terminal and leaves the existing editor-triggered **Retry review** action
available.

The workspace renders `RETRYING` with the stage, safe failure class, attempt
count, and scheduled time. Readiness treats a terminal provider result as a
recent availability signal for five minutes; an old retained failure no longer
causes a healthy worker heartbeat to report provider unavailability forever.

## Real-time workspace status

Review progress uses authenticated, same-origin Server-Sent Events rather than
Next.js `_rsc` requests or repeated `router.refresh()` calls. The Node route
`/api/reviews/[id]/events` is GET-only and has no mutation or CSRF exception.
It responds with `text/event-stream`,
`Cache-Control: private, no-cache, no-store, no-transform`, and
`X-Accel-Buffering: no`.

The connection lifecycle is:

1. An active `QUEUED` or `RUNNING` review creates one native `EventSource`.
2. The server authenticates the existing session and sends a complete
   `review-status-v1` snapshot, regardless of `Last-Event-ID`.
3. A bounded 1.5-second database projection check emits only when the safe
   deterministic snapshot changes; 15-second comments provide heartbeats.
4. A dropped connection shows **Reconnecting…** while native reconnection uses
   a three-second server-advertised delay. The worker, lease, cancellation
   fence, global serialization, and durable retry schedule do not depend on the
   browser connection.
5. A terminal snapshot closes the stream and causes one client refresh so
   proposal content and controls come from the ordinary server render. An
   active stream also closes after two minutes to force a fresh authenticated
   snapshot.
6. Component unmount, request abort, reader cancellation, database failure, and
   stream expiry clear every timer. Database and schema errors close with only
   a generic comment so native reconnection can recover.

The safe snapshot contains the schema version, review job ID, job state, exact
completed and total stage counts, all 22 ordinal/state rail entries, the current
or first incomplete stage with a display name and applicable attempt, bounded
retry state and scheduled time, terminal state and safe failure class, proposal
readiness, and a deterministic SHA-256 snapshot identity. It deliberately
excludes review content, prompts, evidence, structured provider output, raw
failure text, credentials, stdout/stderr, claim tokens, leases, checkout
fences, and audit payloads.

The client reducer rejects a snapshot for another review ID or an earlier local
connection generation. Stage and progress updates do not alter editor,
autosave, checkout, or proposal state. The rail transitions completed stages
with a restrained color/scale transition, applies a slow traveling highlight
only to the active stage, and uses one calm activity pulse during active work.
Failure and cancellation stop motion. `prefers-reduced-motion` removes all
review animations while preserving text, exact counts, the semantic
progressbar, retry schedule, and controls. One `aria-live="polite"` region
announces meaningful changes at most every five seconds, except important
retry and terminal transitions; heartbeats and visual countdown ticks are not
announced.

## Requirement traceability

| Requirement                                  | Implementation                                                | Deterministic evidence                                                    |
| -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Explicit retryability and three attempts     | `apps/review-worker/src/review.ts`                            | timeout recovery, exhaustion, and non-retryable integration scenarios     |
| Durable backoff and restart safety           | `review_jobs.retry_not_before` plus due-only claim            | pre-due rejection and post-due reclaim in review integration              |
| Preserve stages and attempt history          | `ReviewStep` aggregate state plus append-only attempt numbers | successful-stage and immutable-run assertions                             |
| Cancellation, fencing, leases, serialization | fenced claim token and existing partial unique indexes        | cancellation/backoff, force-check-in/backoff, and expired-lease scenarios |
| Safe retry audit                             | worker insert-only audit authority and bounded payload        | system attribution and exact safe payload assertion                       |
| Provider diagnostics                         | bounded `agent_runs.provider_attempts` JSON                   | adapter double-timeout and persisted metadata assertions                  |
| Retry UI                                     | workspace retry projection and status card                    | retry presentation unit test and browser/accessibility scenario           |
| Readiness recovery                           | time-bounded provider-failure health signal                   | old-terminal-failure status test                                          |
| Authenticated initial/reconnect snapshot     | review status route and stream lifecycle                      | auth rejection, initial event, and `Last-Event-ID` reconnect tests        |
| Changed-only events and cleanup              | deterministic snapshot ID plus bounded timers                 | unchanged projection, heartbeat, abort, cancel, and DB-error tests        |
| Live progress without reload                 | runtime-validated EventSource reducer                         | direct disposable-database browser advancement scenario                   |
| Stale event rejection and terminal refresh   | review ID plus connection generation and refresh fence        | reducer terminal/stale tests and browser proposal-load scenario           |
| Motion and accessible status                 | review progress presentation and reduced-motion CSS           | countdown/announcement unit tests plus reduced-motion Axe browser check   |

## Known limitations

Provider diagnostics deliberately retain no stdout, stderr, provider error
message, or active provider probe. They can distinguish provider order,
duration, timeout, safe class, and fallback outcome, but deeper upstream
diagnosis still requires provider-side telemetry. Readiness therefore reflects
worker liveness plus a five-minute recent-result signal, not a synthetic call
to either subscription provider.

The SSE implementation intentionally performs one compact PostgreSQL query per
active browser connection every 1.5 seconds. It does not hold a database
connection between checks and is appropriate for this small private workbench,
but query load grows linearly at roughly 0.67 queries per second per connected
workspace. Before broad multi-tenant use, replace the per-connection check with
a shared process broadcaster or PostgreSQL `LISTEN`/`NOTIFY` invalidation while
retaining a full authoritative snapshot on every connect.

Authentication is evaluated when each bounded stream opens. A session revoked
from another browser can therefore retain access to this small, non-content
status projection until the connection closes, for no more than two minutes;
logout and workspace navigation close it immediately. A future shared
broadcaster should also add explicit session-revocation fan-out if that window
is no longer acceptable.
