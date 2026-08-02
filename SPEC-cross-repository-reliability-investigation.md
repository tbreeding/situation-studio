# Spec: Cross-Repository Contract Reliability Investigation

## Status

- Historical plan status: completed by
  `CROSS-REPOSITORY-RELIABILITY-INVESTIGATION.md` on 2026-07-29. The plan text
  below is retained unchanged as the read-only investigation authority.
- Prepared: 2026-07-29.
- Coordination repository:
  `/Users/timothybreeding/projects/situation-studio`.
- Repositories in scope:
  - `/Users/timothybreeding/projects/situation-studio`
  - `/Users/timothybreeding/projects/leadership`
- Intended deliverable:
  `/Users/timothybreeding/projects/situation-studio/CROSS-REPOSITORY-RELIABILITY-INVESTIGATION.md`.
- This plan authorizes read-only inspection, tests in disposable environments,
  and temporary diagnostic artifacts.
- It does not authorize production code changes, commits, pushes, deployments,
  package publication, or production mutation.

## Goal

Determine the smallest evidence-backed changes needed to prevent material
Situation Studio–Leadership contract incompatibilities from starting avoidable
review work or changing the official Leadership release before a deterministic
check rejects them.

The guarantee designed in this pass is bounded:

> For the declared contract surface, tested mutation classes, affected runtime
> path, and explicitly supported version pairs, an incompatible
> producer/consumer combination is rejected at the earliest point where the
> required information exists and no later than immediately before pointer
> promotion.

Static version or capability incompatibility should be rejected before review
enqueue. Content-specific incompatibility that cannot be known until a
candidate exists must be rejected before promotion. A correctly rejected
operation must not change the official pointer.

This investigation does not claim to prevent unknown contract dimensions,
semantic content mistakes, or external infrastructure failures. It will inspect
existing post-promotion verification and restoration only at durable
side-effect boundaries.

## Decision this investigation must support

The report must let the owner decide:

1. which existing source or package should own each material cross-repository
   contract;
2. where each reproduced incompatibility can be rejected earliest;
3. which current and transition version pairs are supported;
4. whether hardening the existing package and consumer boundaries is sufficient;
   and
5. which follow-up implementation work is justified by reproduced evidence.

The report may recommend a broader architecture only when the minimum option
cannot satisfy a reproduced failure or explicit bounded invariant.

## Context and starting evidence

These are planning-time observations to verify before relying on them. They are
not final conclusions.

### Repository state

- Situation Studio was clean on `main` at `02acef7`, equal to `origin/main`.
- Leadership was checked out on `main` at `ad98dc2`, two commits behind
  `origin/main` at `a366780`; `e8a4a49` was the intervening commit.
- Leadership contained unrelated user work:
  - modified `docs/AUTHORING.md`;
  - untracked `docs/situation-portfolio-reevaluation-plan-2026-07-28.md`;
  - untracked `repeatedly-misses-commitments-proposed-experience.html`.
- Neither repository contained a `.github` CI workflow.
- The investigation must not switch, clean, reset, stash, or otherwise modify
  either working tree. Selected versions will be exported to temporary
  directories.

### Contract and version evidence

- The relevant Studio commits resolve:
  `1ea612b`, `07362dd`, `da9be25`, and `02acef7`.
- The relevant Leadership commits resolve in one ancestry chain:
  `ad98dc2` → `e8a4a49` → `a366780`.
- Both repositories contain byte-identical vendored archives:
  - `leadership-field-guide-content-contracts-0.1.1.tgz`:
    `8a5f564824238b9f415c33e43f1a2626b9aaed376d493d9700ba7200d26c3ac4`;
  - `leadership-field-guide-situation-contract-1.0.0.tgz`:
    `9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4`.
- Studio imports a Leadership contract version but independently defines
  substantial schema, hashing, scoped-artifact, and MDX behavior in
  `packages/domain/src/index.ts`.
- Leadership has situation-contract source, checked-in `dist`, and a vendored
  archive. The content contract is present as vendored `0.1.0` and `0.1.1`
  archives without an established source-to-package proof.
- Content-contract path and schema behavior changed from `0.1.0` to `0.1.1`,
  but the packaged validation-policy hash did not.
- Leadership's root workspace includes only `"."`, so its normal root
  verification does not by itself prove the
  `packages/situation-contract` source/dist/package relationship.
- Identifier bounds differ across representations: Studio situation logical IDs
  allow 240 characters, Leadership snapshot logical IDs 200,
  content-contract practice IDs 160, and relevant typed Prisma columns 100.
  The inspected Leadership package also retains a legacy three-value practice
  ID enum.

### Publication and runtime evidence

- Studio currently defines a durable 24-stage review DAG. The earlier 22-stage
  description is stale; this investigation will not retest identical provider
  behavior separately at all 24 stages.
- Studio publication passes through `requestPublication`, candidate assembly and
  validation, typed projection insertion, Leadership validation and promotion,
  runtime verification, receipt creation, and restoration/recovery.
- Leadership exposes the security-definer functions
  `leadership_studio_validate_release`,
  `leadership_studio_promote_release`, and
  `leadership_studio_restore_release`.
- Studio's runtime receipt proves database/runtime release identity and manifest
  hash, but not the affected page, scoped binding, typed projection, catalog
  visibility, or rendered text.
- Leadership has two material read paths:
  - lossless manifest/artifacts through `PrismaContentSource`,
    `LeadershipContentReader`, and its filesystem cache;
  - typed Prisma rows through `PrismaContentRepository` for APIs and scoped
    artifact resolution.
- Leadership health primarily exercises the lossless reader/cache path, not
  typed projections or situation-scoped rendering.
- The situation route did not provide MDX practice-resolution context until
  `e8a4a49`.
- Authored/physical practice ID normalization was added in `a366780`.
- API and reader caches have different lifetimes, so pointer identity alone may
  not prove the affected rendered page.

### Existing test signal

- A planning-time Studio unit run passed 30 files / 219 tests after one SSE
  timing failure passed on focused and full reruns. Treat that as a possible
  flake, not cross-repository evidence.
- Narrow Leadership tests for the scoped fixes passed at the inspected commits.
- Studio already has shared review retry/restart tests and publisher crash tests
  at its durable boundaries.
- Disposable-database integration and the bounded cross-version matrix in this
  plan have not yet been run.

## Scope — this pass only

The investigation will:

1. verify the starting evidence at exact commits;
2. trace only the publication-critical path:

   ```text
   Studio candidate
   → contract/package boundary
   → Leadership validation and lossless/typed persistence
   → official pointer
   → runtime/cache
   → affected page
   → receipt or restoration
   ```

3. reproduce the known or strongly supported failure families:
   - source/package or validation-policy drift;
   - scoped path or schema incompatibility;
   - authored/logical/physical ID and binding mismatch;
   - missing renderer context;
   - typed/lossless/runtime disagreement;
   - unsupported producer/consumer version skew;
4. identify the first detection point and earliest safe deterministic gate for
   each reproduced failure;
5. build one minimal scoped fixture and a small mutation registry tied to the
   declared contract surface;
6. test the bounded code-current, historical comparison, and transition cells;
7. compare the minimum architecture with a broader alternative only when
   evidence requires one; and
8. produce a concise decision report and prioritized follow-up work.

## Out of scope / do NOT touch

- Do not implement the recommended production architecture.
- Do not edit production source, schemas, migrations, package manifests,
  lockfiles, tests, generated artifacts, or deployment scripts.
- Do not commit, stage, push, open a pull request, publish, deploy, or promote
  production content.
- Do not mutate a production or shared database, pointer, cache, process,
  filesystem release, or public page.
- Do not inventory the complete editor, UI, prompt, or internal review pipeline.
- Do not add provider-fault or review-stage fault scenarios.
- Do not add worker-restart or restoration-failure injection; inspect existing
  coverage and record gaps.
- Do not build a generalized verifier product, stable public CLI, compatibility
  service, dashboard suite, or telemetry platform.
- Do not require a new contract repository, IDL, monorepo, release train,
  code-generation system, dual read/write path, or schema backfill unless a
  reproduced failure demonstrates that the smaller option cannot work.
- Do not specify exact production rollout commands before an architecture is
  approved.
- Do not treat a larger timeout as contract-regression prevention.
- Do not claim universal completeness or “impossible to fail.”

## Constraints and safety invariants

- Use exact commit SHAs and package digests, not branch names, for version
  evidence.
- Export selected versions with `git archive <sha>` under a temporary root.
- Use `pnpm install --frozen-lockfile` only for versions selected for executable
  testing.
- Run migrations and publication tests only against disposable PostgreSQL
  instances created and owned by the test.
- Before any database command, assert a loopback/container host and an
  allowlisted disposable database name. Abort on uncertainty.
- Bind local HTTP servers to loopback on ephemeral ports.
- Disable outbound model-provider calls.
- Preserve current immutable-release, fencing, lease, idempotency, and
  restoration behavior unless evidence demonstrates a defect.
- Distinguish observed fact, executable reproduction, inference, design
  recommendation, and unverified production hypothesis.
- Do not retain prompts, content bodies, credentials, tokens, connection
  strings, raw provider output, or sensitive operational payloads.
- Use allowlisted diagnostic fields and hashes instead of sensitive content.
- Do not modify either working tree except this spec and the final report.

## Declared contract surface

The bounded guarantee applies to these material surfaces:

| ID  | Surface                                                                | Required agreement                                                  |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| C1  | Contract source → `dist` → tarball → lockfile → runtime import         | Proven source and immutable consumer identity                       |
| C2  | Manifest, artifact type, path, schema, body hash, and policy identity  | Producer output satisfies the authoritative consumer contract       |
| C3  | Authored, logical, physical, slug, provenance, and binding identifiers | Bounds are explicit and each public ID resolves unambiguously       |
| C4  | Lossless artifacts → typed projection → SQL validation/promotion       | Both representations are valid and refer to the same release        |
| C5  | Official pointer → runtime → affected route and MDX resolver           | The affected page reflects the promoted scoped content              |
| C6  | Producer, consumer, package, migration, and runtime capabilities       | Supported combinations work; unsupported combinations reject safely |

A newly discovered surface is added only when source inspection or a
reproduction shows that it can change review eligibility, promotion, official
content, or the affected rendered page. “Not investigated / no demonstrated
effect” is an acceptable explicit classification.

## Evidence model

Maintain one concise evidence table. Create an entry only for a
decision-changing claim, reproduction, or final control.

Each entry records:

- claim and evidence ID;
- repository and exact commit or package digest;
- file/symbol, SQL object, or runtime route;
- inspection or executable command;
- expected and observed result;
- confidence: proven, supported, inferred, or unknown; and
- retained artifact reference when an artifact is necessary.

Record shared toolchain versions once in a run manifest. Hash retained fixtures,
packages, and normalized result files, but do not duplicate the same metadata in
separate ledger, verifier, and matrix schemas.

## Version and test selection

### Static inspection set

Inspect source and package history at:

- Studio: `1ea612b`, `07362dd`, `da9be25`, `02acef7`;
- Leadership: `58e8634`, `bb0ee44`, `ad98dc2`, `e8a4a49`, `a366780`.

Use `git show`, `git diff`, `git blame`, `git log -S/-G`, and targeted
bisecting only when needed to identify the before/fix boundary.

### Executable pair set

Do not run a Cartesian product of commits, fixtures, failure classes, and deploy
orders.

The selected code-current refs are:

- `S1 = Studio@02acef7`;
- `L1 = Leadership@a366780`.

The bounded adjacent transition uses:

- `S0 = Studio@da9be25`;
- `L0 = Leadership@e8a4a49`.

Its four unique cells are `S0/L0`, `S1/L0`, `S0/L1`, and `S1/L1`.
Studio-first and Leadership-first are sequences through those cells, not new
pair sets:

```text
Studio-first:     S0/L0 → S1/L0 → S1/L1
Leadership-first: S0/L0 → S0/L1 → S1/L1
```

Seed the historical comparisons with:

| Comparison               | Failing candidate       | Fixed candidate     | Purpose                                |
| ------------------------ | ----------------------- | ------------------- | -------------------------------------- |
| Renderer context         | `S1/Leadership@ad98dc2` | `S1/L0`             | Route-provided scoped resolver context |
| ID normalization         | `S1/L0`                 | `S1/L1`             | Authored versus physical practice IDs  |
| Studio scoped validation | `Studio@1ea612b/L1`     | `Studio@07362dd/L1` | Studio-side scoped validation          |

The transition square also compares `S0/L1` with `S1/L1` for the Studio
candidate-validation change. Inspect `bb0ee44` and earlier package history
statically unless a seed comparison cannot isolate the claimed behavior.

For any replacement comparison:

- for a producer fix, compare `producer-fix^/consumer` with
  `producer-fix/consumer`;
- for a consumer fix, compare `producer/consumer-fix^` with
  `producer/consumer-fix`;
- hold the fixture and unaffected repository constant; and
- when no historical fix exists, use one reproducible failing/current pair and
  create a future acceptance control instead of inventing a fixed pair.

Checkpoint 1 may replace one seed ref when source inspection proves it is not
the actual boundary and may add at most one distinct executable cell. It then
freezes no more than eight unique cells, including the transition square. The
investigation may run no more than 12 integration scenarios and no more than six
full affected-page executions. Exceeding any cap requires a separate follow-up
spec, not another checkpoint.

Run these baselines against exact exported refs:

- `Studio@02acef7`: `pnpm test`;
- `Leadership@a366780`: `pnpm test`.

Run historical exports only to the cheapest layer needed for the selected
reproduction. Record different deployed versions as an unverified production
condition; do not silently substitute them into this matrix.

## Fixture and mutation registry

### Minimal positive fixture

Use one deterministic fixture containing:

- one situation;
- one global practice as a leakage sentinel;
- one situation-scoped practice replacement;
- one authored practice ID and a distinct internal physical ID;
- one binding from the situation to the scoped practice;
- one MDX `PracticeEmbed` using the authored ID;
- expected manifest/path/hash and lossless representation;
- expected typed projection and official pointer;
- expected affected-page text.

Global catalogs, other artifact types, and cache-convergence behavior remain
follow-up risks unless one of the selected reproductions directly implicates
them.

### Targeted negative controls

Maintain one mutation registry. Each mutation records its contract surface,
historical or invariant rationale, cheapest sufficient test layer, expected
current detection point and outcome, expected pointer state, maximum permitted
side effect, desired future gate, and desired error class.

Start with one representative mutation for:

- package or policy identity;
- scoped artifact kind/path/schema;
- identifier bound, authored/physical normalization, or ambiguous binding;
- missing renderer context;
- invalid typed projection;
- unsupported deployment capability.

A historical reproduction satisfies the corresponding mutation-control
requirement when it exercises the same predicate. Do not rerun it under a second
label. Run each remaining mutation once on `S1/L1`; do not apply the mutation
set across the transition square.

A harness run passes when the observed system outcome matches the declared
expected current outcome. That outcome may be safe rejection or acceptance that
demonstrates a missing gate. The harness exits nonzero only for an assertion
mismatch or harness failure. A future production gate must return or raise a
blocking failure; a command-line wrapper exits nonzero when it rejects an actual
operation.

## Verification plan

Use the cheapest layer that can prove each claim:

1. **Contract:** source/package equivalence and structural compatibility without
   databases or browsers.
2. **Database:** candidate, lossless/typed projection, SQL validation, promotion,
   and pointer invariants in disposable PostgreSQL.
3. **Runtime:** the code-current cell and candidate transition cells through the
   actual Leadership consumer until safe rejection or affected-page
   verification.

Stop a negative case after it reaches the layer needed to establish the current
outcome and side-effect boundary. Do not start databases, applications, caches,
or browsers when a contract-layer result already proves the claim.

Inspect the existing review-worker and publisher tests for shared retry,
durable-boundary, idempotency, restoration, and recovery-fence behavior. Do not
add provider, restart, or restoration fault scenarios in this pass. If existing
evidence is insufficient, record a bounded follow-up rather than expanding this
matrix. If a selected contract reproduction is misclassified as transient or
retryable, record that observed behavior as a finding.

An investigation-only helper may be created in temporary space when existing
tests cannot express a required reproduction. Do not design a stable public CLI
or result protocol in this pass.

## Architecture decision

### Options

Evaluate in this order:

1. **Leading minimum hypothesis — harden the existing in-repository
   boundaries.** Verify ownership per predicate, establish reproducible
   source-to-package provenance, remove or mechanically compare unjustified
   copies, add focused consumer tests, and add a deployed-capability check only
   where version identity is insufficient. Leadership package ownership is a
   hypothesis to verify, not a predetermined decision.
2. **Broader option.** Add generation, a compatibility manifest, or another
   ownership mechanism only for a reproduced limitation that the minimum option
   cannot resolve.

A dedicated contract repository, compatibility service, monorepo, or unified
release train is a follow-up proposal, not a required option in this
investigation.

### Decision criteria

Prefer the least complex option that:

- gives each predicate a named authority or an explicit producer/consumer
  compatibility rule;
- provides a credible earliest safe rejection point for each reproduced
  incompatibility;
- is safe in both supported deployment orders;
- preserves immutable releases, fencing, idempotency, and restoration;
- has clear consumer conformance evidence;
- is reversible; and
- has acceptable implementation and ongoing ownership cost.

### Stop rule

Stop the architecture search when the minimum option:

- gives every reproduced failure an owner and credible enforcement point;
- can preserve the positive fixture and both bounded transition orders;
- has a later acceptance test for every targeted negative control; and
- has no demonstrated structural limitation that requires a broader option.

Do not add infrastructure without a reproduced failure or explicit bounded
invariant that requires it. Because the option is not implemented in this pass,
the report must not claim that its future gates have already passed.

## Candidate checks and enforcement points

The report may retain only the applicable predicates from this list. It should
not define another check unless reproduced evidence requires a distinct
predicate.

| Check | Capability                                                    | Likely enforcement points                                  |
| ----- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| V1    | Source/generated/package equivalence and consumer conformance | Package build and repository verification                  |
| V2    | Deployed producer/consumer capability compatibility           | Deployment and pre-review enqueue                          |
| V3    | Candidate, projection, and database validation                | Publication preflight and atomic pre-promotion transaction |
| V4    | Runtime identity and affected-route verification              | Post-promotion verification before success receipt         |

The same check may be reused at local, pull-request, deployment, and runtime
locations. Those placements are not separate verifier products.

Assess whether existing operation, publication, release, build, contract, and
pointer identifiers can reconstruct one failed case with a safe outcome code. If
not, record the minimum missing fields as a finding and later acceptance
criteria. Do not build telemetry or dashboards in this pass.

## Phases and checkpoints

### Checkpoint 0 — Confirm the bounded investigation

Before execution:

1. confirm the report path and bounded guarantee;
2. record deployed commits if known;
3. confirm the bounded `S0/S1 × L0/L1` transition window;
4. confirm disposable Docker/PostgreSQL and local browser testing; and
5. identify any available read-only production evidence.

Unknown production facts do not block code and disposable-environment work, but
must remain explicit unknowns.

### Phase 1 — Baseline and reproduce

1. Record current repository and package identities without changing either
   working tree.
2. Run `pnpm test` on the exact exported code-current refs
   `Studio@02acef7` and `Leadership@a366780`.
3. Inspect the named historical commits.
4. Select minimal failing/fixed comparisons within the executable caps.
5. Reproduce each historical failure with a failing/fixed packet, or each
   currently unfixed gap with a failing/current packet, recording:
   - structural mismatch;
   - first actual detection point;
   - whether review, publication, or pointer state changed;
   - fixing behavior;
   - missing gate; and
   - residual weakness.
6. Trace only the declared surfaces touched by those reproductions.

#### Checkpoint 1

Present the selected pairs, reproduced failures, bounded seam map, unresolved
unknowns, and any proposed expansion. Do not expand scope without evidence or
approval.

### Phase 2 — Run bounded verification

1. Build the minimal positive fixture and mutation registry.
2. Use existing tests where they already prove the required behavior.
3. Add temporary targeted reproductions only for missing evidence.
4. Run each historical pair only to the cheapest layer needed for its
   reproduction.
5. Run candidate transition cells until deterministic safe rejection or
   affected-page verification.
6. Run both selected transition orders; those sequences supply the cell
   observations, so do not rerun a cell unless order-dependent state requires
   isolation.
7. Record whether each candidate cell succeeds, rejects safely, fails late, or
   changes the pointer; any unsafe result becomes a finding and future
   acceptance test.

#### Checkpoint 2

Present the positive result, negative controls, compatibility table, earliest
gate for each failure, and any false-positive or false-negative concerns.

### Phase 3 — Choose the minimum architecture

1. Evaluate the minimum option against every reproduced failure.
2. Consider a broader mechanism only where the minimum option fails a required
   property.
3. Name the authority or compatibility rule, consumers, supported pairs,
   enforcement point, and residual risk for each predicate.
4. Map only the applicable candidate checks to lifecycle enforcement points.
5. State only the additive ordering and rollback constraints required for the
   chosen design.

#### Checkpoint 3

Present the recommendation and obtain explicit approval before creating a
production implementation spec.

### Phase 4 — Assemble and independently check the report

The report will contain:

1. decision summary and bounded guarantee;
2. verified current path and declared contract surface;
3. reproduced failures and root causes;
4. selected version/transition results;
5. minimum architecture, applicable checks, and high-level transition
   constraints;
6. residual risks, unknowns, and prioritized follow-up work; and
7. a concise evidence appendix.

One independent reviewer will:

- challenge the highest-severity root cause;
- rerun one positive and one negative control;
- verify the recommended mechanism maps to every reproduced failure; and
- check that no unsupported completeness claim or sensitive value entered the
  report.

## Success criteria

- [ ] The declared contract surface, mutation classes, affected route, and
      supported version window are explicit.
- [ ] The code-current positive fixture reaches affected-page verification, or
      its exact blocking failure is reproduced and bounded.
- [ ] Each reproduced failure has a failing/current pair, a historical fixed
      pair when one exists, a structural cause, an earliest safe gate, and a
      regression or future acceptance control.
- [ ] Each targeted negative control has a reproducible current outcome,
      observed side effects, and a stated future rejection point.
- [ ] Each selected deployment order is classified as supported, safely
      rejected, or unsafe; every unsafe result maps to a proposed gate.
- [ ] Deterministic failure classification is observed; any timeout/transient
      misclassification is recorded as a separate finding.
- [ ] Existing durable-boundary and restoration evidence is assessed without
      adding a new fault matrix.
- [ ] The recommendation names the authority or explicit compatibility rule and
      consumer-conformance mechanism for each predicate.
- [ ] Every recommended mechanism maps to a reproduced failure or explicit
      bounded invariant.
- [ ] The report separates proven behavior, inference, recommendation, and
      unverified production assumptions.
- [ ] An independent reviewer can reproduce the highest-risk positive and
      negative results from exact commits and commands.
- [ ] Neither working tree has changed except for this spec and the final report.

Investigation success does not require the current system to pass every future
safety criterion. A deterministic reproduction of a missing or late gate is a
successful investigation result.

## Acceptance contract for later implementation

The report must hand a later implementation spec testable criteria stating that,
after the approved change:

- the positive fixture succeeds end to end;
- each targeted negative control rejects at its desired future gate;
- an expected pre-promotion rejection leaves the official pointer unchanged;
- supported transition pairs work in both required deployment orders;
- unsupported pairs reject before production mutation;
- deterministic incompatibility is not labeled transient or retryable; and
- post-promotion verification either confirms the affected page or withholds
  success and exposes an explicit recovery fence.

Automatic restoration after a render-probe failure is a separate recovery-policy
decision. Recommend it only if the investigation establishes a reliable
predicate and compatibility with existing restoration semantics.

These are future implementation criteria, not claims that this investigation
has already made the changes pass.

## Residual risks

The recommended design will not eliminate:

- provider outages, authentication failures, capacity limits, or genuinely slow
  valid calls;
- infrastructure partitions and process/host loss;
- database, filesystem, network, CDN, browser, or framework defects outside the
  tested assumptions;
- semantic content errors not expressible as deterministic contracts;
- contract dimensions omitted from the declared surface and fixture corpus;
- renderer behavior outside tested routes and components;
- catalog, feed, sitemap, and cache-convergence behavior not implicated by a
  selected reproduction;
- operator actions outside enforced permissions;
- incomplete historical production evidence; or
- simultaneous promotion and restoration infrastructure failure.

The report must not generalize beyond the tested versions, mutations, and
runtime path.

## Working rules

- Verify before concluding.
- Prefer a small falsifiable claim to a broad narrative.
- Test the actual consumer at exact versions.
- Reuse existing tests before creating a new harness.
- Use the cheapest test layer that proves the claim.
- Do not multiply independent dimensions without a demonstrated interaction.
- Preserve existing reliability strengths unless evidence shows a defect.
- Surface uncertainty instead of filling it with speculative architecture.
- Stop at each checkpoint.
- Do not begin production implementation without explicit approval.
