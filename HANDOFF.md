# Situation Studio handoff

Last updated: 2026-07-23

## Outcome

The Situation Studio redesign is implemented locally through checkpoint 7.
The workbench now provides ordinary username/password authentication, durable
exclusive checkouts, immutable drafts and history, section and raw-MDX editing,
rendered preview and exact diff, optional durable agent review, selective
proposal application, new-situation creation, reversible retirement,
per-situation restoration, and one-action publication.

Publication builds a complete immutable Leadership release, advances the
official pointer with an expected-generation fence, verifies both database and
runtime identities, and automatically restores the prior release if
post-promotion verification fails. Injected process-death tests prove restart
reconciliation after candidate persistence, pointer promotion, and runtime
verification.

## Repository boundary

Situation Studio is at
`/Users/timothybreeding/projects/situation-studio`. The coordinated Leadership
changes are at `/Users/timothybreeding/projects/leadership`, whose baseline
commit remains `58e8634cb3901e55cf58bc17e9f3cac71d201f37`.

Both working trees contain the intentional redesign changes and are not
committed or staged. Existing Situation Studio deletions and prior user changes
were preserved. Do not reset either tree.

The exact shared situation-contract archive has SHA-256
`9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4`
in both repositories.

## Verification state

- Studio unit, integration, publisher lifecycle, crash recovery, type, and
  browser/accessibility suites pass.
- The final gate passes formatting, lint, typecheck, 89 unit tests, 12
  cross-database integration scenarios, a strict post-build secret scan, and
  an optimized production build.
- The browser suite covers 1280×800, 1440×900, and 390×844; all 9 executed
  scenarios pass and 6 duplicate state-mutating scenarios are intentionally
  skipped.
- Leadership migration parity and integration suites pass against a
  production-shaped fixture: 32 artifacts, 99 edges, 15 situations, 3 guides,
  and 3 practices.
- A queued encrypted Studio backup persisted a verified database receipt. A
  streamed restore drill recovered all 6 migrations, 15 situations, 15
  production versions, 16 content blobs, and 84 audit events without writing a
  plaintext dump.
- The deterministic 22-stage provider route is qualified. A live service
  provider route was not invoked because no service credential was supplied;
  personal CLI credentials were deliberately not used.

See [docs/checkpoints/07-operations-and-release-candidate.md](docs/checkpoints/07-operations-and-release-candidate.md)
and [docs/checkpoints/independent-review.md](docs/checkpoints/independent-review.md)
for the final evidence and dispositions.

## Production boundary

No production database, process, release, content, or deployment was changed.
Checkpoint 8 requires a new approval packet naming exact commits, migration and
grant checksums, backup destination and restore evidence, host paths, process
configuration, rollback sequence, and—separately—the exact publication test
situation. The prepared procedure is
[docs/runbooks/production-migration.md](docs/runbooks/production-migration.md).

External inputs still required before that approval are:

- an off-RP1 encrypted backup destination and retention choice;
- mode-restricted per-process production environment files;
- a service-provider credential and selected review model for live
  qualification;
- exact clean commits in both repositories.
