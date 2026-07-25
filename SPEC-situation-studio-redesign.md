# Spec: Simplified Situation Studio

## Goal

Rebuild Situation Studio as a fast, reversible editorial workbench for
Leadership situations.

An authenticated editor must be able to check out one situation, continue a
saved draft or start from the current production version, edit it manually,
optionally run the complete 22-stage agent review workflow, selectively apply
the resulting proposal, inspect an accurate rendered preview and diff, and use
one deliberate action to make the result production.

The redesign serves these outcomes:

1. Editorial work is simple enough to understand from the situation workspace
   without knowing a publication state machine.
2. Only one user can edit a situation at a time.
3. Leadership remains the sole production content authority in its independent
   `leadership_field_guide` database.
4. Situation Studio owns working copies, review evidence, and an independent,
   immutable history in a new `situation_studio` database.
5. Every distinct production version of each situation can be selected later,
   reviewed as a draft, and restored without reverting unrelated situations.
6. Shared learning artifacts can evolve for one situation without changing any
   other consumer.
7. Objective validation, least-privilege database boundaries, and automatic
   recovery protect production without password re-entry, candidate staging,
   approval ceremonies, or a user-visible publication saga.

The task is not to restore the former application. The task is to preserve its
useful capabilities inside a substantially smaller product and lifecycle.

## Context

### Repository state

Situation Studio was deliberately reduced on 2026-07-23 to a bare Next.js
application containing only:

- one static reset page;
- `/health/live`;
- `/health/ready`.

The former Studio database, Prisma schema, auth UI, editor, agent worker,
publisher, candidate workflow, approval workflow, rollback saga, deployment
surface, and tests have been removed from the working tree. The current
uncommitted deletions and edits belong to the user and must not be reset,
overwritten, or wholesale restored.

Git history remains available as reference material. Useful pieces may be
ported selectively after review, but the old architecture is not the target.

The Leadership repository is separate at:

`/Users/timothybreeding/projects/leadership`

It is clean at spec time and owns its own Prisma schema, content contracts,
runtime, validation, and deployment.

### Current production authority

Production Leadership reads from the independent PostgreSQL database
`leadership_field_guide`. Its content model is release-based:

- `ContentRelease` represents one complete immutable site-content release.
- `CurrentRelease` is a singleton pointer to the official release.
- validated, official, and retired releases are protected by database
  immutability triggers;
- promotion atomically retires the current release, marks the selected release
  official, and advances the singleton pointer generation;
- the Leadership runtime reads only the official release and retains a
  verified last-known-good cache.

At the time of this spec, production reports official manifest hash:

`ca8d523a5a4acef439a368c3511296d6058fccd20fb02c7d50cfa17ec7868a34`

Implementation must discover the current official release again at execution
time. The hash above is context, not a hard-coded baseline.

The current Leadership schema treats practices, guides, sources, lesson plans,
and preparation prompts as release-wide artifacts. Several situations share
the same artifacts: the migrated baseline has 15 situations but only 3
practices and 3 guides. Situation-scoped copy-on-write variants therefore
require additive Leadership schema and runtime changes; they cannot be
implemented only inside Studio without breaking the isolation requirement.

### Confirmed product decisions

- There is no candidate environment or candidate-staging lifecycle.
- Agent review is optional; deterministic validation is mandatory.
- Agent output is a proposal and never overwrites a draft automatically.
- Editors may publish and restore. A later approval flow is explicitly
  deferred.
- Authentication is ordinary username/password login. Sensitive actions do
  not ask for the password again.
- One active checkout is allowed per situation.
- Checkouts never expire automatically.
- An administrator may force a checkout back in.
- Checking in preserves unpublished work as `Draft saved`.
- The next checkout resumes the saved draft by default.
- Starting over from production is explicit and archives the prior draft.
- Successful publication checks the situation in automatically.
- Restoration is independent per situation and starts as a reviewable draft.
- Shared artifacts use situation-scoped copy-on-write variants.
- Situation-scoped variants are excluded from global indexes and affect only
  their owning situation.
- Publishing writes directly to Leadership through restricted server-side
  database roles.
- Unrelated Leadership releases are automatically rebased at submission.
- A competing production change to the same situation blocks submission.
- Failed post-publication verification automatically restores the prior
  official release when possible.
- The former 22-stage review logic is retained as a durable server-side job.
- Only one full agent review runs globally; additional reviews queue FIFO.
- A queued or running review pins its draft revision and temporarily makes that
  situation read-only.
- The Studio editor is section-based with optional raw MDX access.
- Preview and diff are rendered in Studio; no draft content is placed in
  Leadership for preview.
- Existing Leadership production history is imported into Studio through
  strictly read-only access.
- New situation creation and reversible retirement are in scope.
- Production submission has one ordinary confirmation dialog.
- The runtime retains separate web, review-worker, and publisher security
  boundaries.
- Unknown external Leadership releases are ingested read-only into Studio
  history.

### Terminology

**Situation bundle**

The independently versioned unit for one situation:

- the situation's typed metadata and MDX body;
- its situation-owned promotion metadata;
- references to unchanged shared artifacts;
- every situation-scoped artifact variant owned by it;
- the relationship manifest needed to render and validate those items.

**Shared artifact**

A practice, guide, source, lesson plan, preparation prompt, or other learning
surface referenced by more than one consumer.

**Situation-scoped variant**

An immutable, copy-on-write fork of a shared artifact with a new logical
identity, explicit owner situation, original-artifact provenance, and scoped
visibility. Only the owning situation resolves the variant.

**Production situation version**

One distinct situation-bundle hash that successfully appeared in an official
Leadership release. Site-wide releases that leave a situation bundle unchanged
do not create duplicate situation-history entries.

**Review proposal**

The consolidated output of the agent workflow, tied to the exact immutable
draft revision it reviewed. It is editorial evidence and suggested changes,
not a publication candidate or approval state.

## Scope — this pass only

### 1. Rebuild on the bare application

- Keep the current Next.js 16 / React 19 / TypeScript foundation.
- Reintroduce only the packages and processes required by this spec.
- Use Git history as a reference, not as a source to restore wholesale.
- Port narrowly useful, verified implementations where appropriate:
  - password hashing, session, CSRF, and throttle behavior;
  - provider adapters and structured-output parsing;
  - the 22 review-role definitions;
  - content diffing;
  - deterministic content and graph validation;
  - idempotent job and fencing patterns.
- Do not restore the former approval, candidate, preview-deployment, private
  handoff, reauthentication, Git publisher, or publication-saga code.

### 2. Create an independent Studio database

Create a PostgreSQL database named exactly `situation_studio`, separate from
`leadership_field_guide`.

The recommended production topology keeps both databases in the existing
PostgreSQL 16 container on RP1 while preserving hard database and role
boundaries.

Create separate least-privilege roles for:

- Studio schema migration/ownership;
- Studio web/auth/editing;
- Studio review worker;
- Studio publisher;
- Studio backup/restore inspection;
- Leadership official-release reading by Studio;
- Leadership release publication by the Studio publisher.

Application startup must never run migrations. Checked-in, reviewed migrations
are applied explicitly during deployment.

The Studio schema must model at least:

- users, sessions, login throttles, and role assignments;
- situations known to Studio;
- durable checkouts and fencing tokens;
- drafts and immutable draft revisions;
- content-addressed artifact bodies;
- situation bundles and situation-scoped variants;
- production situation versions;
- Leadership release observations and synchronization cursors;
- review jobs, steps, runs, proposals, and proposal changes;
- publication jobs, attempts, events, and verification receipts;
- audit events;
- backup observations or receipts sufficient to report operational health.

Content bodies must be content-addressed by canonical SHA-256 hash. Identical
bytes are stored once even when referenced by many draft revisions or complete
release snapshots.

Production situation versions and their referenced blobs are immutable and
have indefinite retention in this pass. There is no delete or purge operation
for production history.

### 3. Keep authentication ordinary and small

Support normal username/password login with:

- secure password hashing using the reviewed former implementation or a
  reviewed equivalent;
- server-side opaque sessions;
- secure, HTTP-only, same-site cookies;
- CSRF protection on state-changing browser requests;
- login throttling;
- session invalidation when a user is deactivated or their password is reset;
- no public self-registration;
- no passwords, hashes, tokens, or session secrets in logs or audit payloads.

Support two roles:

- `EDITOR`
  - check out and check in situations;
  - create and edit drafts;
  - run or cancel agent reviews;
  - apply review proposals;
  - create, submit, restore, and retire production content.
- `ADMIN`
  - all editor capabilities;
  - create, deactivate, and reset users;
  - force-check-in a situation;
  - inspect operational failures and backup health.

There is no action-level password reauthentication. Role checks, active
sessions, CSRF, exact-version preconditions, and a visible confirmation dialog
are the authorization boundary.

Keep the protected TimsPrototypes outer access gate for the deployed Studio.

### 4. Make checkout/check-in explicit and durable

Enforce one unreleased checkout per situation with a database constraint, not
only application code.

A checkout:

- is owned by one active user;
- has a monotonically increasing fencing token;
- has no automatic expiration;
- records acquisition, release, and forced-release provenance;
- prevents any other user from editing, reviewing, restoring, retiring, or
  publishing that situation;
- does not prevent work on other situations.

Users may hold checkouts for multiple independent situations.

When no saved draft exists, checkout must:

1. read the current official Leadership release through the read-only role;
2. capture its release ID, manifest hash, and pointer generation;
3. copy the exact current situation bundle into Studio;
4. capture the hashes and relationship identities of shared context used for
   review;
5. create the initial immutable draft revision;
6. return an editable workspace only after the Studio transaction commits.

When a saved draft exists, checkout must resume it by default. Before resuming,
Studio observes current Leadership production:

- if the production bundle for that situation still matches the draft base,
  resume normally;
- if only unrelated situations changed, retain the draft and record the newer
  release as the eventual rebase target;
- if the same situation bundle changed, mark the draft conflicted and require
  an explicit refresh operation before it can publish.

`Start over from production` must:

- require the active checkout;
- show a destructive-change confirmation;
- archive the existing draft lineage without deleting it;
- copy the current production bundle into a new draft lineage;
- record who performed the reset and the production release used.

Checking in must flush pending autosave, create an immutable checkpoint when
content changed, preserve the draft, and release the checkout. The resulting
status is `Draft saved` unless the draft equals production, in which case it is
`Available`.

An administrator's force-check-in:

- requires a short recorded reason but no password re-entry;
- preserves all saved draft work;
- cancels and fences any queued or running review for that situation;
- cannot interrupt an in-flight atomic Leadership pointer transaction;
- records the administrator, former holder, reason, and resulting draft hash.

A successful production submission automatically checks the situation in.
Failed or automatically restored submissions leave the checkout and draft
intact.

### 5. Use a small, derived status model

Do not recreate a mutable editorial lifecycle state machine.

Show one primary status derived from checkout, draft, and production facts:

- `Available` — no checkout and no unpublished difference from production;
- `Draft saved` — unpublished work exists and no checkout is active;
- `Checked out by <user>` — a user owns the checkout;
- `Retired` — the situation is not currently public.

Show transient activity as a subordinate badge, not another lifecycle:

- `Review queued`;
- `Review running`;
- `Publishing`;
- `Publish failed — previous production restored`;
- `Needs refresh`;
- `Recovery required`.

`Recovery required` is reserved for the exceptional case where production
verification fails and the publisher cannot restore the prior official
release. It blocks further publication globally until reconciled.

Do not expose `DISCOVERY`, `HUMAN_REVIEW`, `APPROVED`, `STAGED`,
`AWAITING_CONFIRMATION`, or similar former lifecycle labels.

### 6. Build a section-based situation workspace

Provide one situation workspace with four compact surfaces:

1. **Edit**
   - typed metadata fields;
   - one editor per required guidance section;
   - artifact tabs for situation-scoped variants;
   - advanced raw-MDX mode;
   - visible autosave state.
2. **Review**
   - current production and saved draft rendered side by side;
   - synchronized exact source diff;
   - agent findings linked to the affected section or artifact;
   - accept all, accept one change, reject, and manual-edit actions.
3. **History**
   - every distinct production situation version, newest first;
   - timestamp, actor, source kind, Leadership release ID/hash, bundle hash,
     automatic change summary, and optional editor note;
   - compare any production version with current production;
   - start a restoration draft.
4. **Context**
   - shared guides, practices, sources, prompts, and lesson plans supplied to
     the reviewers;
   - ownership, sharing count, current hash, and whether a scoped variant
     exists;
   - no accidental editing of a shared original.

Provide a searchable situation inventory showing:

- title and slug;
- current primary status;
- checkout owner;
- draft last-updated time;
- current production version time;
- review/publish activity when present.

The inventory and workspace replace the former jobs, capacity, approval,
candidate, and publication pages. A small admin operations view may expose
failed jobs, the global review queue, user management, synchronization health,
and backup health without becoming part of the editorial lifecycle.

Autosave after a short idle debounce and on blur. Create a new immutable draft
revision only when the canonical bundle hash changes. Checking in, starting a
review, applying a proposal, resetting from production, restoring, and
submitting always create named checkpoints.

Meet WCAG 2.2 AA interaction requirements, preserve keyboard operation and
focus, avoid color-only state, and work at the existing desktop baselines of
1280×800 and 1440×900. Mobile must remain usable for inspection and emergency
actions even though desktop is the primary editing surface.

### 7. Share the Leadership content contract and renderer

Leadership must own a versioned internal package or equivalent build artifact
containing the content contract needed by both applications:

- schemas;
- canonicalization;
- manifest construction and hashing;
- graph validation;
- section parsing and serialization;
- allowlisted MDX parsing;
- situation-content rendering primitives;
- variant resolution rules;
- typed projection validation.

Both Leadership and Studio must pin the exact contract version. Draft
revisions, review jobs, validation receipts, and production versions record the
contract version used.

Studio's preview renders entirely from Studio draft bytes. It must not insert
draft content into Leadership, create a candidate release for review, or
expose a public preview URL.

The preview should accurately reproduce the Leadership situation-content
surface. Production verification remains the final ground-truth check for the
complete running application.

### 8. Implement situation-scoped copy-on-write variants

Shared artifacts remain shared and read-only until a proposed or manual change
is accepted for one situation.

When an editor accepts or manually begins such a change, Studio must:

1. create a new situation-scoped logical identity;
2. record the owner situation;
3. record the original shared logical ID and exact base content hash;
4. copy the original content through content-addressed references;
5. store only changed content as new blobs;
6. rebind only the owning situation's draft relationship to the variant.

Agent recommendations alone do not create variants. Creation happens only
when an editor accepts a change or explicitly chooses to edit the shared
surface for this situation.

Additive Leadership schema changes must support at least:

- global, situation-scoped, and internal visibility;
- owner-situation binding;
- forked-from identity and hash provenance;
- scoped resolution for practices, guides, sources, lesson plans, and
  preparation prompts;
- exclusion of scoped variants from global indexes, sitemaps, feeds, public
  collections, and unrelated API responses;
- access to a scoped variant only through its owning situation context;
- immutable release history for variant versions.

Behavior by content type:

- a scoped practice is embedded only for the owning situation and does not
  appear in the general practice index;
- a scoped guide is linked only from its owning situation and does not appear
  in the guide index, sitemap, feed, or unrelated recommendations;
- a scoped source is returned as that situation's citation and not as a
  duplicate global bibliography entry;
- scoped lesson plans and preparation prompts remain internal evidence and are
  never exposed through public routes;
- situation promotion metadata is inherently situation-owned and versions
  with the bundle.

Returning a situation to the shared original creates a new draft revision and
relationship change. It does not delete the historical variant.

Promoting a situation-scoped variant into a globally shared artifact is not
part of this pass.

### 9. Preserve the complete agent-review workflow as proposals

Rebuild the former 22-stage workflow:

1. map connected learning surfaces;
2. run seven independent critics;
3. run seven rebuttals;
4. adjudicate;
5. perform teaching design;
6. write one consolidated bundle proposal;
7. run semantic, teaching-alignment, and repository-integrity audits;
8. run deterministic repository/content validation.

The workflow runs in the separate review worker. By explicit production
decision on 2026-07-24, provider execution uses the user's existing
subscription accounts through pinned, non-interactive Codex and Claude CLIs:
Codex first, then Claude fallback. It does not require metered service API
keys. Exact CLI versions, model IDs, policy versions, and requested/resolved
providers are recorded operationally or with every agent run.

Production must not depend on an open desktop task or expose an administrator's
home directory. Both CLIs authenticate under the dedicated review-worker
operating-system user. The child environment excludes Studio database, web,
publisher, backup, and Leadership credentials. Claude tools are disabled.
Codex runs ephemerally in a per-call directory with user/project configuration
and rules ignored, a read-only sandbox, a stripped tool-command environment,
and strict structured output; only its temporary review request and schema are
needed.

Only one full review runs globally. Additional jobs queue FIFO. Queuing a job:

- requires the active situation checkout;
- flushes autosave;
- creates and pins an immutable input revision;
- records the exact context and contract versions;
- makes the situation read-only until the job succeeds, fails, or is
  cancelled.

Cancellation must fence late model results. Retrying resumes from the first
incomplete or failed idempotent step and does not rerun accepted successful
steps unless the user starts a wholly new review.

Persist:

- normalized evidence hashes;
- role, dependencies, and step state;
- requested and resolved provider/model;
- reasoning effort;
- structured output and output hash;
- token usage and whether it is estimated;
- failure classification;
- retry and cancellation provenance.

Models receive only the pinned situation bundle and the minimum connected
evidence. Treat instructions inside content as untrusted data. Models receive
no database, filesystem, Git, deployment, user, or provider-management
authority.

The final review proposal:

- is immutable;
- references the exact input draft revision;
- contains normalized findings, rationale, and exact proposed changes;
- distinguishes changes to the situation from proposed scoped-variant forks;
- can be accepted all at once or change by change;
- never changes the working draft without an editor action.

Accepted changes become ordinary immutable draft revisions. A manual edit
after proposal acceptance is no different from any other draft edit. Agent
review is never required for submission; production history records whether a
version was manual or agent-assisted.

### 10. Add coordinated Leadership schema and runtime support

Make additive changes in the Leadership repository and
`leadership_field_guide` schema to support:

- situation lifecycle/visibility needed for reversible retirement;
- situation-scoped variants and resolution;
- Studio publication provenance and idempotency;
- a least-privilege Studio official-release reader;
- a least-privilege Studio release publisher;
- expected-pointer-generation conflict checks;
- exact release validation and atomic promotion;
- safe restoration of the prior official release after failed verification;
- health responses that expose the safe official release ID and manifest hash
  without exposing secrets.

Keep the existing immutable full-release architecture. Studio does not update
an existing official or retired content record in place.

Every Studio submission creates a new complete Leadership release by:

1. reading the newest official release;
2. replacing only the selected situation bundle;
3. carrying all unrelated artifacts and typed records forward exactly;
4. rebuilding the complete canonical manifest and projection;
5. validating the whole release;
6. inserting it with a unique Studio publication ID;
7. atomically advancing the official pointer with an expected generation.

The publisher role may create and validate a new release and invoke the exact
promotion boundary. It may not:

- update or delete artifact membership in validated, official, or retired
  releases;
- delete production history;
- bypass validation;
- change schema;
- manage roles;
- read Studio passwords, sessions, or review-provider auth state.

Prefer database constraints, triggers, and narrowly scoped security-definer
functions for invariants that application checks alone cannot protect.

Additive migrations must preserve all existing content and release history.
Applying the schema migration must not change `CurrentRelease`, content bytes,
the official manifest hash, or rendered production output.

### 11. Publish with one small durable pipeline

Submission requires:

- an active checkout owned by the editor;
- the latest saved draft revision;
- no queued or running review for the situation;
- no active publication for the situation;
- deterministic validation over the exact draft bundle;
- one ordinary confirmation dialog.

The confirmation dialog shows:

- situation and action;
- current production version;
- proposed bundle version;
- changed sections and scoped variants;
- validation status;
- manual, agent-assisted, restoration, creation, or retirement provenance.

It does not request a password or typed phrase.

The publisher uses a durable, idempotent internal sequence:

1. `REQUESTED`
2. observe and lock the current official pointer generation;
3. compare the target situation's current production bundle with the draft's
   base;
4. automatically rebase when only unrelated situations changed;
5. block with `Needs refresh` when the target situation or one of its owned
   variants changed;
6. build and persist the complete candidate release snapshot in Studio;
7. run all deterministic validation with no override path;
8. insert and validate the immutable Leadership release;
9. atomically advance the official pointer;
10. verify the Leadership database reader and running application report the
    exact expected release ID and manifest hash;
11. record the production situation version and verification receipt;
12. check the situation in;
13. queue the post-publication encrypted backup.

The user-visible activity remains `Publishing`; internal step names are for
recovery and operations only.

If verification fails after pointer advancement:

1. atomically restore the prior complete official release;
2. verify the restored release;
3. record `Publish failed — previous production restored`;
4. keep the checkout and draft intact.

If automatic restoration cannot complete or cannot be verified:

- record `Recovery required`;
- block all further publication;
- preserve every job input and external observation;
- expose a concise administrator runbook;
- never guess or advance another release automatically.

Publisher restart and retry must reconcile by the unique Studio publication
ID, Leadership release ID, manifest hash, and official pointer generation
before causing another external write.

### 12. Make production history independently restorable

Studio stores one immutable production-history entry for every distinct
situation bundle that has appeared in Leadership production, including:

- existing releases imported during bootstrap;
- manual submissions;
- agent-assisted submissions;
- restorations;
- first publication of new situations;
- retirements;
- releases observed from outside Studio.

Each entry records:

- stable Studio situation identity and Leadership slug;
- complete situation-bundle manifest and hash;
- content-addressed bodies for the situation and all owned variants;
- Leadership release ID and manifest hash;
- official pointer generation when known;
- production timestamp;
- publisher or external-import provenance;
- contract and validation policy versions;
- source kind;
- restoration parent, when applicable;
- automatic diff summary and optional user note.

Backfill must be strictly read-only against Leadership:

- use a database role that has no write privilege;
- import official and retired releases that were formerly official;
- exclude rejected or never-published staged content from production history;
- preserve original release identities and timestamps where available;
- deduplicate identical per-situation bundle hashes;
- produce a parity report before committing the Studio bootstrap import.

The former `situation_studio` database was dropped and is not a dependency.
Offline legacy archives may be considered later only if the user supplies and
authorizes them.

Continuously reconcile Leadership read-only on:

- situation inventory load, subject to a short cache;
- checkout;
- submission;
- a periodic background observation.

Unknown official releases are decomposed into per-situation production
versions and marked `External production import`. Studio never automatically
rewrites Leadership to match its own history.

### 13. Restore one situation without reverting others

Restoration begins from the History surface and must:

1. acquire the situation checkout or require the existing holder;
2. select one immutable prior production situation version;
3. create a new draft lineage whose content and scoped variants match that
   historical bundle;
4. base eventual publication on the newest official Leadership release;
5. show the exact difference from current production;
6. allow further manual edits or a new agent review;
7. use the ordinary validation, confirmation, publication, verification, and
   recovery pipeline.

Restoration never moves the whole site pointer directly to an old release and
never changes unrelated situations. It creates a new full Leadership release
containing:

- the selected historical bundle for the target situation;
- the newest official versions of every unrelated artifact.

The resulting production entry is a new version with `RESTORE` provenance and
a reference to the selected historical version. History is forward-only.

### 14. Support creation and reversible retirement

**Creation**

- Create a Studio situation identity and acquire its checkout atomically.
- Start from a validated structured template.
- Require a unique, stable slug before first submission.
- Allow manual editing, scoped variants, optional agent review, preview, and
  validation exactly like an existing situation.
- The first successful submission creates its first production situation
  version.

**Retirement**

- Require the active checkout.
- Create a retirement draft rather than deleting content.
- Preserve the situation bundle and all production history.
- Build a new Leadership release in which the situation is non-public.
- Exclude it and its scoped variants from public indexes, routes, sitemap,
  feed, recommendations, and promotion output.
- Derive or filter shared reverse relationships so they do not create public
  dangling links.
- Record the retirement as a production situation version.

A retired situation remains visible in Studio and can be restored through the
ordinary restoration-draft flow.

There is no permanent delete operation for situations, drafts, proposals,
production versions, releases, or audit history in this pass.

### 15. Back up and operate the independent history

Initial-launch override, explicitly approved by the user on 2026-07-24:
production backup configuration is deferred. Readiness must expose
`backup.state = "deferred"` through the explicit
`SITUATION_STUDIO_BACKUP_READINESS_MODE=deferred` setting; it must not create or
claim a backup receipt. No production content publication is included in this
launch. Backup configuration returns to a required gate before the first
publication approval.

Before production deployment, configure:

- encrypted nightly `situation_studio` backups;
- an encrypted backup after every successful publication, restoration, or
  retirement;
- checksum verification;
- at least one copy outside RP1 and outside the PostgreSQL container;
- documented retention;
- a scheduled restore drill into a disposable database;
- safe admin-visible backup age and latest-restore status.

The exact off-RP1 destination is an operational input that must be selected
before the deployment checkpoint. It must not be invented or embedded in
source code.

Keep secrets outside release directories in mode-restricted environment or
credential files. Never put database URLs, API keys, password material, or
backup keys in:

- `NEXT_PUBLIC_*` variables;
- client bundles;
- logs;
- audit payloads;
- command arguments visible to other users;
- committed files.

The deployed processes are:

- `situation-studio-web`;
- `situation-studio-review-worker`;
- `situation-studio-publisher`.

The review worker owns isolated subscription CLI auth state but no Leadership
write access. The publisher has restricted Leadership release authority but no
review-provider, password, or session credentials. The web process has neither
review-provider auth nor direct Leadership publication authority.

### 16. Deploy only after a measured migration

Use disposable PostgreSQL databases and local processes for development and
verification.

Production deployment must:

1. verify clean, exact source commits in both repositories;
2. take encrypted pre-migration backups of both databases;
3. run read-only Leadership inventory and official-hash checks;
4. apply additive Leadership migrations;
5. prove the official pointer/hash and rendered output are unchanged;
6. create and migrate the new `situation_studio` database;
7. run the read-only history bootstrap and parity report;
8. start web, review worker, and publisher with separate roles;
9. verify auth, inventory, health, and read-only Leadership synchronization;
10. exercise publication only with a separately approved exact test situation
    and release procedure.

This spec does not authorize production deployment, schema mutation, content
publication, or restoration. Each production action requires later explicit
approval at the appropriate implementation checkpoint.

## Out of scope / do NOT touch

- Do not reintroduce candidate staging, a candidate hostname, candidate
  cookies, or a candidate runtime.
- Do not reintroduce human approval states or an approval queue. A future
  approval flow will be designed separately.
- Do not request password re-entry for submission, restoration, retirement,
  force-check-in, or user management.
- Do not restore the former Git-based Leadership publisher.
- Do not make the Leadership Git repository the production content authority.
- Do not restore the former private candidate handoff or exchange routes.
- Do not restore the former multi-step user-visible publication saga.
- Do not add a global capacity-management page.
- Do not let an agent apply edits, create variants, publish, restore, retire,
  force-check-in, manage users, or invoke network/mutation tools. The
  constrained Codex adapter may read only its temporary review request and
  schema within the dedicated review-user boundary.
- Do not allow validation bypasses.
- Do not edit a shared artifact globally from a situation checkout.
- Do not promote a situation-scoped variant to shared content in this pass.
- Do not add permanent deletion or history-purge controls.
- Do not expose internal lesson plans or preparation prompts publicly.
- Do not support public signup or anonymous editing.
- Do not redesign the public Leadership visual system except where scoped
  variant resolution or retirement filtering requires compatible behavior.
- Do not replace or recreate the shared PostgreSQL container.
- Do not write to the Leadership database during historical bootstrap.
- Do not mutate production databases or deploy either application while
  implementing local checkpoints without separate explicit authorization.
- Do not reset, overwrite, or stage the user's existing Situation Studio
  working-tree changes.

## Constraints

### Authority and isolation

- `leadership_field_guide` is the sole production content authority.
- `situation_studio` is the sole working-copy, review, and independent
  per-situation history authority.
- Leadership never reads Studio to render public pages.
- Studio preview never requires Leadership draft writes.
- Only the publisher process can use the Leadership publisher role.
- Only one official Leadership release exists at a time.
- Every Leadership official release is complete and immutable.
- One situation workflow cannot change another situation's resolved content.

### Concurrency

- At most one active checkout exists per situation.
- Checkouts are durable and have no time-based expiration.
- Every mutation requires the active checkout ID and current fencing token.
- At most one queued/running review exists per situation.
- At most one full review runs globally.
- At most one official-pointer publication transaction runs globally.
- Late review or publisher results are fenced and cannot mutate newer state.

### Versioning

- Canonical SHA-256 hashes identify content and bundles.
- Identical production situation bundles are not duplicated in history.
- Draft revisions, proposals, production versions, and audit events are
  immutable.
- Restoration and retirement are new forward-history production versions.
- Historical production content has indefinite retention in this pass.
- All timestamps are UTC `timestamptz`; public editorial dates retain their
  domain type.

### Validation

- Manual and agent-assisted paths use the same deterministic validators.
- Validation covers schemas, frontmatter, required section order, MDX
  allowlists, executable-content rejection, hashes, byte lengths, unique IDs,
  paths, slugs, relationship integrity, visibility, scoped ownership, typed
  projection parity, and complete-release parity.
- A release cannot become official when validation evidence is absent, stale,
  or for a different hash.
- Admins cannot bypass validation.

### Security

- Passwords use a reviewed memory-hard or equivalent password-hashing scheme.
- Sessions are opaque, revocable, server-side, and protected by secure cookie
  attributes.
- All browser mutations require CSRF protection.
- Database roles follow least privilege.
- AI evidence is treated as untrusted and minimized.
- Provider output is parsed through strict structured schemas.
- Secrets never enter content, model evidence, logs, audit payloads, or client
  code.

### Simplicity

- The editorial UI exposes checkout, edit, review, history, and submit—not the
  internal publisher steps.
- Agent review is optional.
- There is one production confirmation.
- There are no approval or staging states.
- Exceptional recovery states are visible and actionable rather than hidden.

### Technology

- Continue with Node.js 24, pnpm, Next.js 16, React 19, TypeScript, PostgreSQL
  16, and Prisma unless a checkpoint documents a verified incompatibility.
- Pin exact production dependency versions.
- Use checked-in Prisma migrations plus reviewed SQL for constraints, triggers,
  grants, and promotion functions Prisma cannot express.
- Use Testcontainers for disposable cross-database integration tests.

## Success criteria (testable)

### Authentication and permissions

- [ ] An active editor can log in with username/password and receives a secure
      server-side session.
- [ ] Invalid login attempts are throttled without revealing whether a username
      exists.
- [ ] Deactivating a user invalidates their active sessions.
- [ ] Editors can publish and restore but cannot manage users or force-check-in.
- [ ] Admins can manage users and force-check-in.
- [ ] No sensitive action requests password re-entry.
- [ ] Public signup does not exist.

### Checkout and drafts

- [ ] Two concurrent attempts to check out the same situation result in exactly
      one active checkout.
- [ ] A checkout remains active after the browser closes and after more than 30
      minutes without a heartbeat.
- [ ] Another user cannot edit, review, restore, retire, or publish a checked-out
      situation.
- [ ] A normal check-in preserves the exact latest saved draft and releases the
      lock.
- [ ] Re-checkout resumes that draft by default.
- [ ] `Start over from production` archives the old draft and creates a new
      exact production-based draft.
- [ ] Admin force-check-in preserves the draft, fences late jobs, and records
      actor and reason.
- [ ] Successful publication checks the situation in.
- [ ] Failed publication leaves the checkout and draft intact.

### Manual editing and preview

- [ ] Every required situation section and metadata field is independently
      editable.
- [ ] Raw MDX mode round-trips without changing canonical content unexpectedly.
- [ ] Autosave never loses a confirmed field or section edit.
- [ ] Preview renders entirely from Studio bytes.
- [ ] Current production and draft can be compared as rendered content and as
      an exact source diff.
- [ ] Studio preview writes no row to Leadership.

### Review workflow

- [ ] A review pins one immutable draft revision and complete context hash.
- [ ] The situation is read-only while its review is queued or running.
- [ ] Only one full review runs globally; later jobs remain FIFO.
- [ ] All 22 required stages are represented and durable.
- [ ] Cancelling a job makes the situation editable and fences late outputs.
- [ ] A worker restart resumes without duplicating successful steps.
- [ ] Only explicitly retryable provider failures receive two automatic
      retries, with a durable not-before schedule and immutable attempt
      history.
- [ ] Retry backoff remains cancellable and fenced, and releases the one global
      running slot without allowing an early post-restart claim.
- [ ] Retry scheduling records a bounded system audit and the workspace shows
      stage, safe class, attempt count, and scheduled time.
- [ ] Historical terminal provider failures do not indefinitely degrade
      readiness for a currently healthy worker.
- [ ] An authenticated same-origin `review-status-v1` SSE stream sends a full
      durable snapshot on connect/reconnect and changed snapshots only.
- [ ] Heartbeats, abort cleanup, bounded lifetime, native reconnection, and
      stale review/connection rejection do not affect worker authority.
- [ ] The workspace advances exact stage progress without reload, refreshes
      server data once on terminal state, and presents durable retry backoff.
- [ ] Review motion is restrained and reduced-motion safe; exact semantic
      progress and throttled polite announcements remain understandable
      without animation.
- [ ] Public review status excludes provider content, prompts, evidence, raw
      errors, logs, secrets, and internal fencing or claim data.
- [ ] Provider/model, effort, hashes, structured output, usage, and failure
      evidence are recorded for every run.
- [ ] A completed review creates one immutable proposal and does not change the
      draft.
- [ ] Accepting one proposal change changes only that section or artifact.
- [ ] Rejecting a proposal leaves the draft byte-identical.
- [ ] Accepting a shared-artifact change creates a situation-scoped variant
      rather than modifying the shared original.
- [ ] A manual-only draft can publish without an agent review.

### Scoped-variant isolation

- [ ] Editing a shared practice for one situation changes the rendered practice
      only in that situation.
- [ ] Every other situation referencing the original practice remains
      byte-identical.
- [ ] The scoped practice is absent from global practice indexes and unrelated
      APIs.
- [ ] Equivalent isolation tests pass for guides and sources.
- [ ] Lesson-plan and preparation-prompt variants remain inaccessible through
      public routes.
- [ ] Variant provenance identifies owner, forked-from logical ID, and base
      content hash.
- [ ] Returning to the shared original does not delete the historical variant.

### Publication

- [ ] Submission cannot start without the active checkout, latest revision, and
      passing exact-hash validation.
- [ ] The user sees one confirmation dialog and no password or typed-phrase
      prompt.
- [ ] Unrelated production releases are automatically carried forward.
- [ ] A competing production change to the target situation blocks publication
      with `Needs refresh`.
- [ ] A successful submission creates one new complete immutable Leadership
      release and advances the official pointer once.
- [ ] Unrelated situations in the new release are byte-identical to the
      immediately preceding official release.
- [ ] Retrying after crashes before and after release insert, pointer promotion,
      and verification creates no duplicate logical publication.
- [ ] Leadership health reports the expected official release ID and manifest
      hash before Studio reports success.
- [ ] A simulated post-promotion health failure restores and verifies the prior
      official release automatically.
- [ ] A simulated failed recovery enters `Recovery required` and blocks further
      publication.
- [ ] No publication path edits a validated, official, or retired release in
      place.

### History and restoration

- [ ] Read-only bootstrap imports every recoverable formerly official
      Leadership release without changing Leadership data or pointer state.
- [ ] Identical situation-bundle hashes across site-wide releases appear once
      in that situation's history.
- [ ] Every distinct production situation version includes complete restorable
      bytes, relationships, scoped variants, hashes, and provenance in Studio.
- [ ] Unknown external official releases are ingested and marked external.
- [ ] Selecting a historical version creates a draft rather than changing
      production immediately.
- [ ] Restoring one situation preserves the newest production versions of all
      other situations.
- [ ] The restored production version records its historical parent.
- [ ] Production-history rows and referenced blobs cannot be updated or
      deleted through application roles.

### Creation and retirement

- [ ] A new situation begins as an exclusively checked-out validated template.
- [ ] Duplicate production slugs are rejected before publication.
- [ ] First publication makes the situation public and records version one.
- [ ] Retirement removes the situation and its scoped variants from all public
      discovery and direct content routes without deleting history.
- [ ] Retirement produces no public dangling relationships.
- [ ] A retired situation can be restored through the ordinary draft and
      submission flow.

### Migration and operations

- [ ] Leadership additive migrations leave the pre-migration official release
      ID, manifest hash, content bytes, route contracts, and rendered pages
      unchanged.
- [ ] The Studio bootstrap connection is physically incapable of writing to
      Leadership.
- [ ] Web, review worker, and publisher run with distinct database roles and
      credential sets.
- [ ] Killing any one process does not grant another process its missing
      privileges.
- [ ] Liveness, readiness, review-provider health, publisher reconciliation,
      Leadership observation, and backup age have safe health signals.
- [ ] An encrypted Studio backup is produced and checksum-verified.
- [ ] A documented restore drill recreates all production situation versions
      in a disposable database.
- [ ] No secret appears in source, build output, browser assets, logs, audit
      payloads, or generated reports.

### User experience

- [ ] A new editor can identify the checkout owner and next available action
      from the inventory without documentation.
- [ ] The normal path is visible as `Check out → Edit or run review → Submit`.
- [ ] The UI never presents candidate, approval, or staged-publication language.
- [ ] All critical workflows are keyboard-operable and pass automated
      critical/serious accessibility scans.
- [ ] Inventory and workspace do not overflow at 1280×800 or 1440×900.
- [ ] Mobile inspection, check-in, cancellation, and emergency admin actions
      remain usable.

## Verification plan

### Ground truth

Use the current Leadership repository, Prisma schema, immutable release
constraints, content validators, official release pointer, content health
route, and rendered public routes as ground truth.

Before implementation changes:

1. capture the current official release ID, hash, counts, and typed projection;
2. capture representative rendered pages and route responses;
3. record current database grants and immutability constraints;
4. retain the current clean Leadership commit identity.

After every additive Leadership migration, compare those captures. Any
unexplained change blocks the checkpoint.

### Automated verification

Add:

- unit tests for status derivation, hashes, manifests, section parsing,
  proposal application, variant resolution, history deduplication, and
  conflict decisions;
- database constraint tests for checkout uniqueness, fencing, immutability,
  idempotency, role grants, and pointer promotion;
- Testcontainers integration tests running independent `situation_studio` and
  `leadership_field_guide` databases;
- migration tests against a sanitized production-shaped Leadership dump;
- API/route contract tests;
- browser tests for inventory, checkout, durable check-in, force-check-in,
  autosave, review queue, proposal selection, preview/diff, submission,
  history, restoration, creation, retirement, and recovery states;
- crash-injection tests around every external publication boundary;
- deterministic fake-provider tests for the complete 22-stage DAG;
- separately invoked live-provider qualification that is never required for
  ordinary deterministic CI;
- backup/restore tests into a disposable database;
- secret scanning over source, artifacts, logs, and browser bundles.

### Cross-database invariants

For every successful publication test, assert:

1. Studio's exact publication ID maps to one Leadership release.
2. The Leadership official pointer names that release.
3. Studio's production situation version bundle hash equals the target bundle
   inside the Leadership release.
4. Every unrelated situation bundle equals the preceding official release.
5. Leadership's running reader reports the exact expected release and hash.
6. The checkout is released only after all prior assertions pass.

For every restoration test, additionally assert that only the target
situation's resolved bundle changes.

### Read-only bootstrap proof

Run bootstrap with a database role granted only the required `SELECT`
privileges. Record before/after:

- official pointer row;
- release count and state counts;
- artifact and typed-row counts;
- manifest hashes;
- database transaction write attempts, which must fail.

The imported Studio history must produce a parity report listing every
Leadership release and its derived per-situation bundle hashes.

### Visual and accessibility verification

Render and inspect the inventory, edit, review, history, login, user admin, and
recovery surfaces at:

- 1280×800;
- 1440×900;
- one narrow mobile viewport.

Test keyboard navigation, focus return, dialogs, tab order, error association,
screen-reader names, reduced motion, zoom, long titles, long diffs, and large
agent findings.

### Independent review

Before production deployment, run an independent architecture/security review
against this spec, concentrating on:

- cross-database authority;
- publisher grants;
- immutable history;
- checkout and fencing races;
- copy-on-write isolation;
- crash recovery;
- secret separation;
- no-write bootstrap proof.

Record findings and their dispositions. Unresolved high-severity findings
block deployment.

## Checkpoints

### Checkpoint 1 — Contract and data-model design

- Finalize Studio entities, Leadership additive entities, bundle manifest,
  scoped-variant resolution, status derivation, and database roles.
- Produce schema diagrams, role/grant matrix, and transition tables for
  checkout, review, and publication.
- Validate the design against the current Leadership schema and full content
  graph.
- Stop and show the user before writing migrations.

### Checkpoint 2 — Studio foundation

- Implement the new Studio database, migrations, auth, roles, sessions,
  inventory synchronization, checkout, drafts, revisions, and audit.
- Use only disposable/local databases.
- Verify durable checkout, check-in, resume, reset, and force-check-in.
- Stop and show the user before building the editor.

### Checkpoint 3 — Manual editor, preview, and history

- Implement section editing, raw MDX, autosave, rendered preview, diff,
  production-history import, comparison, and restoration drafts.
- Prove that bootstrap is read-only against a disposable Leadership clone.
- Stop and show the user before adding AI execution.

### Checkpoint 4 — Review worker and proposals

- Implement the global queue, complete 22-stage durable DAG, cancellation,
  retry, proposal display, selective acceptance, and scoped-variant creation in
  Studio.
- Verify with deterministic providers and separately qualify the configured
  live provider route.
- Stop and show the user before changing Leadership schema.

### Checkpoint 5 — Additive Leadership support

- Implement versioned shared contracts, scoped visibility/ownership,
  retirement behavior, publisher provenance, restricted roles, promotion
  functions, and safe health identity.
- Run migrations only on disposable and sanitized production-shaped databases.
- Prove official content and rendering parity.
- Stop and show the user before connecting the publisher.

### Checkpoint 6 — Publisher and recovery

- Implement full-release assembly, validation, optimistic rebase, conflict
  blocking, idempotent promotion, verification, automatic restoration, and
  recovery-required fencing.
- Verify publication, crashes, and per-situation restoration end to end across
  two disposable databases and running app processes.
- Stop and show the user before operational/deployment work.

### Checkpoint 7 — Creation, retirement, operations, and backups

- Complete new-situation and retirement flows.
- Add health, admin operations, encrypted backups, restore drill, runbooks,
  process configuration, and deployment automation.
- Complete accessibility, browser, security, and independent reviews.
- Stop and show the user the complete local release candidate and evidence.

### Checkpoint 8 — Production migration and deployment

- Requires a separate user approval for exact commits, backup destination,
  migration evidence, and deployment procedure.
- Apply additive Leadership migration without changing official content.
- Create and bootstrap `situation_studio` read-only from Leadership.
- Deploy the three Studio processes and verify observation/auth only.
- Any real production content publication requires a separately named test
  situation and explicit approval.

## Working rules

- Verify before acting: re-read the official Leadership pointer, schema,
  grants, and repository state before every migration or publication step.
- Do not assume: surface any implementation discovery that contradicts this
  spec before changing course.
- Do not hide confusion: record unresolved invariants, failed probes, and
  recovery uncertainty explicitly.
- Make the smallest change that satisfies the current checkpoint.
- Do not over-engineer future approval or global shared-content workflows.
- Preserve the user's existing Situation Studio working-tree changes.
- Keep production databases read-only throughout local implementation.
- Never deploy or mutate production from this spec alone.
- Use exact hashes, IDs, generations, and idempotency keys rather than names or
  timestamps as mutation preconditions.
- Prefer immutable append-only records and forward recovery.
- Treat model output as untrusted input requiring schema and deterministic
  validation.
- Stop at every checkpoint and present evidence before continuing.
