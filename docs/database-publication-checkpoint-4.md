# Database publication Checkpoint 4 — disposable publisher acceptance

Recorded 2026-07-19 and updated after review remediation. The implementation
and disposable acceptance suite are complete. The first independent
security/recovery review returned changes required; its findings were fixed,
and the same reviewer accepted the fresh current-tree review at
2026-07-19T18:57:26Z. This report does not authorize production publication.

## Delivered boundary

The database materializer overlays an exact approved immutable bundle on the
current official snapshot, rebuilds the complete canonical manifest, validates
all bodies and graph identities, exposes a private candidate only after
validation, waits for an exact Leadership candidate observation, and accepts
human confirmation only for the displayed snapshot UUID/hash, approval,
validation policy, active reauthenticated session, and target generation.

Official selection and its publication event occur in one serializable
transaction. Reconciliation requires Leadership to attest that it loaded the
same official hash. A post-confirmation health failure restores the recorded
previous official pointer and requires a matching restoration observation.

Rollback is database-native. A forward migration makes legacy Git-era rollback
IDs nullable and adds exact current/selected snapshot identities. A rollback is
itself a candidate, exact human confirmation, official pointer selection,
Leadership observation, and audited database publication. A failed rollback
live check restores and verifies the pre-rollback snapshot. The legacy Git
publisher ignores database-native rollback requests.

Studio now provides one-time candidate authorization, HMAC-attested observation
ingestion, exact publication and rollback confirmation, durable SSE replay with
polling fallback, database-specific progress language, and database-native
rollback controls. Receipt timestamps are freshness-bounded and duplicate
delivery is idempotent.

## Deterministic acceptance

On a fresh PostgreSQL 16.12 database, all 13 forward migrations applied. The
top-level command is:

```sh
DATABASE_URL="$DISPOSABLE_DATABASE_URL" \
ACCEPTANCE_FIXTURE_KEY="unique-disposable-fixture" \
pnpm verify:database-publication
```

It validates Prisma, rebuilds the frozen package without Git, proves database
invariants and least privilege, performs the idempotent 32-artifact/99-edge
backfill, then runs crash-resume, duplicate delivery, exact candidate
observation, exact confirmation, official observation, reconciliation, and
audited native rollback. The recorded final result was:

- publication `RECONCILED`;
- rollback `RECONCILED`;
- two duplicate deliveries, one candidate snapshot;
- 14 ordered durable publication/rollback events, including every rollback
  validation, candidate, confirmation-wait, pointer, live, and reconciliation
  transition;
- no Git remote or Git credential required.

The final fresh-database run also forced `GIT_SSH_COMMAND` and `GIT_ASKPASS` to
`/usr/bin/false` and set the publisher remote to an unreachable loopback SSH
endpoint. Publication and native rollback still both reached `RECONCILED`, so
the acceptance path is proven independent of outbound Git transport.

The same fresh run also proved database-enforced publication-versus-rollback
contention, pre-confirmation rollback failure cleanup and authorization
revocation, and a terminal durable `ROLLBACK_RECONCILIATION_REQUIRED` receipt
after an injected exhausted recovery deadline.

## Fault and contention evidence

- Injected process stop after `SNAPSHOT_MATERIALIZED` resumed the same snapshot
  and publication identity.
- Two target attempts were raced at the database request boundary. The unique
  active-target constraint produced one `CANDIDATE_AVAILABLE` winner and one
  explicit `DATABASE_UNIQUE_TARGET` rejection before materialization, with one
  active candidate.
- Publication live failure after official pointer commit ended
  `AUTO_ROLLED_BACK` with the bootstrap official pointer restored and observed.
- Rollback live failure after rollback pointer commit also ended
  `AUTO_ROLLED_BACK`, restoring and observing the pre-rollback official
  snapshot.
- Native successful rollback returned the exact bootstrap manifest hash
  without deleting the later snapshot, confirmation, events, or receipts.
- SSE encoding/replay tests prove ordered IDs, malformed Last-Event-ID fallback,
  and database-specific progress presentation without active Git language.
- UI presentation tests prove the pre-confirmation unchanged-public message,
  post-confirmation restoration message, and reconciliation message containing
  the differing official, observed, and candidate hashes plus the one safe
  frozen-cache action.
- Safe health metrics cover validation failures, publication latency and
  outcome, official/candidate hashes, cache source/age, database reachability,
  rollback outcome, and direct durable-event replay age.

## Application gates

- Studio: formatting, lint, strict TypeScript, Prisma validation, 623 tests,
  secret scan, and production build passed.
- Leadership: lint, strict TypeScript, content validation, 42 tests, and
  production build passed.
- The complete browser candidate exchange and official-isolation contract was
  exercised against production builds and a disposable PostgreSQL database.

## Independent-review verdict

The independent reviewer completed a first pass at 2026-07-19T18:15:30Z and
returned changes required. Remediation now provides:

- exact configured-origin Studio `form-action`, an authenticated Leadership
  exchange backchannel, Strict candidate cookies with a same-site continuation,
  and candidate no-store/no-referrer/noindex/no-analytics behavior;
- configured attestation-key-ID binding;
- abortable Leadership observation calls, finite live/restoration deadlines,
  and durable reconciliation-required terminal outcomes;
- pre-confirmation rollback failure cleanup, candidate/cookie revocation,
  publisher-custody release, complete active-state indexes, and serialized
  cross-table target ownership;
- a durable ordered event for every rollback transition.

The same reviewer independently reproduced Studio's 623-test gate,
Leadership's 42-test gate, all 13 migrations/grants, Git-disabled full database
acceptance, built candidate/CSP privacy headers, and both directions of a truly
concurrent publication-versus-rollback race. The reviewed implementation was
accepted with no remaining high/critical finding. The disposable review
database/role were removed; no source, production, remote, or credential state
was changed by the reviewer.

Checkpoint 4 is complete locally. This verdict authorizes no production
mutation. Checkpoint 5 remains blocked by its separate off-host PITR/RPO/RTO
gate.

The review packet and sign-off record are
`docs/database-publication-independent-review.md`.
