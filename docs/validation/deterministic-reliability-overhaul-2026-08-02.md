# Deterministic review-to-publication reliability overhaul

Date: 2026-08-02
Status: deployed on 2026-08-04 as immutable Situation Studio release
`20260804T181727Z` at commit
`b43edd4f5b00183e1ae1f0617937aa5a08ed7539`; authenticated in-app browser
validation completed on 2026-08-04

## Acceptance statement

The deployed implementation now uses one complete publishable snapshot and one
Leadership-owned deterministic compiler/validator from save through review,
proposal decisions, publication preflight, publisher promotion, and runtime
verification. The release-like journey proved that the candidate previewed by
the editor, adopted revision, sealed preflight, publisher input, Leadership
release artifacts, and typed runtime response have identical identities.

The approved additive Studio migration and application cutover changed the
production schema/runtime only. No real situation, review, proposal decision,
publication, or official Leadership pointer was changed. Pre-release database
and runtime acceptance used disposable local services; the production evidence
below is read-only except for the reviewed migration, grants, backup, process
restart, and immutable cutover sequence.

## 2026-08-04 live capability-digest diagnosis

Read-only capture from the deployed Leadership origin returned HTTP 200,
`Content-Type: application/json`, `Cache-Control: no-store`, chunked transfer,
and a 1,524-byte JSON entity with SHA-256
`a9679dd4b1e42bf4c6836fbd9dcd249c581cd66cf56ca1650faedd0bb5e74866`.
The entity has no trailing newline. Every leaf value in the live payload is a
string; `features` is the only array and its five entries are strings. There
are no numbers, booleans, nulls, undefined values, or non-ASCII strings in the
live response.

Leadership excludes only `capabilityDigest`, recursively sorts object keys
with `localeCompare`, preserves array order, serializes with `JSON.stringify`,
appends exactly one newline, and passes the resulting JavaScript string to
Node's SHA-256 implementation, which encodes it as UTF-8. The live canonical
payload is 1,439 bytes and hashes exactly to the reported
`202d13e3a5996f6b827b558db3cf5556eac4ba89bc052ce8a35a3ec93e74ab22`.
The HTTP headers, compact response-key order, transfer chunk framing, and lack
of a response newline are not digest inputs. JSON cannot carry `undefined`;
the helper would serialize object-valued `undefined` like `JSON.stringify`
(omitted), array-valued `undefined` as `null`, and explicit `null` as `null`.

The deployed Studio commit `328f9a8...` parses before hashing with a Zod schema
that does not name `contracts.publicationCompiler`. Default object coercion
strips that complete live object, and the truncated 0.2-era projection hashes
to `6476a9e22f9281ea66fac878458c0b6f5beb85f47335e3fba1b256f55532024e`.
That field-selection change—not Leadership serialization, encoding, or key or
array ordering—causes the operator-facing invalid-digest error. The pushed
`3da97f9...` candidate names the field and accepts the live response; the
successor additionally preserves future additive digest-covered fields at all
object boundaries and retains exact identity checks.

Producer and consumer fixtures contain the same complete live JSON object and
have matching fixture-file SHA-256
`b7859b9bffa8d2e2112a54fba53376e98fb2f829087ee9fa24e3d320c1722ee1`.
Focused producer tests pass 4/4. Focused Studio capability and readiness tests
pass 12/12, including additive top-level, deployment, and contracts fields,
explicit null and Unicode values, exact response/canonical byte lengths, and
truthful readiness classification. Complete gates passed on 2026-08-04:
Leadership passed 27 contract tests, 87 unit tests, 14 disposable-database
integration tests, and 74 executed browser/database scenarios with 18
intentional platform-scope skips; Studio passed formatting, lint, all
typechecks, 471 unit tests, secret scanning, production build, all 82
disposable-database integration tests, and 16 browser tests with 8 intentional
project-scope skips against disposable Studio and Leadership databases.

The first production preflight for exact candidate `16e6050...` stopped before
release creation because the old deployed readiness route necessarily reaches
the fixed consumer only after cutover. The successor launcher therefore adds a
one-time, exact-old-commit capability transition rather than a general bypass.
Its contract tests prove that normal deployment still rejects every non-200
current readiness response; the transition additionally requires direct
read-only web-role database proof, the exact diagnosed private/no-store 503,
and an isolated candidate 200/`ready` proof on loopback port 3016 before any
quiescence or migration. Candidate background reconciliation is disabled for
that bounded probe so the readiness proof performs no synchronization write.
The typed probe evidence is retained in the immutable candidate release.

After this transition implementation, the complete Studio source gate passed
48 files/471 unit tests, formatting, lint, every workspace typecheck, secret
scanning, and the production build. All 82 integration tests passed against
disposable Studio and Leadership databases, followed by 16 executed browser
passes and 8 intentional project-scope skips at 1280px, 1440px, and 390px.
The exact transition-state helper also passed read-only against production as
the protected web user before commit or deployment.

## 2026-08-04 production deployment evidence

Exact preflight against commit `b43edd4f5b00183e1ae1f0617937aa5a08ed7539`
passed with four active checkouts, no queued/running review, no active
publication, no unfinished publication attempt, no recovery-required job, the
verified encrypted off-site backup and passed restore receipt, and the exact
Leadership runtime/content identities. The public gate remained 403 with
`private, no-store`.

Attempt `20260804T180816Z` created and built an immutable candidate but stopped
before quiescence, backup, migration, or pointer change because the isolated
candidate helper looked for the pnpm-installed Next.js binary at the workspace
root. Commit `b43edd4...` corrected both the binary path and working directory
to `apps/web`, added line-specific failure diagnostics and a contract test,
then passed all 471 unit tests, formatting, lint, typechecks, secret scan, and
production build. The corrected helper ran directly against the built failed
attempt and proved `live=200` and `ready=200` before the successor deployment.

Release `20260804T181727Z` recorded candidate receipt
`candidate-readiness-transition-v1` with 200/200 status, quiesced the old
runtime, created verified encrypted off-site backup receipt
`ac3531c5-2820-4c6c-83d2-bc0ae2cee055` (821,318 bytes, checksum
`4fd9cb568e47d1747f7e5d3a4d58dd80927ac79c1dd72aa4ffb6c24fcde36af0`),
applied migration `20260802120000_deterministic_publication_preflight`, applied
the reviewed grants, and cut over all three processes. The current pointer,
release marker, and process working directories are exact; all processes are
online with zero restarts, live/ready are 200, backup evidence is `READY`, and
the public gate is still 403/private/no-store.

All eight migration triggers are enabled and every required post-grant
privilege check is true. The continuity receipt has identical before/after
review hash
`517820e7c9502c99a31d2031f8316ac57210900c5cb37dfc9932eebdff974e9e`
and matching lane hash
`21806f654e0f906f3f7a512112646c1a1f0bd044a6fcb14769c5cb352e7e7e36`.
The same four checkout IDs, fences, revision numbers, and bundle hashes remain;
all active-work and recovery counts are zero. New preflight/candidate tables
remain empty.

Post-cutover Leadership verification proved the application release, official
release ID, manifest, generation, 33-artifact/99-edge inventory, 361,396-byte
total, artifact-set hash, edge-set hash, API inventory, sitemap, feed, and
unaffected-route bytes are unchanged. The typed verification proof is 200,
`application/json`, and `no-store`.

Authenticated in-app browser validation completed with the product owner's
signed-in administrator session. The 1440×1000 and 390×844 checks covered
Inventory, Operations, and the existing `defensive-about-feedback` Review
workspace without page-level horizontal overflow or browser warn/error logs.
Inventory showed 15 situations, four checked out, and zero drafts waiting.
Operations showed review queue 0, publication recovery 0 active, current
Leadership observation, ready backup evidence, the verified deployment backup
receipt, and four held checkouts. The read-only workspace retained `All changes
saved`, its stopped review at 18 of 24 stages, `0 changed sections`, and
`Rendered content matches`. No content, review, proposal, publication, account,
checkout, or other state-changing control was activated.

After browser validation, the immutable current pointer and release commit
remained exact, no deployment lease existed, all three PM2 processes were
online with zero restarts from the exact release directory, live and ready
remained healthy, and the public gate remained 403 with `private, no-store`.
The final read-only database tuple was `4|0|0|0|0|0|0` for active checkouts,
active reviews, active publications, unfinished attempts, recovery-required
jobs, preflight receipts, and candidate artifacts.

## 2026-08-04 exact-source comparison follow-up

Status: deployed on 2026-08-05 as immutable release `20260805T061524Z` at
commit `2a72025241df0664b052d534bcb55c5cebb120f8`.

Authenticated read-only production inspection reproduced the Review anomaly on
`stop-taking-delegated-work-back`. The RSC payload referenced four independently
serialized source values:

| Value                 | RSC reference | UTF-16 length | UTF-8 bytes | Boundary bytes          |
| --------------------- | ------------- | ------------: | ----------: | ----------------------- |
| Current draft         | `$13`         |         3,131 |       3,185 | leading LF, trailing LF |
| Production            | `$14`         |         3,131 |       3,185 | leading LF, trailing LF |
| Retained review input | `$15`         |         3,131 |       3,185 | leading LF, trailing LF |
| Production history    | `$16`         |         3,131 |       3,185 | leading LF, trailing LF |

All four values were byte-identical with SHA-256
`321df3ee13ec100f1bb85a14c6028b100d8781305f2710100db07a152b8230ac`.
No source value was null or empty. The active review had `proposal: null` and
the latest publication was null, both expected for the retained failed job.
Its compatibility projection was valid `review-status-v4`: 24 total stages,
18 succeeded, Bundle Writer ordinal 19 failed on attempt 3,
`REVIEW_JOB_DEADLINE_EXCEEDED`, no retry, no proposal, and
`laneState: RELEASED`.

The browser diff contained two siblings: one `diffRemoved` block whose complete
value was a single LF, then one unchanged 3,130-character block. It contained no
addition. The section parser deliberately ignores the leading blank line, so
the section count stayed zero and both rendered panes looked identical. The
accessibility snapshot flattened the one-byte removal marker and the following
unchanged block, making the complete source appear removed. The defect was the
client comparison input: it passed an immediate parse-and-reserialize projection
instead of the exact saved body. The diff library, server response, database
content, and retained legacy-review coercion were correct. A second client
presentation defect hard-coded “lane is paused” in the terminal announcement
despite the valid released-lane projection. Direct and clicked Review tabs had
correct URL, focus, `aria-selected`, roving `tabindex`, `aria-controls`, and
tabpanel labelling.

The candidate now retains the exact server-confirmed body separately from the
section editor, preserves it until body content is actually edited, and compares
production against that saved value. Successful saves/adoptions advance the
saved value; a metadata-only save leaves MDX bytes unchanged. Terminal review
announcements describe the released lane. Production data, review evidence,
schemas, and Leadership remain unchanged.

Verification performed:

- Focused source-state, rendered-comparison, and review-status tests passed 18
  of 18.
- `pnpm verify` passed contract and review-policy verification, Prisma
  generation, formatting, lint, every workspace typecheck, 49 unit-test
  files/474 tests, secret scanning, and the optimized production build.
- `pnpm test:integration` passed all 5 files/82 tests against disposable
  PostgreSQL 16 databases and a disposable clone of exact compatible Leadership
  commit `d15a92b...`.
- `pnpm test:browser` rebuilt the production web bundle and passed 19 executed
  tests with 8 intentional duplicate-mutation skips across 1280px, 1440px, and
  390px. The new regression proves an untouched leading-LF fixture has no
  synthetic source change, and the existing metadata-save journey now proves
  the authoritative body bytes remain unchanged.
- Separate in-app browser inspection used the same compiled local build at
  1440×1000, 735×900, and 390×844. Every layout had equal document client and
  scroll widths, zero source additions/removals, `Rendered content matches`,
  correct selected/focused Review semantics, and no browser warn/error logs.

The disposable server, databases, containers, and Leadership fixture were
removed after acceptance. The primary dirty Leadership checkout was only
inspected read-only and retained exactly its pre-existing changes.

## 2026-08-05 exact-source deployment evidence

The product owner authorized exact commit
`2a72025241df0664b052d534bcb55c5cebb120f8`. It was pushed to `origin/main`,
and the guarded preflight passed against the unchanged Leadership application
release `20260802T185408Z` / commit `d15a92b8e91967f85a8b78ee7c2146a2154a56c0`,
verified backup/restore boundary, application roles, process configuration,
host capacity, and protected public gate. The full launcher repeated the
complete source gate: 49 unit-test files/474 tests, formatting, lint, every
workspace typecheck, secret scanning, and the optimized production build.

Immutable release `20260805T061524Z` built successfully on `rpi1`, quiesced the
three Studio processes, and created verified encrypted off-site backup receipt
`edf57af3-33ee-4985-a6e3-08f45009ce9f`. Its object is
`situation-studio-20260805T061656Z-edf57af3-33ee-4985-a6e3-08f45009ce9f.dump.gpg`,
SHA-256 `71266262cf84a62dcb858fbf20161c49157d28c992b6dc651ce3a78f71d74904`,
and 828,180 bytes. The active-review projection remained exact at
`a010a22b39a80745d6ae74bff47d7f9469bc848bedda1fa261aa20908316fa88`;
the expected and actual lane hashes both remained
`21806f654e0f906f3f7a512112646c1a1f0bd044a6fcb14769c5cb352e7e7e36`.
No migration was pending. The launcher reapplied the reviewed grants and cut
over successfully.

The current pointer, `.release-commit`, and all three PM2 working directories
name the exact new release. Web, review worker, and publisher are online with
zero restarts. Local live and ready return 200; readiness reports the exact
Leadership commit and digest, fresh worker heartbeats, zero publisher recovery,
and `READY` backup evidence with a passed restore drill. The unauthenticated
public probe returns 403 with `private, no-store`, and no deployment lease
remains.

Authenticated in-app validation of the retained
`stop-taking-delegated-work-back` workspace passed at 1440×1000, 735×900, and
390×844. Every viewport had zero page-level horizontal overflow, zero
`diffRemoved` nodes, zero `diffAdded` nodes, `0 changed sections`, and
`Rendered content matches`. The live region said the review lane was released.
Clicked and ArrowLeft/ArrowRight-selected tabs kept correct URL, focus,
`aria-selected`, roving `tabindex`, `aria-controls`, and tabpanel labelling.
The browser warn/error log was empty. No state-changing control was activated.
The final read-only database tuple was `4|0|0|0|0|0|0` for active checkouts,
active reviews, active publications, unfinished attempts, recovery-required
jobs, preflight receipts, and candidate artifacts.

## Architecture accepted

- `situation-bundle-v2` is the canonical Studio revision. Its hash covers all
  Leadership publication inputs: complete frontmatter, visibility and
  promotion intent, exact MDX and managed-component properties, practice ID
  and variant, authorship/reviewer fields, field-note and safety-note flags,
  review status, sources, related situations, complete relationships, and
  content-addressed scoped artifacts with provenance.
- Leadership owns the pure snapshot validator and compiler. Studio runs the
  validator after save, review candidate construction, and proposal
  application; preflight and publisher use the compiler, which invokes that
  same validator. `PracticeEmbed` and `PreparedAction` are checked through MDX
  AST traversal rather than regular expressions.
- Saves and all action commands are exact revision-ID/bundle-hash compare-and-
  swap operations. Reviews pin immutable input. Proposal decisions apply
  atomically and return the authoritative resulting revision for immediate
  client adoption; stale or superseded work is explicit.
- Review is four bounded stages: context mapping, integrated critical review,
  typed candidate construction, and typed exact-candidate audit. The server
  owns IDs, before-hashes, modes, and patches. Blocking audits prevent success,
  at most one repair is allowed, malformed suggestions are isolated when safe,
  and terminal reviews release the global lane.
- Preflight compiles and seals the exact complete artifact set with the Studio
  revision, bundle, Leadership base release/generation, contract identities,
  validation result, candidate identity, projection, and affected-route
  expectations. Publication requests must name that still-current receipt.
- Publisher claims and every mutation are claim-token fenced. It recompiles
  the sealed receipt, proves exact bytes, renews the claim in the same
  transaction that persists a receipt-backed candidate snapshot, reconciles
  ambiguous promotion outcomes from durable Leadership state, retries only
  bounded transient verification failures, restores on definitive mismatch,
  verifies the typed no-store route, and finalizes Studio atomically and
  idempotently.
- Deployment sequencing quiesces web publication writes, drains and stops the
  old publisher, applies the additive migration, verifies grants/schema, and
  only then cuts over. A committed migration deliberately leaves an older web
  release fail-closed for new publications.

## Exact contract and release-like identities

| Identity                             | Accepted value                                                     |
| ------------------------------------ | ------------------------------------------------------------------ |
| Content contracts package            | `@leadership-field-guide/content-contracts` 0.3.0                  |
| Content contracts archive SHA-256    | `ef9a723608977b3f9ea3c25bd1a7cd5f323871854937c0e462a21ca057ee9f7f` |
| Validation policy SHA-256            | `9131270fbc6a2e579ee10752fddf3f1f133b257a554666ea946bb76439deceee` |
| Validator digest                     | `0104cd5e4f02ed5172ca5b7c14e31a694e11319e703cbeb3eec4d226518fc53a` |
| Compiler identity                    | `leadership-publication-compiler-v1`                               |
| Compiler digest                      | `5a0b47948760e9134eaac1727bc658de56c87e52bcc9e03db424bb80ea2d4c95` |
| Typed route proof                    | `affected-route-proof-json-v1`                                     |
| Situation contract                   | `@leadership-field-guide/situation-contract` 1.0.0                 |
| Situation contract archive SHA-256   | `9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4` |
| Disposable Leadership release ID     | `b25f725b-8a88-48bd-b8ae-d56abcce2227`                             |
| Disposable Leadership manifest       | `2c2aa989cb5936c0e5e97374640805f28e88e187319a515ec2a4967d992f11b8` |
| Disposable pointer generation        | `1`                                                                |
| Disposable runtime capability digest | `0cb34306568690cef4f31572ed225e9c6a2d7ece91c7d26cb67a394646ae7856` |

The disposable Leadership fixture contained 32 artifacts, 99 edges, and 15
situations. The manual browser preflight used its real capability endpoint and
compiled the typed affected-route expectations. The release-like publisher
then exercised the typed verification route after disposable promotion. These
identities are local evidence, not an approval to deploy them.

## Migration and rolling compatibility

Migration:
`20260802120000_deterministic_publication_preflight/migration.sql`
SHA-256:
`4e52a104b1eeae504cc25e6ac6450e4af2065cbeffc8e7dee76897cd34cd60ff`

The migration adds and backfills exact review/proposal revision fences,
one-way proposal supersession, immutable preflight receipts and candidate
artifacts, candidate snapshots, attempt identities, and publisher job/claim
identity. Database triggers verify immutable evidence and support retained
review/proposal insert shapes during migration-before-cutover.

Fresh application of all 11 Studio migrations passed. Upgrade/backfill tests
also passed for retained review/proposal rows and historical publication jobs.
Historical publication jobs are marked explicitly; new receipt-less jobs are
rejected. The old publisher must drain before migration. The old review worker
may continue through the additive schema window, but only persisted legacy
stage graphs whose pinned input is already v2 may finish after cutover.

Retained v1 drafts are synchronized from their pinned production base by a
fenced v2 action checkpoint before a new review. Direct v1 review API and
worker ingress fail closed. Older v2 revisions with `UNPUBLISHED` intent need
the explicit forward-only **Set public intent** action.

## Verification performed

### Situation Studio

- `pnpm verify`: contract archive/digest verification, Prisma generation,
  formatting, lint, all workspace typechecks, 48 unit-test files/471 tests,
  secret scanning, and production build passed.
- `pnpm test:integration`: 5 files/82 tests passed against disposable
  PostgreSQL, including fresh migration, upgrade/backfill compatibility,
  deterministic preflight, publisher recovery, and the release-like journey.
- Focused publisher integration: 47/47 passed after receipt-backed candidate
  snapshot and legacy-fixture regression coverage.
- Focused release-like integration: 2/2 passed before the complete integration
  run, which passed all 82 tests.
- Focused review integration: 20/20 passed before the complete integration
  run.
- `pnpm test:browser`: 16 executed tests passed and 8 intentional duplicate
  project-scope cases were skipped. Playwright built the production web app,
  ran it behind a local HTTPS proxy, and covered desktop 1280, desktop 1440,
  and mobile 390 projects with captured console/page-error failure gates.
- `pnpm contracts:verify`, the focused 22-test deployment contract,
  `bash -n deploy.sh`, formatting, and `git diff --check` passed in the final
  evidence pass.

The release-like integration used two disposable PostgreSQL databases, the
real Leadership migrations/import/roles, an actual Leadership production
build and `next start` runtime, the real four-stage review orchestrator with a
local deterministic typed provider, actual proposal acceptance and preflight,
and the real publisher. It changed one SECTION through the review path and did
not inject proposal rows or mock publication. Assertions bound exact body,
artifact, candidate, manifest, receipt-backed candidate snapshot, release,
and typed runtime identities. A separate regression proved retained v1 input
must synchronize to v2 before review.

### Leadership

- Full `pnpm verify` passed: 27 contract tests, 87 unit tests, 14 disposable-
  database integration tests, and 74 executed database/browser scenarios with
  18 intentional platform-scope skips, plus Prisma validation, lint,
  typecheck, content validation, and production build.
- The release-like runtime returned 200 from health and capabilities, exposed
  the exact contract/compiler/validator/route-proof identities above, served
  the typed route with `no-store`, and converged on the promoted disposable
  release in the end-to-end test.

### In-app browser acceptance

After the complete Playwright run, the same compiled web build was inspected
separately in the Codex in-app browser against the disposable Studio database
and live disposable Leadership runtime.

- At 1440×900, inventory, an exact checked-out workspace, structured fields,
  Studio-byte preview, and the publication dialog rendered without page-level
  horizontal overflow.
- The official `repeatedly-misses-commitments` fixture was checked out and its
  exact preflight passed. The dialog showed **Validation passed**, candidate
  `02490462…a1451f`, Leadership base `2c2aa989…2f11b8`, and generation 1.
  Inspection stopped at **Keep editing**; **Confirm submission** was never
  activated.
- At 390×844, the inventory used its narrow card/sort layout and the complete
  preflight dialog fit without page-level horizontal overflow.
- Browser console warnings/errors after these journeys: 0.
- The in-app browser rejects the harness's ephemeral self-signed certificate,
  so this separate visual pass used the same compiled production build over
  loopback HTTP with the test-only transport bypass. The complete Playwright
  suite independently exercised the release harness's HTTPS proxy and the
  production HTTPS guard.

## Intentionally disabled or fail-closed behavior

- Automatic global relationship rebinding remains manual-only.
- New v2 scoped-variant review suggestions remain manual-only because their
  intent cannot yet carry every linked artifact identity.
- Scoped source-body overrides remain disabled because source identity is
  catalog-wide.
- A scoped guide candidate that cannot be represented exactly is rejected.
- Direct v1 review ingress is rejected until a fenced v2 synchronization
  checkpoint is created and adopted.
- New receipt-less publication requests are rejected, including requests from
  an older web release after this migration.
- Review remains optional; publication's deterministic gates do not depend on
  a model review having occurred.

## Remaining risks and operational boundary

- The Studio candidate is isolated from the dirty source worktree but is not an
  immutable pushed release until its exact commit is created and verified. The
  pushed Leadership-compatible release must be deployed and verified before
  Studio, using the exact gated identities and quiesce/drain procedure.
- The deterministic end-to-end review adapter exercises the real worker state
  machine with typed model outputs but does not make external Codex or Claude
  subscription calls; provider transport and credentials remain a separate
  operational concern.
- The local browser TLS certificate is self-signed. Playwright explicitly
  trusted it for release-harness validation; no public proxy or certificate was
  changed.
- No real publication, production restoration, or production data mutation
  was attempted. Production convergence still requires separately authorized
  deployment and test-publication evidence.

No remaining local correctness failure was found in the requested flow.

## Changed-file manifest

The release candidates contain the paths below. Files marked **overlap**
already contained user changes before this overhaul; only reviewed overhaul
hunks were forward-ported into the isolated Studio candidate. The unrelated
Studio inventory work (`apps/web/src/app/page.tsx`,
`apps/web/src/components/situation-inventory.tsx`, and
`apps/web/test/situation-inventory.test.ts`) remains only in the original dirty
worktree and is excluded from this 71-path release. The preserved Leadership
artifacts are listed so the complete source-worktree boundary is unambiguous.

### Situation Studio — overlap files

- `CHANGELOG.md`
- `HANDOFF.md`
- `README.md`
- `apps/web/src/app/studio.css`
- `docs/runbooks/production-migration.md`

### Situation Studio — root evidence and documentation

- `CROSS-REPOSITORY-RELIABILITY-INVESTIGATION.md`
- `SPEC-cross-repository-reliability-investigation.md`
- `SPEC-situation-studio-redesign.md`
- `docs/architecture.md`
- `docs/checkpoints/01-contract-and-data-model.md`
- `docs/checkpoints/04-review-worker.md`
- `docs/checkpoints/05-leadership-additive-support.md`
- `docs/checkpoints/06-publisher-recovery.md`
- `docs/checkpoints/07-operations-and-release-candidate.md`
- `docs/checkpoints/independent-review.md`
- `docs/validation/deterministic-reliability-overhaul-2026-08-02.md`

### Situation Studio — publisher and review worker

- `apps/publisher/package.json`
- `apps/publisher/src/index.ts`
- `apps/publisher/src/main.ts`
- `apps/publisher/test/publisher.integration.test.ts`
- `apps/publisher/test/runtime-route.test.ts`
- `apps/review-worker/src/review.ts`
- `apps/review-worker/test/candidate-materialization.test.ts`
- `apps/review-worker/test/review.integration.test.ts`
- `apps/review-worker/test/role-prompt.test.ts`

### Situation Studio — web, APIs, workflow, and tests

- `apps/web/src/app/api/checkouts/[id]/preflight/route.ts`
- `apps/web/src/app/api/checkouts/[id]/publish/route.ts`
- `apps/web/src/app/api/checkouts/[id]/review/route.ts`
- `apps/web/src/app/api/checkouts/[id]/save/route.ts`
- `apps/web/src/app/api/proposal-changes/[id]/route.ts`
- `apps/web/src/app/api/review-proposals/[id]/accept-all/route.ts`
- `apps/web/src/app/api/review-proposals/[id]/reject-all/route.ts`
- `apps/web/src/app/api/reviews/[id]/cancel/route.ts`
- `apps/web/src/app/api/reviews/[id]/retry/route.ts`
- `apps/web/src/app/situations/[slug]/page.tsx`
- `apps/web/src/components/agent-revision-review.tsx`
- `apps/web/src/components/workspace-editor.tsx`
- `apps/web/src/editor-revision-state.ts`
- `apps/web/src/publication-preflight.ts`
- `apps/web/src/review-status-contract.ts`
- `apps/web/src/server/review-status.ts`
- `apps/web/src/server/workflows/situations.ts`
- `apps/web/test/agent-revision-review.test.ts`
- `apps/web/test/editor-revision-state.test.ts`
- `apps/web/test/publication-preflight.test.ts`
- `apps/web/test/review-status-client.test.ts`
- `apps/web/test/review-status-stream.test.ts`
- `apps/web/test/review-status.test.ts`

### Situation Studio — data, packages, operations, and acceptance

- `deploy.sh`
- `ops/apply-studio-release-schema.sh`
- `ops/grant-runtime-roles.sql`
- `ops/verify-leadership-runtime-capabilities.mjs`
- `packages/ai-adapters/src/index.ts`
- `packages/ai-adapters/test/adapters.test.ts`
- `packages/db/prisma/schema.prisma`
- `packages/db/prisma/migrations/20260802120000_deterministic_publication_preflight/migration.sql`
- `packages/domain/package.json`
- `packages/domain/src/index.ts`
- `packages/domain/test/domain.test.ts`
- `packages/leadership-bridge/src/index.ts`
- `packages/leadership-bridge/src/runtime-capabilities.ts`
- `packages/leadership-bridge/test/runtime-capabilities.test.ts`
- `packages/testing/test/deploy-contract.test.ts`
- `packages/testing/test/deterministic-publication-preflight.integration.test.ts`
- `packages/testing/test/release-like-review-publication.integration.test.ts`
- `playwright.config.ts`
- `pnpm-lock.yaml`
- `scripts/verify-contract-packages.mjs`
- `tests/browser/start-release-server.mjs`
- `tests/browser/studio.spec.ts`
- `vendor/leadership-field-guide-content-contracts-0.3.0.tgz`

### Leadership — excluded overlap and preserved user files

- `docs/AUTHORING.md` (pre-existing unrelated overlap; excluded from the
  Leadership release commit)
- `docs/situation-portfolio-reevaluation-plan-2026-07-28.md` (pre-existing
  untracked user file; not modified for this work)
- `repeatedly-misses-commitments-proposed-experience.html` (pre-existing
  untracked user file; not modified for this work)

### Leadership — contract, runtime, docs, and tests

- `CHANGELOG.md`
- `README.md`
- `docs/HANDOFF.md`
- `docs/content-api.md`
- `lib/affected-route-verification.ts`
- `lib/content-api.ts`
- `lib/prisma-content-repository.ts`
- `lib/runtime-capabilities.ts`
- `package.json`
- `packages/content-contracts/README.md`
- `packages/content-contracts/dist/index.d.ts`
- `packages/content-contracts/dist/index.js`
- `packages/content-contracts/package.json`
- `packages/content-contracts/src/index.ts`
- `packages/content-contracts/test/contracts.test.ts`
- `pnpm-lock.yaml`
- `scripts/verify-contract-packages.mjs`
- `tests/content-api-verification.test.ts`
- `tests/content-reader.test.ts`
- `tests/e2e/database.spec.ts`
- `tests/integration/database-content.test.ts`
- `tests/prisma-content-repository.test.ts`
- `tests/runtime-capabilities.test.ts`
- `vendor/leadership-field-guide-content-contracts-0.3.0.tgz`

The temporary Leadership `.release-commit` and `.release-archive-sha256`
markers, disposable containers, temporary cache, and local processes used for
acceptance were removed after verification and are not implementation files.
