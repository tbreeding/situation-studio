# Situation Studio architecture

Situation Studio is a three-process editorial workbench backed by an
independent PostgreSQL database named `situation_studio`. The separate
`leadership_field_guide` database remains the only public content authority.

```mermaid
flowchart LR
  Browser["Authenticated editor"] --> Web["Studio web"]
  Web --> Studio[("situation_studio")]
  Review["Review worker"] --> Studio
  Review --> Providers["Codex CLI → Claude CLI fallback"]
  Publisher["Publisher"] --> Studio
  Observer["SELECT-only observer"] --> Leadership[("leadership_field_guide")]
  Publisher --> Leadership
  Leadership --> Runtime["Leadership runtime"]
```

## Authority and credentials

| Process            | Studio authority                                               | Leadership authority                                             | Other secrets           |
| ------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| Web                | accounts, sessions, drafts, checkouts, preflight, user actions | SELECT-only compilation base                                     | session, CSRF, throttle |
| Review worker      | review queue, runs, evidence, proposals                        | none                                                             | isolated CLI auth state |
| Publisher          | publication jobs, receipts, production history                 | SELECT plus restricted append/validate/promote/restore functions | Leadership health URL   |
| Observer/bootstrap | imported observations and history                              | SELECT only                                                      | none                    |

Production startup uses a clean environment for each process and sources one
mode-0400/0600 file. Subscription CLI auth is owned by the dedicated review
user; it cannot reach the publisher. Leadership publisher credentials cannot
reach the web or review worker.

## Data and lifecycle

Content bodies are canonicalized and addressed by SHA-256. Draft revisions,
review evidence, production occurrences, publication events, verification
receipts, and audit events are append-only. Production occurrences may refer to
the same content hash—such as a restoration—but are unique per Leadership
release observation, preserving forward history and provenance while content
blobs remain deduplicated.

Only one active checkout can exist per situation. Every mutation supplies the
checkout ID and monotonically increasing fence. Checkouts never time out.
Force-check-in releases ownership, records the resulting draft hash, cancels
review work, and makes late results fail their fence.

The visible status is derived from facts (`Available`, `Draft saved`, `Checked
out by …`, or `Retired`) plus temporary activity. There is no editorial state
machine, approval queue, staging site, or candidate runtime.

### Authoritative publishable snapshot

Every newly written canonical revision uses `situation-bundle-v2`, whose hash
includes the complete Leadership-owned publication input: all frontmatter fields, authored
practice ID and variant, field-note and safety-note flags, review status,
source and related-situation references, exact MDX body hash, parsed managed
component properties, complete relationship bindings, scoped artifact
descriptors and provenance, visibility, and promotion intent. Scoped artifact
bodies are content-addressed in Studio and must match every descriptor before a
revision is accepted.

Studio never fills a missing field from whichever Leadership release happens
to be current. A retained v1 draft is upgraded from its pinned production base
through a fenced save before either ordinary editing or **Run agent review**
continues, and the client adopts the exact returned v2 revision and hash.
Direct v1 review API or worker ingress fails closed. Older v2 drafts with
`UNPUBLISHED` intent require the editor's explicit **Set public intent**
action, which creates a fenced forward revision and an audit event; immutable
history is not rewritten.

The pure `@leadership-field-guide/content-contracts` validator is the common
gate after Studio saves, review candidate construction, and proposal
application. Publication preflight and the publisher use the same package's
compiler, which invokes that validator. Managed `PracticeEmbed` and
`PreparedAction` properties are parsed through MDX AST traversal and must agree
with the structured snapshot before an invalid candidate can become
actionable.

### Runtime capability integrity

Leadership's capability digest covers the complete JSON capability object
except `capabilityDigest` itself. Both repositories recursively sort object
keys with the shared canonical JSON helper, preserve array order, serialize
with `JSON.stringify`, append one canonical newline, and hash the resulting
UTF-8 bytes. The HTTP response body is ordinary compact JSON without that
canonical newline; transport headers and chunk framing are not digest inputs.

Studio's response schema preserves additive fields at every object boundary
before recomputing the digest. Required contract identities and features are
still checked independently and exactly. This prevents schema coercion from
misreporting a valid producer digest while continuing to reject missing,
malformed, incompatible, or genuinely mismatched capability data. Readiness
reports an allow-listed Leadership incompatibility separately from a failed
Studio database query, and both conditions remain fail-closed with HTTP 503.

## Review

The review worker claims one global job with `FOR UPDATE SKIP LOCKED` and
persists four bounded phases: context mapping, integrated critical review,
candidate construction, and exact candidate audit. Models emit typed findings
and constrained change intents. The server derives durable IDs, hashes,
application modes, before-values, and executable patches, then materializes and
validates the exact candidate. The audit returns typed `PASS` or `REVISE`, must
account for every unresolved upstream blocker, and receives at most one repair
and revalidation pass.
Every run records requested and resolved provider/model/effort, evidence and
output hashes, strict structured output, usage, and failure classification.
Codex is preferred and Claude is the provider-scoped fallback. Proposals never
alter a draft until the editor accepts a change.

Section and supported metadata changes may be automatic. Global relationship
rebinding and every new v2 scoped-variant suggestion are manual-only because
the review intent cannot carry the complete linked artifact identity. This is
separate from publication support for already-complete scoped guide and
practice snapshots. A malformed local intent is downgraded to a visible
non-actionable finding when it can be safely isolated; a whole-candidate
contract failure remains terminal.

Review substance comes from a committed, hash-versioned snapshot of the
`review-leadership-situations` skill in `packages/review-policy/policy`.
`pnpm review-policy:sync` refreshes that snapshot from the authored local skill;
`pnpm review-policy:check` verifies every packaged file and detects source drift
when the authored skill is available. Production uses only the committed
snapshot, and each review job pins its exact review-policy version.

An explicitly retryable provider failure returns the job to `QUEUED` at its
first incomplete stage for two bounded automatic retries. The persisted
not-before timestamp survives worker restarts. A durable focused-lane marker
keeps that review ahead of every later job during backoff. A terminal failure
also retains the lane until the editor retries the review, stops it, or closes
the checkout. Retrying a historical failed review atomically makes that exact
retained job the lane owner; a different existing owner produces a conflict
instead of silently queueing the selected retry. Every attempt remains an
immutable `AgentRun`, including bounded
per-provider duration, safe outcome, and failure-class metadata. System failure
and retry audits contain bounded reason codes, stage and phase details, and no
provider output or raw error text.

### Live review status

The authenticated workspace opens
`GET /api/reviews/:reviewJobId/events` only while its displayed review is
`QUEUED` or `RUNNING`. This Node-runtime route is a read-only, same-origin
Server-Sent Events stream. It uses the ordinary session cookie and does not
change mutation CSRF handling.

PostgreSQL remains authoritative. A connection receives one complete
`review-status-v4` snapshot immediately, including the job state, exact
completed/total counts, the four bounded stage states, a safe human-readable
current stage, attempt and durable retry information when applicable, a fixed
safe explanation of the latest failure, terminal state, proposal readiness,
lane ownership, and a deterministic SHA-256 snapshot identity. Retained 22- and
24-stage jobs remain readable during the rolling compatibility window.
The public Zod schema rejects unknown structure at runtime. It cannot contain
prompts, evidence, provider output, raw errors, secrets, logs, lease claims, or
fencing tokens.

The route queries the compact status projection every 1.5 seconds and emits a
new event only when the deterministic safe snapshot identity changes. A
15-second comment heartbeat keeps an idle provider call visible to
intermediaries without causing a client update. A terminal snapshot closes the
stream. Non-terminal streams also close after two minutes so native
`EventSource` reconnects with a fresh authenticated request and another full
snapshot; `Last-Event-ID` is never treated as state. Request abort, response
cancellation, missing jobs, validation failures, and database errors clear
timers and stop the stream without exposing the underlying error.

The browser keys every event to both the displayed review ID and a local
connection generation, so an old review or superseded connection cannot update
the workspace. A disconnect shows a quiet reconnecting state while the durable
worker continues independently. Terminal state schedules exactly one server
refresh, after a short reduced-motion-aware completion transition, to load the
full proposal and authoritative controls. Heartbeats and countdown ticks do not
enter the polite live region.

## Revision, proposal, and publication fencing

Every save names the expected parent revision ID and bundle hash. PostgreSQL
serializable transactions and a compare-and-swap fence permit only one of two
overlapping saves to advance. Review pins an immutable input revision while the
editor may create later revisions. Proposal decisions name the proposal's
current revision/hash, atomically apply selected executable changes, return the
new authoritative bundle/body/revision, and mark older proposals explicitly
superseded. The client adopts that returned state and preserves unsaved local
text behind an explicit conflict instead of allowing a router refresh to erase
it.

Proposal application, preflight, and publication requests temporarily disable
editing so their client-side payload cannot drift. Publication never selects a
"latest" revision at worker execution time.

## Publication preflight and recovery

Before showing the final confirmation, the web process rereads the exact saved
revision and the current Leadership base, compiles the full successor release,
and rereads both identities before committing an immutable, one-way-sealed
preflight receipt. The receipt pins the revision and bundle hashes, complete
candidate and manifest hashes, Leadership release and pointer generation,
compiler identity/digest, typed validation result and diagnostics, complete
compiled projection, affected-route expectations, and every candidate artifact
byte string. Database triggers reject incomplete sealing, later receipt or
artifact mutation, and any publication job whose identity differs from its
sealed receipt.

The confirmation says **Validation passed** and exposes the complete compiled
projection, including managed components, relationships, scoped artifacts, and
promotion intent. Editing or a Leadership base change invalidates the receipt;
a rebase always creates new candidate and receipt identities.

The publisher:

1. consumes only the sealed receipt and independently recompiles its exact
   revision plus scoped evidence against the pinned base;
2. proves the recompiled artifacts, projection, routes, and every candidate
   hash are byte-for-byte equal to the receipt;
3. persists the exact sealed candidate snapshot without normalization or
   hidden defaults;
4. inserts, validates, and promotes one complete immutable Leadership release
   inside an expected-generation transaction;
5. verifies the database, runtime capability identity, and typed no-store
   affected-route endpoint with bounded convergence retries; and
6. records verification, production history, terminal events, draft archival,
   and checkout release through one claim-fenced idempotent finalization
   boundary.

Retries reconcile by Studio publication ID, Leadership release ID, manifest
hash, candidate hash, and pointer generation. After a possibly committed
promotion error, the publisher reloads durable Leadership state before choosing
recovery. Transient capability, health, and typed-route convergence failures
receive bounded retries. Definitive content or render mismatches restore and
verify the prior full release immediately; failed restoration sets the global
`RECOVERY_REQUIRED` fence. Once runtime verification has succeeded, a later
Studio finalization interruption is resumed forward and never restores the
verified release. While the recovery fence exists, Studio allows inspection of
saved work but rejects new situations, new checkouts, and editorial mutations
across every workspace until publisher reconciliation verifies a known
Leadership release.

Before a reclaimed job starts another attempt, the publisher transactionally
marks any preserved unfinished attempt `PUBLISHER_PROCESS_INTERRUPTED` and then
creates the next numbered attempt. Connection setup is inside the same managed
failure boundary. Once promotion has been attempted, any error before the
candidate identity is authoritatively observed reloads the Studio job and
enters `RECOVERY_REQUIRED`; a lost Leadership commit acknowledgement can never
be downgraded to an ordinary terminal failure.

Publication claims and recovery-fence transitions share one PostgreSQL advisory
transaction lock, and only one unexpired publication owner can run globally.
Every authoritative transition compares the attempt's claim token and expected
state; a lease-lost worker exits without changing Studio or restoring
Leadership. While the separate Leadership release transaction assembles and
validates a candidate, a bounded heartbeat renews the Studio lease. The exact
claim, checkout, and situation fences are rechecked inside that transaction
immediately before pointer promotion and again immediately before commit; any
replacement claim rolls the Leadership transaction back. Success commits the
production occurrence, receipt, checkout and draft changes, terminal events,
and attempt evidence in one Studio transaction.
If that commit acknowledgement is lost, the publisher reloads the matching
receipt and keeps the candidate live. Automatic restoration first enters the
global recovery fence, so a crash after restoring Leadership is reconciled
instead of re-promoting the failed candidate.

Terminal events retain only a strictly bounded health source, reason, status,
attempt count, elapsed time, and observed immutable identity for the
editor-facing explanation. A `RECOVERY_REQUIRED` event keeps the original
live-verification detail separate from any retained automatic-restoration
failure detail and does not assert which release is live. Raw responses, URLs,
errors, headers, and stacks are never projected.

The read-only Leadership observer uses the same publication fence. It discards
an external snapshot if a publication is active, requires recovery, or starts
while that snapshot is being read, so an unverified or stale release cannot be
recorded as Studio production history.

New drafts begin with explicit `PUBLIC` publication intent but remain
`UNPUBLISHED` as Studio inventory facts until a verified release succeeds.
Retirement retains content but marks the release-scoped typed situation
`RETIRED`, removes promotion output, and relies on Leadership’s public
visibility filters. Restoration copies one historical situation bundle into a
new draft but publishes it over the newest complete release, leaving unrelated
content unchanged.

## Operations

Encrypted backups use custom-format `pg_dump`, GPG recipient encryption,
SHA-256 receipts, mode-0600 storage, and a disposable-database restore drill.
Health surfaces expose liveness, database readiness, queue state, process
heartbeats, backup age, and recovery fencing without exposing secrets or
internal publication steps to editors.

Publication requests recheck, inside their serializable transaction, that the
latest verified backup is complete, encrypted, carries a receipt-bound
attestation of checksum-verified off-site replication, is no more than 26 hours
old, and is paired with a restore drill on that exact complete receipt that
passed no more than 30 days ago and no earlier than the backup verification.
Missing, stale, unlinked, or materially future evidence pauses only production
submission and leaves saved editorial work available. Follow-up deployment independently requires the
protected backup operator environment, exact schedules, mandatory off-host
configuration, and the same evidence through a committed read-only database
policy query before creating a release. That query remains compatible with a
current release whose health response still reports the initial backup
deferral, while preflight independently requires the candidate's web
environment to switch to required mode. A genuine first-release preflight
instead proves that the candidate environment still uses the explicitly
approved deferred mode before any release is created. A one-time append-only transition can
attest a legacy worker receipt only after rechecking the exact object on the
currently configured off-site target; normal workers persist that binding
directly.

The backup queue first proves that the source and receipt URLs normalize to the
same host, port, and `situation_studio` database, then uses one
destination-scoped operating-system lock, marks abandoned `RUNNING` claims
failed before selecting new work, bounds database, dump, encryption, and
network commands, and records terminal state only through the exact claimed
receipt and start-time fence. Follow-up deployment independently repeats that
database-identity proof. Restore-drill recording uses the same receipt identity
and current destination binding, rechecks both local and remote checksum and
byte length, rejects an empty restored production dataset, and writes `PASSED`
or `FAILED` only if those facts remain unchanged. For the deferred-release transition, the recorder may
run from an approved candidate copy before cutover only when its bytes match a
separately supplied SHA-256; it still invokes the restore script from the
recorded immutable current release and reports both identities.

A follow-up deployment first quiesces web and review intake, waits for all
unfinished publication attempts to persist their terminal evidence, rejects a
recovery fence, and stops the publisher. Its
token-fenced atomic deployment lease serializes every remote mutation through
verification or rollback and fails closed on an existing or incomplete lease.
Before migration, one preclaimed receipt and append-only audit anchor bind the
approved release and active-review projection hashes to a new synchronous,
encrypted off-site backup. The exact artifact must decrypt and expose a valid
PostgreSQL custom-format catalog, its receipt must be verified after the
database-clock quiescence fence against the preflight-frozen destinations and
encryption-key fingerprint, and both projections must remain unchanged across
the dump. Its
`active-review-state-continuity-v2` receipt contains matching before/after
hashes for active checkout, draft, revision, and review state plus matching
expected/actual hashes for queue-time normalization and focused-lane ownership.
Cutover failure restores the exact previous immutable release and succeeds as a
rollback only after both local live and ready checks pass.

The original schema and transition design is retained in historical
[checkpoint 1](checkpoints/01-contract-and-data-model.md). The current
deterministic-preflight schema, compatibility boundary, and acceptance evidence
are recorded in the
[local validation record](validation/deterministic-reliability-overhaul-2026-08-02.md).
Production remains behind the separate approval procedure in
[the migration runbook](runbooks/production-migration.md).
