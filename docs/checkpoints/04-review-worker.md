# Checkpoint 4 — Bounded review worker and proposals

Status: four-phase review, exact candidate validation, bounded repair, durable
provider retry, and legacy-job compatibility complete.

New reviews use one durable four-stage workflow:

1. **Context Mapper** maps the pinned situation, its teaching surfaces, linked
   evidence, and concrete evidence gaps.
2. **Critical Review** performs one integrated pass across the packaged
   leadership frameworks and reconciles their tradeoffs in the same response.
3. **Candidate Builder** emits typed findings and declarative change intents.
4. **Candidate Audit** evaluates the exact server-materialized candidate and
   returns a typed `PASS` or `REVISE` verdict with blocking-finding references.

The old specialist, issue-register, rebuttal, adjudication, teaching-designer,
and LLM deterministic-validator stages are not created for new jobs. A rolling
upgrade may still finish already-persisted 22- or 24-stage jobs only when their
pinned input is already a valid v2 snapshot. For such a job, the retained
deterministic-validator role runs local deterministic validation without
calling a model. Retained v1 drafts must first create and adopt a fenced v2
action checkpoint and start a new review; direct v1 API and worker ingress fail
closed.

Jobs pin an immutable input revision ID and bundle hash. Editing may continue
in a later revision while review runs; it does not change the reviewed bytes.
If the draft advances before proposal creation, the proposal remains pinned to
the reviewed input and is created explicitly superseded, naming the newer
revision. Proposal commands must present an exact revision ID and bundle hash,
and successful application returns the authoritative resulting revision.

## Server-owned candidate semantics

Models do not author durable IDs, before hashes, application modes, writer
identity, or executable patch operations. The Candidate Builder emits only
typed change intents with a target, proposed body, explanation, rationale,
upstream finding references, and evidence roles. The worker then:

- generates stable UUIDs from the pinned revision and intent position;
- resolves each target against the exact candidate bytes;
- derives the actual before body and hash;
- chooses the application mode from server policy;
- applies supported changes incrementally through the shared situation bundle
  validator; and
- validates the complete candidate again before audit and proposal creation.

Section and supported metadata replacements may be automatic when their exact
target exists. Broad bundle and embed requests are manual. Global relationship
changes are manual because review intent does not contain the complete linked
artifact identity; already-complete canonical relationship snapshots remain
publishable. New publishable-v2 scoped-variant requests are also manual because
the legacy variant patch does not contain the complete publishable artifact identity.
Those suggestions remain visible for editor judgment and cannot become
automatic proposal changes.

A malformed or overlapping intent is isolated when its failure is safely local
to that suggestion. Valid sibling intents still materialize, and each discarded
intent becomes an important, non-actionable proposal finding explaining why it
was retained without an executable change. A failure of the exact candidate as
a whole remains terminal.

The Candidate Audit receives the complete materialized body, bundle, candidate
hash, server-derived changes, and discarded intents. It must echo the exact
candidate hash. `PASS` cannot contain or reference a blocking finding. `REVISE`
must reference real blocking findings. The worker permits one repair by
rerunning Candidate Builder and Candidate Audit with the first audit in the
repair evidence. A second `REVISE`, an audit of another candidate hash, or an
invalid blocking reference prevents proposal creation and fails the review.

## Deadlines, retries, and the global lane

Each model stage receives at most 90 seconds, further bounded by the remaining
eight-minute total job deadline. Hitting the total deadline is a terminal
`REVIEW_JOB_DEADLINE_EXCEEDED` failure. Terminal failures clear the claim and
release the global lane immediately, so an unrelated queued review can run.

Only an `AdapterFailure` explicitly marked retryable is automatically retried.
A stage receives three total automatic attempts. Failures after attempts one
and two return the job to `QUEUED`, keep the failed stage as the first ready
incomplete stage, and persist a five-second or 30-second `retry_not_before`
timestamp. The focused job retains the one-global-review lane during this short
backoff so later work cannot jump ahead of it. A restart cannot bypass the
durable retry time.

Succeeded stages are never reset for provider retries. Each retry appends a new
`AgentRun`; the prior run retains its safe failure class, retryability, and at
most two provider-attempt records containing provider, model, bounded duration,
safe outcome, and safe failure class. Provider stdout, stderr, error messages,
and credentials are not retained. Each scheduled retry appends a
system-attributed `REVIEW_AUTOMATIC_RETRY_SCHEDULED` audit event. Attempt-three
exhaustion and non-retryable failures remain terminal and leave the existing
editor-triggered **Retry review** action available.

Pinned subscription CLIs remain the production adapters: Codex first and
Claude fallback. Strict schemas record requested and resolved provider/model,
reasoning effort, evidence and output hashes, structured output, usage, and
failure classification. Child processes receive no Studio database, session,
publisher, backup, or Leadership credentials. Review execution no longer
depends on live Leadership runtime capability checks; those checks belong to
publication preflight.

## Real-time workspace status

Review progress uses authenticated, same-origin Server-Sent Events at
`/api/reviews/[id]/events`. The Node route is GET-only and responds with
`text/event-stream`, private no-store cache controls, and disabled proxy
buffering. It sends a complete snapshot on connection, emits only when the
deterministic projection changes, uses comments as heartbeats, and closes after
a terminal state or the bounded stream lifetime. Review durability, leases,
cancellation, retries, and serialization do not depend on the browser
connection.

The current `review-status-v4` snapshot reports four stages. Its parser also
accepts retained 22- and 24-stage snapshots during rolling upgrades. The safe
projection includes the review ID and state, exact completed and total counts,
ordered stage entries, current or first incomplete stage, bounded retry state,
safe terminal failure metadata, proposal readiness, lane ownership, and a
deterministic snapshot identity. It excludes content, prompts, evidence,
provider output, raw failure text, credentials, claim tokens, leases, checkout
fences, and audit payloads.

The client reducer rejects another review ID or an older connection generation.
A terminal snapshot causes one refresh so proposal content and authoritative
revision state come from the server render. Reduced-motion preferences remove
review animation while preserving text, exact counts, the progressbar, retry
schedule, and controls.

## Requirement traceability

| Requirement                            | Implementation                                          | Deterministic evidence                                                          |
| -------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Three-to-five bounded phases           | Four explicit roles in `packages/domain`                | exact four-role DAG unit and integration assertions                             |
| Typed findings and constrained intents | strict adapter schemas                                  | rejection of model-authored IDs, modes, and hashes                              |
| Server-owned patch semantics           | review-worker materialization                           | stable IDs, derived modes/hashes, granular-target tests                         |
| Exact shared validation seam           | incremental and final candidate validation              | publishable-v2 preservation and injected validation tests                       |
| Typed blocking audit gate              | candidate-audit schema and worker gate                  | one-repair success and second-`REVISE` terminal scenarios                       |
| Isolate malformed suggestions          | per-intent materialization boundary                     | malformed, missing-lineage, overlap, and named-block tests                      |
| Exact proposal fencing                 | pinned input and current revision/hash fields           | edit-during-review and superseded-proposal integration tests                    |
| Terminal lane release                  | terminal worker state transition                        | unrelated review claimed immediately after blocking failure                     |
| Stage and total deadlines              | 90-second stage / eight-minute job budgets              | timeout recovery and no-next-stage deadline scenario                            |
| Durable provider retry                 | retained attempt history and backoff                    | restart, exhaustion, non-retryable, fencing, and lease tests                    |
| Rolling compatibility                  | retained v2 legacy role recognition and local validator | legacy prompt/output paths and 22/24-stage status parsing; v1 ingress rejection |
| Safe live progress                     | `review-status-v4` SSE projection                       | status contract, reducer, and stream unit tests                                 |

## Known limitations

The final audit is still a model judgment, although the server enforces its
typed verdict, exact candidate identity, blocker references, and one-repair
limit. Deterministic compilation and validation remain the authoritative gate.

Global relationship and new publishable-v2 scoped-variant review suggestions
are intentionally manual until review intents can carry their complete linked
artifact bytes, paths, media types, and edge identities. Already-complete
canonical relationship, scoped guide, and scoped practice snapshots remain
publishable through the shared compiler. The review limit is a safe disabled
capability, not a hidden publisher fallback.

Provider diagnostics deliberately retain no stdout, stderr, provider error
message, or active synthetic probe. Readiness therefore reflects worker
liveness plus recent safe provider results. The SSE implementation performs a
compact periodic projection query per connected workspace; before broad
multi-tenant use it should move to shared invalidation while retaining a full
authoritative snapshot on every connection.
