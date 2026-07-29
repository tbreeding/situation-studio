# Cross-Repository Contract Reliability Investigation

## Status and scope

- Investigation completed: 2026-07-29.
- Coordination repository:
  `/Users/timothybreeding/projects/situation-studio`.
- Repositories inspected:
  - Situation Studio:
    `/Users/timothybreeding/projects/situation-studio`;
  - Leadership:
    `/Users/timothybreeding/projects/leadership`.
- Production code, schemas, migrations, package manifests, lockfiles, tests,
  deployments, shared databases, and production pointers were not changed.
- Exact selected versions were exported with `git archive` and tested under
  `/tmp/cross-repo-reliability-20260729.xR1BCW`.
- The only Situation Studio working-tree additions are the investigation spec
  and this report. Pre-existing Leadership user changes were preserved.
- Deployed production commits, production package identities, production
  database state, and real cache topology were not available and remain
  unknown.

Evidence labels in this report mean:

- **Proven** — directly established by source identity, byte comparison, or an
  executable assertion.
- **Supported** — multiple direct observations support the claim, but the
  complete production condition was not executed.
- **Inferred** — a design or operational conclusion drawn from proven facts.
- **Unknown** — not established by the available read-only evidence.

## Decision summary

### Decision

Harden the existing in-repository package, deployment, database, and runtime
boundaries. Do not create a contract repository, compatibility service,
monorepo, unified release train, or generalized verifier.

The minimum design can address every reproduced failure:

1. make Leadership contract source-to-package identity reproducible;
2. check deployed capabilities before review enqueue;
3. validate lossless-to-typed parity in the existing atomic pre-promotion
   transaction; and
4. verify the affected route before issuing a success receipt.

No reproduced failure requires broader infrastructure.

### Current safety conclusion

The current `S1/L1` pair does **not** satisfy the bounded guarantee.

A test-only producer mutation retained a valid two-round lossless practice but
inserted a one-round typed projection. Current SQL validation promoted it, the
publisher completed the job as `SUCCEEDED`, and the actual affected route then
returned HTTP 500. Source inspection establishes that the success receipt and
`SUCCEEDED` transition are created in the same finalization transaction. The
official pointer remained on the bad candidate. This is the highest-severity
finding.

The current transition results are:

| Pair    | Positive fixture result                                     | Classification      |
| ------- | ----------------------------------------------------------- | ------------------- |
| `S0/L0` | Pointer changes; typed consumer rejects the physical ID     | Unsafe              |
| `S1/L0` | Pointer changes; typed consumer rejects the physical ID     | Unsafe              |
| `S0/L1` | Lossless, typed, pointer, consumer, and affected page agree | Positive-compatible |
| `S1/L1` | Lossless, typed, pointer, consumer, and affected page agree | Positive-compatible |

“Positive-compatible” is deliberately narrower than “bounded safe.” Both L1
cells pass the positive fixture, but the `S1/L1` negative typed-projection
control demonstrates a missing pre-promotion gate.

### Material findings

1. **Typed/lossless parity is not enforced before promotion.** A typed practice
   with one round was promoted although the lossless artifact had two. Pointer
   identity and manifest hash did not detect it.
2. **Runtime success proves identity, not the affected experience.** Studio's
   receipt records database/runtime release IDs and hashes. It does not prove
   the route, scoped resolver, typed projection, catalog, or rendered practice.
3. **Content-contract identity is not behavioral identity.** Content-contract
   `0.1.0` rejects scoped paths and retains a three-value practice-ID schema;
   `0.1.1` accepts scoped paths and general practice IDs. Both expose the same
   validation-policy hash:
   `2425af2989983e27533c24caf5c6cec78355b6ed4f6e5653d104d66414659584`.
4. **The `0.1.1` content contract has no reproducible source-to-package proof.**
   Leadership contains only the tarballs. The earlier Studio source ended at
   `0.1.0`.
5. **Unsupported runtime capabilities are not rejected before review.**
   `requestPublication` reconciles content and validates the candidate, but
   there is no deployed renderer/ID/projection capability handshake.
6. **A missing renderer context can be silently wrong.** With
   `Leadership@ad98dc2`, the promoted affected page returned HTTP 200 but showed
   the global practice. `e8a4a49` supplied route context and rendered the scoped
   replacement.
7. **Identifier contracts are internally inconsistent.** Current executable
   probes confirmed:
   - Studio relationship logical IDs accept 201 characters;
   - the content-snapshot artifact schema rejects 201;
   - the `0.1.1` practice schema accepts a new authored ID;
   - situation frontmatter rejects that same new authored ID;
   - the practice schema accepts 101 characters while relevant Prisma columns
     are `VARCHAR(100)`.

## Bounded guarantee

The design target remains:

> For C1–C6, the six tested mutation classes, the affected
> `/situations/nothing-in-one-on-ones` route, and explicitly supported version
> pairs, an incompatible producer/consumer combination is rejected at the first
> point where the required information exists and no later than immediately
> before pointer promotion.

Static version or capability incompatibility must reject before review enqueue.
Candidate-specific incompatibility must reject before promotion. A correctly
rejected operation must leave the official pointer unchanged. Post-promotion
success must require the affected route to reflect the scoped candidate.

This investigation designed that guarantee; it did not implement it.

## Exact versions and package identities

### Executed versions

| Label                      | Repository       | Exact commit                               |
| -------------------------- | ---------------- | ------------------------------------------ |
| `S0`                       | Situation Studio | `da9be2573f7adff1581f702639fe164b75adf256` |
| `S1`                       | Situation Studio | `02acef75ba32095c94028972064bca590620d00f` |
| Studio scoped-before       | Situation Studio | `1ea612bc0c4e69444a27f3b88b168e2e6493c2fe` |
| Studio scoped-after        | Situation Studio | `07362dd40bc5446faaf7d8a4de961b8c60ad6c04` |
| Leadership renderer-before | Leadership       | `ad98dc2d30e7a5065b7fab2bf514c73f98efb65a` |
| `L0`                       | Leadership       | `e8a4a493bcfec7b874cf2d707fb6795cde84773d` |
| `L1`                       | Leadership       | `a3667808bbac2d29490991a094b986dfbbc5074f` |

`58e8634cb3901e55cf58bc17e9f3cac71d201f37` and
`bb0ee441986e1923bce2d7793227f35d4f385923` were inspected statically.

### Package evidence

| Package                                               | SHA-256                                                            | Result                      |
| ----------------------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `leadership-field-guide-content-contracts-0.1.1.tgz`  | `8a5f564824238b9f415c33e43f1a2626b9aaed376d493d9700ba7200d26c3ac4` | Byte-identical in S1 and L1 |
| `leadership-field-guide-situation-contract-1.0.0.tgz` | `9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4` | Byte-identical in S1 and L1 |
| Leadership content-contract `0.1.0`                   | `bc5410bdfa68f28d9af29af677506b61a5c0de5e45507e2c861aac8fe06abf2d` | Historical comparison only  |

Leadership's situation-contract source rebuilt to byte-identical `index.js` and
`index.d.ts`; the checked-in `dist` also matches the tarball. Its declaration
map differs only when rebuilt to a different absolute output directory and is
not included in the package.

Leadership's root workspace includes only `"."`. Consequently, normal root
verification does not itself prove the checked-in
`packages/situation-contract` source/dist/package relationship.

No source corresponding to content-contract `0.1.1` exists in either reachable
repository history or inspected unreachable Studio commits. The last Studio
content-contract source was deleted at `3ea94c7` and corresponds to the earlier
contract behavior.

## Baseline verification

Exact archives were installed with `pnpm install --frozen-lockfile`.

| Baseline | Command and prerequisite                                            | Result                     |
| -------- | ------------------------------------------------------------------- | -------------------------- |
| `S1`     | `pnpm db:generate && pnpm test`                                     | 30 files, 219 tests passed |
| `L1`     | `GIT_DIR=/Users/timothybreeding/projects/leadership/.git pnpm test` | 10 files, 43 tests passed  |

The first pure-archive attempts were retained as environment diagnostics:

- Studio lacked the generated Prisma client because generated output is not in
  `git archive`; `pnpm db:generate` corrected the test environment.
- Leadership tests use `git ls-tree` at fixture ref `0d7d161`; supplying the
  live repository's read-only Git object database corrected the archive
  environment.

Neither initial failure was classified as a product regression.

## Verified publication-critical path

```text
requestPublication
→ candidate assembly
→ Studio candidate/content-contract validation
→ lossless membership and typed projection insertion
→ leadership_studio_validate_release
→ leadership_studio_promote_release
→ current_release pointer
→ Leadership lossless reader/cache and typed Prisma repository
→ situation MDX route and PracticeEmbed resolver
→ Studio verification receipt or leadership_studio_restore_release
```

| Surface | Verified current behavior                                                                                                            | Classification |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| C1      | Situation-contract source/dist/tarball identity is reproducible; content-contract `0.1.1` provenance is not                          | Proven         |
| C2      | S1 parses the candidate with local and Leadership schemas, but policy identity omits behavior-changing scoped-path and ID predicates | Proven         |
| C3      | Authored/physical normalization exists only from L1; remaining schema and storage bounds conflict                                    | Proven         |
| C4      | SQL validates lossless hashes/counts and binding membership, but not typed semantic parity                                           | Proven         |
| C5      | Reader/cache prove lossless identity; the route also uses typed scoped resolvers; the receipt proves neither route nor resolver      | Proven         |
| C6      | No deployed capability contract exists at deployment or pre-review enqueue                                                           | Proven         |

## Minimal fixture

The deterministic positive fixture used:

- situation slug `nothing-in-one-on-ones`;
- global leakage sentinel `practice:listen-first`;
- scoped replacement body ID `delivery-follow-up`;
- authored/public practice ID `listen-first`;
- physical typed ID
  `listen-first--<first-12-content-hash>`;
- one binding from `practice:listen-first` to the scoped resolved logical ID;
- an MDX `PracticeEmbed` using authored ID `listen-first`;
- a scoped lossless path under
  `content/scoped/nothing-in-one-on-ones/practice/`;
- two typed rounds;
- retained global-practice count of one; and
- expected affected-page text `Name the pattern and follow up`.

On `S0/L1` and `S1/L1`, the fixture proved:

- the scoped path, lossless body, manifest membership, and binding;
- a distinct physical practice ID;
- authored-ID restoration through the L1 typed consumer;
- an unchanged global leakage sentinel;
- pointer and manifest identity; and
- the expected practice on the affected page.

The in-app browser independently observed the `S0/L1` affected page and its
accessible region named `Name the pattern and follow up`.

## Reproduced failures and controls

| ID  | Surface  | Failing/current observation                                                               | Fixed/control observation                                     | First actual detection                                                     | Pointer                            | Earliest safe future gate                                                         |
| --- | -------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| F1  | C1/C2/C6 | Contract `0.1.0` rejects scoped path while sharing `0.1.1` policy hash                    | No current fixed identity; future acceptance control required | Only behavioral execution                                                  | N/A                                | V1 build/conformance and V2 deployed identity                                     |
| F2  | C2       | Studio `1ea612b` accepts an incomplete scoped practice into a candidate                   | `07362dd` and S1 reject it with `INVALID_SCOPED_ARTIFACT`     | Candidate materialization/editor validation                                | Unchanged on current rejection     | Retain pre-enqueue producer validation, mechanically tied to Leadership predicate |
| F3  | C5/C6    | `S1/ad98dc2` promotes and HTTP 200 silently renders the global practice                   | `S1/e8a4a49` renders the scoped practice                      | Affected-page content assertion                                            | Changed before detection           | V2 renderer capability before review; V4 route assertion before receipt           |
| F4  | C3/C4/C6 | `S1/L0` promotes, then typed consumer rejects hashed physical ID through legacy enum      | `S1/L1` restores authored ID                                  | Typed consumer after promotion                                             | Changed                            | V1 ID algebra, V2 L1 capability, V3 binding/ID parity                             |
| F5  | C4/C5    | S1/L1 promotes one-round typed projection, completes success, then route returns HTTP 500 | Positive two-round projection renders                         | Actual route; current SQL and receipt miss it                              | Changed and retained               | V3 typed parity before promotion; V4 affected route before receipt                |
| F6  | C6       | `requestPublication` has no deployed capability handshake                                 | No current control                                            | No current detection; typed consumer/route exposed historical consequences | Changed in historical runtime case | V2 deployment and pre-review capability gate                                      |

### Targeted mutation outcomes

| Mutation                          | Current outcome                                                | Side effect                      | Future error class               |
| --------------------------------- | -------------------------------------------------------------- | -------------------------------- | -------------------------------- |
| Package/policy identity           | False negative: incompatible behaviors share one policy hash   | None in contract probe           | `UNSUPPORTED_CONTRACT_IDENTITY`  |
| Scoped practice schema            | Safe 422 rejection before publication queue                    | Pointer unchanged                | `INVALID_SCOPED_ARTIFACT`        |
| Authored/physical ID              | L0 rejects only after promotion; current bounds still conflict | Pointer changed                  | `IDENTIFIER_CONTRACT_MISMATCH`   |
| Renderer context                  | Missing context silently serves global content with HTTP 200   | Pointer changed                  | `RUNTIME_CAPABILITY_UNSUPPORTED` |
| Invalid typed projection          | SQL accepts, pointer changes, job succeeds, route returns 500  | Official candidate retained      | `TYPED_PROJECTION_INVALID`       |
| Unsupported deployment capability | No gate exists                                                 | Review and promotion can proceed | `UNSUPPORTED_VERSION_PAIR`       |

### Deterministic classification

- The current scoped-body rejection is deterministic and non-retryable:
  status 422, `INVALID_SCOPED_ARTIFACT`.
- Package identity, renderer capability, identifier compatibility, and typed
  parity currently have no dedicated blocking error because their gates do not
  exist.
- The L0 typed-consumer failure and invalid typed route failure therefore occur
  too late to receive a correct publication error class.
- No reproduced deterministic contract failure was shown to be incorrectly
  labeled transient by an existing gate; most are not gated at all.

## Transition and deployment-order results

### Transition square

| Cell    | Lossless/projection insertion | Pointer | Typed consumer       | Affected page                              | Result                                                           |
| ------- | ----------------------------- | ------- | -------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `S0/L0` | Pass                          | Changed | Rejects physical ID  | Stopped at deterministic consumer failure  | Unsafe                                                           |
| `S1/L0` | Pass                          | Changed | Rejects physical ID  | Renderer can show scoped practice          | Unsafe because another material consumer fails                   |
| `S0/L1` | Pass                          | Changed | Authored ID restored | Scoped practice rendered; browser verified | Positive-compatible                                              |
| `S1/L1` | Pass                          | Changed | Authored ID restored | Scoped practice rendered                   | Positive-compatible, but F5 prevents bounded-safe classification |

### Deployment orders

- **Studio-first:** `S0/L0 → S1/L0 → S1/L1`.
  Unsupported until Leadership L1. Both L0 cells can change the pointer before
  material consumer failure.
- **Leadership-first:** `S0/L0 → S0/L1 → S1/L1`.
  The initial L0 cell is unsafe; both cells after L1 pass the positive fixture.

For a later implementation, deploy additive Leadership capabilities and
pre-promotion validation first. Only then deploy a Studio version that requires
those capabilities before enqueue.

## Existing durable-boundary and restoration evidence

The current system has material reliability strengths that should be preserved:

- immutable content releases;
- an append-only publisher role;
- candidate ownership by publication ID;
- expected-generation pointer fencing;
- idempotent promotion retries;
- restoration to the prior immutable release;
- Studio checkout and lease fencing; and
- recovery reconciliation after runtime convergence.

The append-only grant was executable evidence: an initial diagnostic mutation
attempt that tried to delete a typed round was rejected before validation. The
actual F5 reproduction therefore used a producer-realistic initial insertion
with one round.

Existing Studio publisher integration tests cover:

- crash reconciliation after `CANDIDATE_PERSISTED`,
  `LEADERSHIP_PROMOTED`, and `RUNTIME_VERIFIED`;
- runtime verification failure and prior-release restoration; and
- recovery-required reconciliation.

Existing Leadership tests cover expected-generation promotion/restoration and
immutability. This investigation inspected that evidence and did not add a new
provider, restart, or restoration fault matrix.

The residual defect is at a different boundary: current runtime verification
accepts only release ID and manifest hash. F5 proved that this can issue success
before the affected route fails.

## Minimum architecture

| Surface | Authority or rule                                                                                                  | Consumer-conformance mechanism                                                                                                                            | Checks     |
| ------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C1      | Leadership-owned contract source and package build                                                                 | Include all contract packages in normal verification; rebuild and compare source, `dist`, packed tarball, lockfile integrity, and runtime-resolved digest | V1         |
| C2      | Leadership content contract                                                                                        | One shared or mechanically compared set of path, schema, hashing, and policy predicates; every behavioral change alters immutable identity                | V1, V3     |
| C3      | Leadership public-content contract for authored IDs; Leadership persistence contract for physical IDs and bindings | Explicit transforms and common bounds; round-trip/ambiguity tests; remove legacy enum                                                                     | V1, V2, V3 |
| C4      | Leadership pre-promotion transaction                                                                               | Prove lossless-to-typed parity, scoped binding resolution, ID mapping, and practice cardinalities before promotion                                        | V3         |
| C5      | Leadership affected route/MDX resolver                                                                             | Probe exact route with release identity and an allowlisted scoped-content assertion before success                                                        | V4         |
| C6      | Leadership deployed capability record plus Studio compatibility rule                                               | Check immutable package, migration, renderer, ID-normalization, typed-parity, and route-probe capabilities at deployment and pre-review enqueue           | V2         |

### Applicable checks

| Check                                                              | Lifecycle placement                                                                           | Reproduced failures covered        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| V1 — source/generated/package equivalence and consumer conformance | Contract package build, both repository verification commands, release preparation            | F1, F2, F4 and remaining ID bounds |
| V2 — deployed capability compatibility                             | Leadership deployment, Studio deployment, and immediately before review enqueue               | F1, F3, F4, F6                     |
| V3 — candidate/projection/database validation                      | Studio candidate preflight and the atomic Leadership transaction immediately before promotion | F2, F4, F5                         |
| V4 — runtime identity and affected-route verification              | After promotion but before Studio success receipt                                             | F3, F5                             |

### Why the minimum option is sufficient

- Package provenance resolves the demonstrated source/tarball ambiguity.
- A small deployed capability record resolves version strings that do not
  express renderer and ID behavior.
- The existing SQL transaction is already the correct atomic boundary for
  candidate-specific typed parity.
- The existing post-promotion verification stage is already the correct place
  to add the affected-route assertion.
- No evidence requires cross-repository code generation, a compatibility
  service, or coordinated release infrastructure.

### Transition and rollback constraints

1. Add Leadership package provenance, capabilities, V3 parity, and route-probe
   support before Studio requires them.
2. New Studio must reject old Leadership before review enqueue.
3. Old Studio may run with new Leadership only when the declared compatibility
   rule accepts its capabilities and later acceptance tests pass.
4. Keep migrations additive and preserve immutable releases, append-only grants,
   generation fencing, idempotent promotion, and restoration functions.
5. Roll back application code only to a release whose capability set remains
   compatible with the deployed schema and Studio gate.
6. A failed V4 probe must withhold success and expose a recovery fence.
   Automatic restoration after render-probe failure is a separate policy
   decision; this investigation does not approve it.

## Diagnostics and safe reconstruction

Existing operation, publication, release, manifest, and pointer generation IDs
can identify a failed publication. They cannot currently explain an affected
route or typed/lossless mismatch.

The minimum additional allowlisted fields are:

- producer commit and resolved contract-package digest;
- consumer commit and deployed capability-set digest;
- candidate release ID and manifest hash;
- affected situation slug;
- typed-parity predicate code and safe outcome;
- affected-route probe code, HTTP class, observed release identity, and
  allowlisted assertion code; and
- recovery-fence state.

Do not log content bodies, prompts, provider output, credentials, connection
strings, or rendered private payloads.

## Prioritized follow-up work

### P0 — production implementation spec

Create one implementation spec, after owner approval, covering:

1. Leadership content-contract source ownership and reproducible packages.
2. Policy identity that changes whenever path/schema/ID behavior changes.
3. A read-only deployed capability record and Studio pre-review gate.
4. Explicit authored/logical/physical/binding identifier rules and compatible
   bounds.
5. Atomic V3 lossless-to-typed parity, including practice rounds/choices.
6. V4 affected-route verification before success receipt.
7. Dedicated non-retryable error classes and safe diagnostic fields.
8. Both supported deployment orders and rollback compatibility.

### P1 — focused conformance and deployment tests

- Add the fixture and six mutations as repository-owned acceptance tests.
- Add consumer tests to both repositories using exact built package artifacts.
- Make root verification exercise every contract package.
- Make both deployment preflights check declared cross-repository
  compatibility.

### P2 — residual runtime coverage

Only after the P0 gates pass, consider catalog/feed/sitemap visibility,
multi-instance cache convergence, and broader scoped artifact types. Do not add
them to the initial implementation matrix without a distinct demonstrated
predicate.

## Acceptance contract for the later implementation

After the approved change:

- the positive fixture succeeds end to end;
- every negative control rejects at its desired future gate;
- pre-promotion rejection leaves the official pointer unchanged;
- supported transition pairs work in both required deployment orders;
- unsupported pairs reject before review or production mutation;
- deterministic incompatibility is non-transient and non-retryable;
- V3 proves lossless/typed/binding agreement;
- V4 confirms the affected page before a success receipt; and
- a V4 failure withholds success and exposes an explicit recovery fence.

These are future acceptance criteria, not current pass claims.

## Residual risks and unknowns

The recommendation does not eliminate:

- unknown deployed commits, packages, migrations, or topology;
- provider, authentication, capacity, network, database, filesystem, CDN,
  browser, or framework failures outside the tested assumptions;
- semantic content mistakes not expressible as deterministic contracts;
- contract dimensions outside C1–C6 and the six mutation classes;
- routes and renderer components outside the tested situation page;
- catalogs, feeds, sitemaps, and cache convergence not implicated here;
- operator actions outside enforced permissions; or
- simultaneous promotion/restoration infrastructure failure.

Production behavior remains an unverified hypothesis until exact deployed
identities and read-only evidence are available.

## Evidence appendix

### Toolchain

- Node `v24.18.0`
- pnpm `11.9.0`
- Git `2.49.0`
- Docker `28.0.1`
- PostgreSQL client `18.2`
- disposable PostgreSQL image `postgres:16.12-bookworm`

Run-manifest SHA-256:
`908a5b165c92ee7bc99d193a13847a2e757f8c0de02a686da6c46fadd1daeea3`.

### Evidence table

| ID  | Claim                                 | Exact identity / location                         | Command or inspection                                                        | Expected / observed                                  | Confidence | Retained artifact                                            |
| --- | ------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | ---------- | ------------------------------------------------------------ |
| E1  | Current baselines pass                | S1 and L1                                         | `pnpm db:generate && pnpm test`; read-only `GIT_DIR=... pnpm test`           | 219/219 and 43/43 passed                             | Proven     | `logs/S1-test-rerun.log`, `logs/L1-test-rerun.log`           |
| E2  | Situation contract is reproducible    | L1 source/dist and package digest `9cd3...a297`   | `pnpm exec tsc ...`; `cmp`/`diff`/SHA-256                                    | JS and declarations byte-identical                   | Proven     | `artifacts/situation-rebuilt-with-map/`                      |
| E3  | Content policy identity collides      | Content packages `0.1.0` and `0.1.1`              | Import both tarballs; compare path classification and `validationPolicyHash` | Scoped path reject/accept; hashes equal              | Proven     | extracted `artifacts/packages/content-*`                     |
| E4  | Studio scoped validation fix boundary | `1ea612b` / `07362dd`                             | Run fixed candidate test against both exports                                | Before accepts; after rejects                        | Proven     | `logs/scoped-before.log`, `logs/scoped-after.log`            |
| E5  | Renderer-context fix boundary         | `ad98dc2` / `e8a4a49`                             | Unit wrapper test and actual Next affected route                             | Before global fallback; after scoped practice        | Proven     | `logs/renderer-*.log`, page logs                             |
| E6  | ID-normalization fix boundary         | L0 / L1                                           | Run L1 typed-consumer test against both exports                              | L0 rejects physical ID; L1 returns authored ID       | Proven     | `logs/id-before.log`, `logs/id-after.log`                    |
| E7  | Transition square                     | Exact S0/S1 × L0/L1 archives                      | Focused disposable two-database publisher/consumer harness                   | L0 cells unsafe; L1 cells positive-compatible        | Proven     | `artifacts/compatibility-matrix.json`                        |
| E8  | Positive affected page                | S0/L1 and S1/L1                                   | Next.js loopback route; in-app browser for S0/L1                             | HTTP 200 and scoped practice visible                 | Proven     | `logs/page-S0-L1-browser.log`, `logs/page-S1-L1-browser.log` |
| E9  | Missing renderer is silently wrong    | S1/ad98dc2                                        | Publish fixture then request exact affected route                            | HTTP 200, scoped title absent                        | Proven     | `logs/page-S1-L-render-before.log`                           |
| E10 | Invalid typed projection is promoted  | S1/L1 with test-only initial-insert mutation      | Truncate typed rounds, publish, inspect job/pointer, request route           | Job `SUCCEEDED`, pointer changed, route HTTP 500     | Proven     | `logs/page-invalid-typed-S1-L1.log`                          |
| E11 | Receipt proves identity only          | S1 `finalizeSuccess`, `runtimeIdentityFromHealth` | Source inspection                                                            | Only DB/runtime IDs and hashes recorded              | Proven     | Source at exact S1                                           |
| E12 | SQL omits typed semantic parity       | L1 `leadership_studio_validate_release`           | Source inspection plus E10                                                   | Hash/count/binding checks pass one-round projection  | Proven     | Migration at exact L1                                        |
| E13 | No pre-review capability gate         | S1 `requestPublication`; deployment scripts       | Source and deploy-contract inspection                                        | No renderer/ID/projection capability handshake       | Proven     | Source at exact S1/L1                                        |
| E14 | Durable boundaries remain effective   | S1 publisher tests and L1 SQL/tests               | Source inspection; append-only delete diagnostic                             | Immutable/fenced/idempotent/restore controls present | Supported  | Existing exact-ref tests                                     |
| E15 | Independent review sustains F5        | Exact S1/L1 sources and retained F5 diagnostic    | Read-only source/log review plus fresh contract control                      | Root cause and V3/V4 mapping sustained               | Supported  | Reviewer result; command and provenance below                |

E10 directly asserted the job state and pointer, not the receipt row. Receipt
existence follows from E11: `finalizeSuccess` creates the receipt and changes the
job to `SUCCEEDED` within one transaction.

### F5 diagnostic provenance

The F5 result is a defensive-boundary probe, not evidence that unmodified S1
naturally emits an invalid typed projection. The test first created a valid
two-round lossless body, then the temporary publisher export applied:

```text
INVESTIGATION_TYPED_PROJECTION_MUTATION=TRUNCATE_SCOPED_PRACTICE_ROUNDS
INVESTIGATION_EXPECT_SCOPED_ROUNDS=1
INVESTIGATION_EXPECT_CONSUMER_OUTCOME=fail
INVESTIGATION_PAGE_EXPECTATION=render-failure
pnpm exec vitest run --config vitest.integration.config.ts \
  apps/publisher/test/publisher.integration.test.ts \
  -t "rejects an incomplete scoped practice before queuing and publishes a complete replacement"
```

The temporary modified source identities were:

- publisher source:
  `d49ee7f08926e14c01e67e4f735067085ad2a49cd577a26b264b37e115523d41`;
- publisher integration test:
  `df0598769e518d75e5aa343f8cfe7da3bbed7b8d04d249705f39cb24e11c3f0d`.

The retained affected-page log is
`c4df89857b9f881055de4992c1ef1d20ed4e371aa6a6cf7f119af0b3f993afc0`.
It records a passing focused test whose assertions require publication success,
one typed round, consumer failure, HTTP 500 from the affected page, and retained
candidate identity.

### Independent review

An independent read-only reviewer sustained the F5 root cause and the minimum
architecture. The reviewer confirmed that L1 SQL never inspects practice
rounds/choices, the L1 typed reader reparses with the two-round contract, and
Studio verifies runtime identity before its atomic success finalization. The
reviewer mapped F1–F6 to V1–V4 without finding evidence for broader
infrastructure.

The reviewer also reran this contract control from the L1 export:

```sh
node --input-type=module -e 'import { practiceSchema } from "./node_modules/@leadership-field-guide/content-contracts/dist/schemas.js"; const choice=(id)=>({id,label:"x",consequenceId:"c",consequence:"x",explanation:"x",signal:"toward"}); const round=(id)=>({id,setup:"x",prompt:"x",choices:[choice("a"),choice("b")]}); const positive=practiceSchema.safeParse({id:"review-control",title:"x",description:"x",estimatedTime:"x",rounds:[round("r1"),round("r2")]}); const negative=practiceSchema.safeParse({id:"review-control",title:"x",description:"x",estimatedTime:"x",rounds:[round("r1")]}); if(!positive.success||negative.success) process.exit(1); console.log(JSON.stringify({positive:"accepted",negative:"rejected",negativePath:negative.error.issues[0]?.path.join("."),negativeCode:negative.error.issues[0]?.code}));'
```

Observed:

```json
{
  "positive": "accepted",
  "negative": "rejected",
  "negativePath": "rounds",
  "negativeCode": "too_small"
}
```

### Artifact hashes

| Artifact                               | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `artifacts/fixture-and-mutations.json` | `328d2de4f5738eba21ca88ab6cbfe6fa58417d76fe9d1a13f2da4227091ee9a8` |
| `artifacts/compatibility-matrix.json`  | `419c5cf09eb8891dbe023f33a800031619aa91a0ce76b68a7a1d6900d35bd7a1` |
| `artifacts/architecture-decision.json` | `0af61d4cf4bef7fbb6ea681dc2d1c3dfebecdaa4215a79b4edc6158b29cca995` |
| S1 baseline log                        | `c63e0a7bcd9b5d97bc44a251886c3ac734c6758a7a525567b36da8cfadbd2890` |
| L1 baseline log                        | `4d5a6cb12f891378584f298857b4a57aee5db1b9bb685f1b6349ef909e0dadfa` |
| Invalid typed affected-page log        | `c4df89857b9f881055de4992c1ef1d20ed4e371aa6a6cf7f119af0b3f993afc0` |

### Execution caps and cleanup

- Six unique executable version cells selected; cap: eight.
- Ten selected integration outcomes plus two harness-shaping attempts; total:
  twelve, equal to the cap.
- Five full affected-page executions; cap: six.
- No database/runtime mutation set, provider fault, or restart fault was
  multiplied into a Cartesian matrix.
- All test-owned containers and local Next.js processes stopped.
- No investigation-owned production or shared resource exists.

### Protocol deviation

The cheapest existing positive publication test couples its valid scoped
publication with an initial one-round editor-validation assertion. Reusing that
test for the four transition cells therefore repeated the already-fixed,
Studio-local M2 rejection instead of running it only once on S1/L1. The repeated
assertion stopped before enqueue, created no candidate or pointer side effect,
and returned the same deterministic 422 result in each cell. It did not add a
database/runtime mutation dimension or exceed the scenario cap, but it was
unnecessary repetition relative to the spec. A later repository-owned matrix
should separate the positive fixture from each negative control.
