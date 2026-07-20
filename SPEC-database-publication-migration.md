# Spec: Database-authoritative content publication

## Implementation status

Last updated: 2026-07-20 after the guarded production reader cutover.

| Checkpoint                              | Status                                    | Evidence                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 — Specification                       | Complete                                  | User approved the PostgreSQL authority, snapshot/cache model, complete-content boundary, and recovery objectives.                                                                                                                                                                                                                       |
| 1 — Data model and recovery design      | Complete                                  | PostgreSQL 16 production is at all 13 forward migrations. The disposable migration/restore and invariant evidence remains in `docs/database-publication-checkpoint-1.md`.                                                                                                                                                               |
| 2 — Backfill and shared validation      | Complete                                  | Production target generation 1 points to snapshot `0a43cd58-5690-4c2b-ac2e-9a0c4ad86df3`, manifest `cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`, with 32 members and 99 edges. Bootstrap rerun was idempotent.                                                                                                    |
| 3 — Shadow reader and private candidate | Complete                                  | Production shadow served filesystem bytes while making one database query and reporting zero mismatches across the canonical inventory and all 24 route probes. Candidate exchange remains private, short-lived, and database-backed.                                                                                                   |
| 4 — Database publisher acceptance       | Complete — independently accepted         | The non-implementer reviewer accepted the hardened implementation at 2026-07-20T03:58:50Z after 626 Studio tests, 43 Leadership tests, PostgreSQL 16.12 migration/grant checks, negative bootstrap guards, and Git-disabled publication/rollback acceptance.                                                                            |
| 5 — Production shadow/recovery          | Complete under explicit deployment waiver | Shadow parity, frozen-cache outage boot/reconvergence, both prior-application symlink rehearsals, capacity, and unrelated-service gates passed. The owner explicitly waived only the off-host PITR/RPO/RTO gate for this deployment; the missing off-host recovery capability remains recorded debt.                                    |
| 6 — Public database-reader cutover      | Complete                                  | Studio web and Leadership alone were restarted. Leadership now serves the exact official snapshot from PostgreSQL with one query per refresh; 24/24 routes passed, not-found returned 404, Studio remained live/ready, and unrelated services remained online.                                                                          |
| 7 — First database publication          | Waiting for required human workflow       | The separate publisher now runs `database-main` under `situation_studio_materializer`; Git publication is inactive. No publication was started. Production has no database-bound reviewed bundle and no live human Studio session, so fresh human review, approval, recent reauthentication, and final confirmation are still required. |
| 8 — Git decommission and contract       | Blocked by Checkpoint 7 observation       | Git-era configuration/code and readable history are intentionally retained. Decommission requires the first successful database publication, the approved observation period (proposed seven days), another recovery rehearsal, and explicit decommission approval.                                                                     |

Production is database-authoritative for public Leadership reads, but no
database-authoritative content publication has occurred yet. Studio release
`20260720T161153Z` runs corrective commit
`7ae119a52ec247a058722d9b53283136fec52727`; Leadership release
`20260720T161451Z` runs approved commit
`80ac9b590c5efa4befc7b1227a6f7d5766e84059`. PostgreSQL still has
`archive_mode=off` and no proven off-host WAL chain. The owner's waiver allowed
this deployment to proceed; it did not establish or claim the specified RPO,
RTO, encryption, or off-host recovery guarantees.

## Goal

Make PostgreSQL the sole authority for reviewed Leadership content and its
publication state so that publishing an approved bundle is one understandable,
auditable, recoverable workflow. Unrelated content publications must never
invalidate one another because a Git branch moved.

For the user, the intended outcome is:

1. The public Leadership site continues serving one exact official content
   snapshot while a separate candidate is validated and privately reviewed.
2. “Confirm and publish” atomically selects the already-reviewed immutable
   candidate as official.
3. Studio reports durable, plain-language progress from database events.
4. A failure before confirmation cannot change public content. A failure after
   confirmation automatically restores the previous verified snapshot or
   presents a precise reconciliation action.
5. Git, Git commits, branches, pushes, and repository-head comparisons are not
   part of content publication or content rollback.

Leadership application source code may continue to be developed and deployed
from Git. This migration removes Git from the **content** publication workflow;
it does not replace ordinary source-code version control or application
deployment.

## Context

Situation Studio currently has split authority:

- PostgreSQL owns drafts, content blobs, immutable proposed bundles,
  validations, approvals, publication requests, and audit history.
- The Leadership Git repository owns the bytes used by the public build.
- The publisher creates a Git commit from an approved bundle, stages a release,
  waits for confirmation, advances protected `main`, verifies Leadership, and
  reconciles PostgreSQL.

This split caused a real production-safe failure. One situation's approved
bundle was based on Git commit `9a870e5c…`, while an unrelated situation had
already advanced protected `main` to `b6e40575…`. The publisher correctly
refused the stale compare-and-swap with `REMOTE_HEAD_ADVANCED`, but Studio
misleadingly presented the locally created commit as a staged candidate.
Nothing was published, yet the state was difficult for the user to understand.

The existing database already contains most of the required immutable
primitives:

- `ContentBlob` stores content-addressed bodies.
- `Artifact` identifies managed surfaces.
- draft, version, and bundle artifact tables bind exact paths and hashes.
- approvals bind a human reviewer to an exact canonical bundle.
- publication requests, steps, and audit events provide durable history.

Leadership currently reads content synchronously from repository files in
`../leadership/lib/content.ts`. Situation and guide MDX, practices,
bibliography, and authors are loaded from the filesystem; route generation
assumes build-time files. Preparation-tool content is partly embedded in
`lib/tools.ts`. The approved artifact policy also covers lesson plans and
other workshop source material.

The production topology is a resource-constrained RP1 that also hosts unrelated
sites. A migration must not repeat the prior whole-box outage. PostgreSQL is
currently on the same host, and the existing 24-hour backup RPO is inadequate
once it becomes the sole content authority.

There is an unfinished, local-only stale-Git-baseline recovery experiment in
the Situation Studio worktree. It has not been deployed. Implementation of
this spec must first isolate and remove that experiment rather than combining
it with the database-authoritative design.

### Chosen architecture

- PostgreSQL is the only authoritative store for published content and
  publication pointers.
- Each release is a complete immutable content snapshot assembled from
  content-addressed blobs.
- Leadership reads an official snapshot through a least-privilege database
  adapter and maintains a hash-verified, last-known-good local cache.
- The public Leadership site always selects the official pointer.
- An authenticated private reviewer view selects the candidate pointer without
  changing public content.
- Git has no content-publication, content-mirroring, or content-rollback role.
- Every managed content surface is migrated. Executable application code is
  not loaded from the database.

### Target publication model

The exact table names may be refined at the first design checkpoint, but the
following identities and invariants are required.

1. **Content snapshot**
   - UUID, parent snapshot UUID, canonical manifest hash, source bundle UUID,
     creation timestamp, validation state, and verification timestamp.
   - Its manifest is complete: every active managed artifact in that release is
     represented exactly once.
   - Snapshot identity and artifact membership are immutable after creation.

2. **Content snapshot artifact**
   - Snapshot UUID, artifact UUID, logical ID, canonical path, artifact type,
     content hash, and byte length.
   - The content hash must resolve to one immutable `ContentBlob`.
   - Deleted artifacts are omitted from the materialized snapshot but remain
     recoverable through ancestor snapshots and audit history.

3. **Publication target**
   - One row for the protected Leadership environment.
   - Separate `officialSnapshotId` and nullable `candidateSnapshotId`.
   - Candidate publication request identity, monotonically increasing
     generation/fencing value, and update timestamp.
   - The official snapshot cannot be null after bootstrap.

4. **Database publication**
   - Binds request, approved bundle, candidate snapshot, previous official
     snapshot, resulting official snapshot, publisher identity, confirmation,
     health receipt, and terminal outcome.
   - New publication records use snapshot UUID/hash rather than Git commit SHA.
   - Historical Git-era publication records remain readable and immutable.

5. **Publication event/outbox**
   - Append-only request-scoped sequence, stable event type, safe JSON payload,
     and timestamp.
   - Unique sequence per publication request.
   - Supports SSE replay using `Last-Event-ID` and polling fallback.
   - Event insertion occurs in the same transaction as each state change.

6. **Leadership observation receipt**
   - Records the snapshot hash actually loaded and rendered by Leadership,
     cache source, health result, application release identity, and observation
     timestamp.
   - A publication is not “verified” merely because a database pointer moved.

### Target state machine

```text
REQUESTED
  -> SNAPSHOT_MATERIALIZED
  -> SNAPSHOT_VALIDATED
  -> CANDIDATE_AVAILABLE
  -> CANDIDATE_VERIFIED
  -> AWAITING_CONFIRMATION
  -> OFFICIAL_POINTER_COMMITTED
  -> LIVE_VERIFIED
  -> RECONCILED
```

Failure rules:

- A failure through `CANDIDATE_VERIFIED` clears the candidate pointer, returns
  checkout custody, and leaves the official pointer untouched.
- Final confirmation is accepted only for the exact candidate snapshot hash
  displayed to the reviewer.
- A failure after `OFFICIAL_POINTER_COMMITTED` atomically restores the
  recorded previous verified official snapshot and verifies that restoration.
- If restoration cannot be proven, the request enters
  `RECONCILIATION_REQUIRED`; the UI identifies the official database pointer,
  Leadership's observed snapshot, and the one safe next action.
- Retries are idempotent by publication UUID, logical step, attempt, and
  fencing generation.

Only one candidate publication may be active for a publication target at a
time. This is enforced in PostgreSQL, not through a process-local mutex.
Therefore the official base cannot move underneath a candidate awaiting human
confirmation.

### Leadership read and cache model

- Leadership receives a separate read-only database identity. It can read only
  the official snapshot, a specifically authorized candidate snapshot,
  snapshot manifests, required blobs, and safe metadata.
- Public requests never accept an arbitrary snapshot UUID.
- Candidate access requires an authenticated, short-lived authorization bound
  to publication request, snapshot hash, reviewer, and expiry. Prefer an
  HttpOnly cookie exchange over a reusable token in a URL.
- The content adapter validates manifest and blob hashes before a snapshot can
  enter the cache.
- The cache is immutable by snapshot hash. Activating a new official cache
  entry uses an atomic pointer/file replacement.
- If PostgreSQL is temporarily unavailable, Leadership serves the last
  hash-verified official cache and reports degraded freshness. It must never
  substitute a candidate or partially loaded snapshot.
- A restarted Leadership process must be able to serve the last-known-good
  official cache before database recovery completes.
- Once database connectivity returns, Leadership rechecks the authoritative
  pointer and loads any newer snapshot.

### “Migrate everything” interpretation

All file-backed managed content and graph metadata are in scope:

- situation MDX;
- guide MDX;
- practice and quiz JSON;
- bibliography/source JSON;
- author JSON;
- preparation prompts and tool definitions;
- workshop syllabus, lesson plans, and supporting source material;
- current and future content under the approved artifact roots;
- artifact relationships required to validate or render those surfaces.

Application routes, React components, validators, schemas, and other
executable code remain deployed application code. Content currently embedded
in executable files such as `lib/tools.ts` must be extracted into a validated
data schema and imported as content. The migration must not execute arbitrary
TypeScript, JavaScript, or unallowlisted MDX components from PostgreSQL.

## Scope — this pass only

This spec governs a checkpointed migration, not one large deployment.

### 1. Clean starting point and immutable evidence

- Record the current Studio and Leadership application releases, database
  migration level, public Leadership snapshot, and hashes for every managed
  artifact.
- Preserve a database dump, an off-host encrypted copy, and a hash-verified
  frozen Leadership content package before any schema or reader change.
- Remove or quarantine the uncommitted stale-Git-baseline recovery experiment.
- Confirm that no production retry or publication occurs as part of cleanup.

### 2. Expand the database model

- Add immutable content-snapshot, snapshot-artifact, publication-target,
  publication-event/outbox, and Leadership-observation structures.
- Add snapshot-based columns to bundles, approvals, publication requests, and
  publications while retaining Git-era columns for historical compatibility.
- Add database constraints/triggers for immutable records, one active
  candidate per target, non-null official target after bootstrap, monotonic
  fencing, and append-only event history.
- Add least-privilege grants for web, worker/materializer, Leadership reader,
  operations, and migrator roles.
- Do not drop or reinterpret an existing column during the expand phase.

### 3. Bootstrap and backfill all content

- Build one canonical bootstrap snapshot from the exact currently verified
  Leadership content.
- Import every managed artifact body as a content-addressed blob.
- Extract code-embedded tool/preparation content into validated data artifacts.
- Import the artifact graph needed by Studio review and Leadership rendering.
- Produce a deterministic manifest and verify its hash independently.
- Point no production reader at this snapshot during backfill.

### 4. Extract shared content contracts and validators

- Move Leadership content schemas and graph validation into a pure shared
  package consumable by Studio, the materializer, Leadership, and tests.
- Validate frontmatter, JSON, path allowlists, graph references, approved MDX
  components, reviewer provenance, hashes, and duplicate logical IDs.
- Replace the per-content-publication `next build` requirement with exact
  snapshot validation, MDX compilation/render probes, and affected-route
  health checks. Application builds remain part of application deployment.

### 5. Add the Leadership database content adapter

- Introduce filesystem, shadow, and database modes behind an explicit
  server-only configuration.
- Make situation, guide, practice, author, source, preparation-tool, metadata,
  related-content, and static-parameter behavior work from one content-reader
  interface.
- In shadow mode, continue serving filesystem content while loading the
  database snapshot and recording byte, parse, graph, and rendered-output
  mismatches.
- Add the persistent last-known-good cache and atomic cache activation.
- Add the authenticated private candidate view. Anonymous/public requests must
  continue seeing the official snapshot.

### 6. Replace the Git publisher with a database materializer

- Build a complete candidate snapshot by overlaying the approved immutable
  bundle on the current official snapshot.
- Recalculate the complete manifest hash and validate every referenced blob.
- Run the shared validators and candidate render/health probes.
- Set the candidate pointer only after successful validation.
- Preserve the existing human approval gate and bind confirmation to exact
  candidate snapshot UUID/hash, validation policy, reviewer, and recent
  authentication.
- On confirmation, atomically advance the official pointer and append the
  event/outbox record in one serializable transaction.
- Verify that Leadership observed the same hash before marking publication
  reconciled.
- Implement pointer-based rollback as a new audited database publication.
- Remove every Git command, repository credential, branch/ref, commit, push,
  and remote-head condition from the active content-publishing service.

### 7. Provide clear durable publication UX

- Stream publication events through authenticated SSE with replay and polling
  fallback.
- Show one official snapshot, one candidate snapshot, and one next valid action.
- Use these user-facing stages:
  - Preparing private preview
  - Validating exact content
  - Private preview ready
  - Awaiting your confirmation
  - Publishing exact snapshot
  - Verifying Leadership
  - Published successfully
  - Previous version restored
  - Reconciliation required
- Never label a materialized or locally cached candidate as “staged” or
  “displayed” until Leadership has returned a matching candidate observation
  receipt.
- Explain failures in terms of user impact: whether public content changed,
  what remains live, and exactly what the user should do next.

### 8. Shadow, cut over, and contract

- Exercise database publication in a disposable production-like environment
  with Git network access disabled.
- Run production shadow reads without changing public responses.
- Require zero unexplained parity mismatches across all managed artifacts and
  public content routes before cutover.
- Cut Leadership's public reader to database mode only after explicit human
  approval at the cutover checkpoint.
- Keep the frozen pre-cutover content package and schema-compatible prior
  application releases available during the observation window.
- After the observation window and a successful restore rehearsal, disable and
  remove the Git content publisher, revoke its Git deploy key, remove
  content-publication Git configuration, and contract obsolete current-state
  fields. Preserve historical Git-era audit data.

## Out of scope / do NOT touch

- Do not change the leadership-review frameworks, role DAG, model policy, or AI
  provider behavior except where a snapshot identity must replace a Git base
  identity.
- Do not rewrite approved content merely to migrate its storage.
- Do not change reviewer identity, recent-authentication, CSRF, RBAC, checkout,
  fencing, blocking-comment, or explicit-confirmation requirements.
- Do not put executable Next.js/React/validator code in PostgreSQL.
- Do not remove Git from Studio or Leadership application source-code
  development and deployment.
- Do not add Git mirroring, Git backup commits, or a fallback Git publication
  path.
- Do not expose candidate content publicly or make the public site show a
  candidate before confirmation.
- Do not run destructive down migrations or overwrite the production database
  during recovery.
- Do not change the TimsPrototypes gateway, unrelated RP1 sites, network
  routes, or host services except for the narrowly reviewed service
  configuration and credentials required by this migration.
- Do not deploy from this specification task. Every deployment belongs to a
  later implementation checkpoint with explicit approval.

## Constraints

### Authority and provenance

- The database official pointer and immutable snapshot hash are authoritative.
- Every rendered byte must resolve through an immutable snapshot artifact to a
  hash-verified content blob.
- Approvals remain exact: any candidate-byte, manifest, base-snapshot,
  validation-policy, or reviewer change requires a new approval.
- Publication confirmation identifies the exact snapshot the reviewer viewed.
- AI/service identities cannot approve or confirm publication.
- Historical records are append-only and retain Git-era provenance without
  making it operational.

### Safety and availability

- Use expand/migrate/shadow/cutover/contract; no big-bang migration.
- Every application release before contract must tolerate both old and new
  schema.
- Public Leadership must keep serving the previous official snapshot while a
  candidate is created, validated, previewed, rejected, or abandoned.
- A database outage must disable new publications but not blank the public
  Leadership site.
- No migration or content publication may restart unrelated RP1 services.
- Commands used during deployment must be resource-bounded and preceded by
  host health, free-space, memory, load, and backup checks.
- Production cutover and decommissioning require separate explicit human
  approvals.

### Recovery objectives

- Before database-authoritative cutover, establish PostgreSQL point-in-time
  recovery with encrypted off-host WAL/archive coverage.
- Proposed acceptance targets are RPO no greater than 5 minutes and rehearsed
  RTO no greater than 60 minutes. The owner must confirm or revise these values
  at Checkpoint 1.
- Restore rehearsals use a new disposable database and do not overwrite
  production.
- The frozen pre-cutover cache/package must be independently hash-verifiable
  and startable without Studio.
- Pointer rollback never deletes snapshots or blobs.

### Security

- Leadership uses a new read-only database role with no access to sessions,
  passwords, provider data, drafts, comments, or unpublished snapshots except
  the one candidate explicitly authorized for that reviewer.
- Candidate authorization is short lived, revocable, audience bound, and
  excluded from logs, analytics, referers, and audit payloads.
- MDX is parsed/compiled only with the existing allowlisted component set.
- Database content cannot select filesystem paths, commands, modules, models,
  targets, or credentials.
- Logs and SSE payloads contain identifiers, hashes, progress, and safe error
  classes—not content bodies or secrets.

### Performance

- Public content reads use a snapshot-scoped cache; they must not issue one
  query per artifact or relationship.
- Snapshot loading must be bounded by a complete manifest and use batched
  reads.
- Candidate validation/materialization remains globally concurrency limited on
  RP1.
- The implementation must publish measured cold-cache, warm-cache, memory, and
  database-query budgets at Checkpoint 3 before production cutover.

## Success criteria (testable)

### Data completeness and determinism

- [x] A machine-generated inventory proves that 100% of currently managed
      file-backed artifacts and relationships exist in the bootstrap snapshot.
- [x] Every migrated body is byte-identical to the recorded pre-migration
      source after the documented canonical newline rule; every hash and byte
      length verifies independently.
- [x] Rebuilding the same snapshot twice produces the same sorted manifest and
      manifest hash.
- [x] Code-embedded preparation/tool content is represented by validated data,
      and the public behavior matches its pre-migration behavior.
- [ ] No public content loader reads production content from the repository
      after database-mode cutover.

### Publication correctness

- [x] Creating, validating, previewing, rejecting, expiring, or failing a
      candidate leaves the official pointer and public bytes unchanged.
- [x] Confirmation advances the official pointer exactly once for the exact
      approved candidate hash, even under duplicate requests and injected
      process crashes.
- [x] Two simultaneous publication attempts result in one active candidate and
      one explicit database-level contention result; neither produces partial
      official state.
- [x] Publications for unrelated situations do not require rebasing and cannot
      produce `REMOTE_HEAD_ADVANCED` or any Git-head equivalent.
- [x] A failed live verification automatically restores the previous snapshot,
      verifies Leadership against it, and records the entire transition.
- [x] An authorized rollback creates a new audited publication pointing to the
      exact selected prior verified snapshot without deleting later history.
- [x] The full publication and rollback acceptance suite passes while outbound
      access to the Leadership Git remote is blocked.

### Leadership behavior

- [x] Every public situation, guide, practice, tool/preparation surface,
      metadata route, related-content link, author/source reference, and
      not-found case matches the verified pre-cutover behavior.
- [x] Anonymous and ordinary public requests cannot select or infer candidate
      content.
- [x] An authorized reviewer can view exactly the candidate snapshot named in
      Studio while ordinary users simultaneously receive the official
      snapshot.
- [x] Leadership refuses corrupt manifests/blobs and continues serving its
      previous last-known-good official cache.
- [x] With PostgreSQL unavailable, a clean Leadership restart serves the
      verified cached official snapshot and clearly reports degraded health.
- [x] On database recovery, Leadership converges to the current official
      pointer without serving a partial snapshot.

### UX and observability

- [x] After every publication action, Studio shows the official snapshot,
      candidate snapshot when one exists, durable current stage, and one clear
      next action.
- [x] SSE reconnect with `Last-Event-ID` replays every missed transition once
      in order; polling produces the same terminal state.
- [x] UI tests prove that pre-confirmation failures say public content was
      unchanged, post-confirmation rollback says the previous version was
      restored, and reconciliation errors identify the disagreement.
- [x] “Staged” or “displayed on Leadership” appears only after a matching
      Leadership candidate observation receipt.
- [x] Operational metrics expose publication latency, validation failures,
      official/candidate snapshot hashes, cache age, cache source, database
      reachability, rollback outcome, and outbox lag without exposing content
      or secrets.

### Security and privileges

- [x] Database privilege tests prove that the Leadership role cannot read
      credentials, users, sessions, drafts, AI output, or arbitrary candidate
      snapshots and cannot mutate any row.
- [x] AI and worker roles cannot create approvals, confirmations, official
      pointers, or Leadership observation receipts.
- [x] Candidate authorization expiry, revocation, audience binding, replay,
      guessing, referer leakage, and logging tests pass.
- [x] Path traversal, duplicate logical ID/path, unknown MDX component,
      invalid JSON/frontmatter, content-hash mismatch, and oversized-snapshot
      tests fail closed.
- [ ] Production content publication succeeds after the Git deploy key and all
      Git publisher configuration have been removed.

### Migration and recovery

- [ ] The schema expands without downtime and the prior Studio/Leadership
      releases continue to operate against it.
- [ ] Shadow mode reports zero unexplained byte, parse, graph, metadata, route,
      or rendered-output mismatches for the full production inventory.
- [ ] A clean restore from off-host backup plus WAL reaches the agreed RPO and
      RTO and reconstructs the exact official pointer, snapshot, blobs, audit
      events, and cache package.
- [ ] Application rollback to the prior compatible release is rehearsed before
      database-reader cutover.
- [ ] Database-reader cutover can be reversed to the frozen last-known-good
      package without using Git publication or changing database history.
- [ ] The production cutover changes only the intended Studio/Leadership
      processes; health checks prove unrelated RP1 sites remain available.
- [ ] Git-era fields and services are contracted only after the observation
      window, verified backup restore, and explicit decommission approval.

## Verification plan

### Deterministic verifier

Create one top-level command, tentatively
`pnpm verify:database-publication`, that runs:

1. schema and database-constraint validation;
2. snapshot canonicalization, overlay, deletion, and hash property tests;
3. complete baseline inventory and byte-parity verification;
4. shared Leadership schema, graph, MDX, and safe-component validation;
5. role/grant and candidate-authorization security tests;
6. publication state-machine, idempotency, concurrency, and outbox/SSE tests;
7. Leadership filesystem-versus-database contract tests;
8. browser tests for public official content and private candidate isolation;
9. fault-injection publication/rollback tests;
10. Studio and Leadership lint, typecheck, unit tests, build, and secret scan.

The verifier must fail if it requires a Git remote or Git credential to
complete a content publication.

### Test environment

- Disposable PostgreSQL created from production-compatible migrations.
- Seeded copy of the recorded production artifact inventory with synthetic
  credentials and no production sessions.
- Leadership and Studio production builds, not development mode.
- Outbound Git remote access deliberately blocked.
- Independent official and candidate browser sessions.
- Fault injection before and after each durable transition:
  snapshot creation, validation completion, candidate-pointer update,
  candidate observation, confirmation transaction, official-pointer update,
  cache activation, live observation, rollback pointer update, and
  reconciliation.
- Database disconnect/reconnect, process termination, duplicate delivery,
  delayed outbox, corrupt cache, corrupt blob, full disk/low-space preflight,
  and Leadership restart scenarios.

### Ground truth

- The frozen pre-migration Leadership content package and its independent
  manifest are byte-level ground truth for bootstrap parity.
- Existing Studio and Leadership unit/browser suites are behavioral ground
  truth.
- Current production publication `b6e40575…` and its Leadership release are
  historical identity evidence only; Git is not used by the new verifier to
  publish.
- Production shadow-read reports are ground truth for route and rendered-output
  parity.
- Database audit events, publication events, target pointers, Leadership
  receipts, and external health responses jointly prove a successful
  publication.

An independent review should challenge the schema invariants, authorization
boundary, crash behavior, and recovery procedure before Checkpoint 4. The
reviewer must not be the implementation agent.

## Checkpoints

### Checkpoint 0 — Confirm this specification

Stop and show the user:

- chosen authority and cache model;
- interpretation of “migrate everything”;
- explicit out-of-scope boundaries;
- proposed 5-minute RPO and 60-minute RTO;
- migration phases and production approval gates.

No implementation begins until the user confirms or corrects this spec.

### Checkpoint 1 — Data model and recovery design

Deliver schema diagrams, state transitions, role/grant matrix, cache format,
candidate-authorization design, migration SQL plan, backup/PITR plan, and
rollback runbook. Demonstrate migrations and restore on a disposable database.
Stop for approval before changing either application reader.

### Checkpoint 2 — Complete backfill and shared validation

Deliver the canonical bootstrap snapshot, full inventory/parity report, shared
contract package, and deterministic verifier results. Show every converted
code-embedded content surface. Stop for approval before adding a production
shadow reader.

### Checkpoint 3 — Leadership shadow reader and private candidate

Deliver filesystem/database contract results, cache/restart/outage results,
candidate isolation security results, browser evidence, and measured resource
budgets. Production may run shadow reads only after approval. Stop before any
public read cutover.

### Checkpoint 4 — Database publisher acceptance

Deliver a complete disposable end-to-end candidate, confirmation, duplicate
request, injected-crash, live-failure auto-restore, and audited rollback run
with Git network disabled. Include an independent security/recovery review.
Stop before enabling database publication in production.

### Checkpoint 5 — Production shadow and recovery rehearsal

Deliver zero-mismatch production shadow evidence, off-host backup/PITR restore
evidence, frozen-cache boot evidence, prior-application rollback rehearsal,
current RP1 health/capacity evidence, and a minute-by-minute cutover/abort
runbook. Stop for explicit production cutover approval.

### Checkpoint 6 — Public database-reader cutover

Cut over only Studio/Leadership content processes within the approved window.
Verify public official content, private candidate isolation, Studio status,
database/cache health, and unrelated RP1 sites. Abort to the frozen verified
package on any unexplained mismatch or host-health regression. Stop and report
before the first database-authoritative production publication.

### Checkpoint 7 — First production publication and observation

With separate explicit approval, run one complete reviewed-bundle publication:
private candidate, observation receipt, human confirmation, official pointer,
live verification, reconciliation, and SSE/UI completion. Do not combine this
checkpoint with a rollback unless the user separately approves the rehearsed
rollback target and window.

Observe for a user-approved period, proposed as seven days, with no unexplained
snapshot, cache, authorization, availability, or audit mismatch.

### Checkpoint 8 — Git publisher decommission and contract

After explicit approval:

- disable and remove the Git content publisher;
- revoke and remove its deploy key and content-publication configuration;
- remove Git publication code and active-state UI language;
- retain readable Git-era history;
- contract obsolete current-state schema only through a forward migration;
- rerun the full verifier, restore rehearsal, and production smoke suite.

Report exactly what was removed and how the database/frozen-cache recovery path
was revalidated.

## Working rules

- Verify before acting: surface and confirm every authority, security,
  migration, cutover, and recovery decision.
- Do not assume: any mismatch between this spec, live production, and the
  Leadership repository stops the affected checkpoint.
- Make the smallest checkpoint-sized change that works; do not combine schema,
  reader, publisher, cutover, and decommissioning into one release.
- Preserve unrelated worktree changes and unrelated RP1 services.
- Use read-only discovery before every production mutation.
- Never use destructive Git or filesystem commands against broad paths.
- Never retry a failed production publication merely to “see if it works.”
- Never treat a database row as live proof without a matching Leadership
  observation receipt.
- Never treat a cache as authoritative; it is a hash-verified availability
  derivative of an immutable database snapshot.
- Never delete a prior snapshot, content blob, publication, approval, event, or
  audit record as part of rollback.
- Prefer forward-compatible migrations and pointer restoration over down
  migrations or in-place database restores.
- Maintain concise user-facing updates during long verification and deployment
  work.
- At each checkpoint, provide exact commands/tests run, results, unresolved
  risks, rollback readiness, and the next decision required from the user.
