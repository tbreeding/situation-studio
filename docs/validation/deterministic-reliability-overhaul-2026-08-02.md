# Deterministic review-to-publication reliability overhaul

Date: 2026-08-02
Status: Leadership release commit `d15a92b8e91967f85a8b78ee7c2146a2154a56c0`
is pushed; the exact 71-path Studio release candidate is accepted locally but
not yet committed, pushed, deployed, or used against production

## Acceptance statement

The local implementation now uses one complete publishable snapshot and one
Leadership-owned deterministic compiler/validator from save through review,
proposal decisions, publication preflight, publisher promotion, and runtime
verification. The release-like journey proved that the candidate previewed by
the editor, adopted revision, sealed preflight, publisher input, Leadership
release artifacts, and typed runtime response have identical identities.

No production database, official Leadership pointer, deployed Studio release,
or real situation was changed. All database and runtime acceptance used
disposable local services.

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
  formatting, lint, all workspace typechecks, 48 unit-test files/457 tests,
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
- `pnpm contracts:verify`, the focused 21-test deployment contract,
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

- Full `pnpm verify` passed: 27 contract tests, 86 unit tests, 14 disposable-
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
