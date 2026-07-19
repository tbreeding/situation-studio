# Database publication independent security/recovery review

Status: **accepted for Checkpoint 4 security/recovery implementation**. The
first review returned changes required; remediation and a fresh independent
review are complete. The reviewer is not the implementation agent. This is not
a production cutover approval.

## Reviewer record

```text
reviewer name/identity: Codex independent reviewer /root/independent_database_review
reviewer independence from implementation: read-only review; no source, database, or production edits
initial review started UTC: not separately recorded
initial review completed UTC: 2026-07-19T18:15:30Z
Studio base revision: a36b2097722a569c38735ce68d901acbe41037e4 plus local checkpoint worktree
Leadership base revision: b6e40575eb823dc32c62644775895ad84a80d2d1 plus local checkpoint worktree
disposable PostgreSQL version: 16.12
initial result: changes required
fresh review completed UTC: 2026-07-19T18:57:26Z
fresh result after remediation: accepted
reviewed Studio worktree digest: 61c2cd1eb9669ed35cb1b8073585eda445bb2266adccad1af66c275548baa017
reviewed Leadership worktree digest: 90d273c62f8b5a8b2f14940f4f12b80e7b9d27194242129f7bf8bf39022a5ed8
reviewer attestation/signature reference: independent agent final in the current Codex task
```

## Initial blocking findings and disposition

1. Studio's production CSP allowed forms only to `self`, blocking the only
   private cross-origin candidate exchange. Fixed by deriving the exact
   configured Leadership origin into `form-action`; covered by CSP tests.
2. Official/restoration observation fetches had no abort, restoration could
   retry indefinitely, and the publisher never durably wrote
   `RECONCILIATION_REQUIRED`. Fixed with a per-call abort, finite live and
   restoration deadlines, symmetric publication/rollback terminal writers,
   durable events, and an abort/deadline test.
3. Database-native rollback did not durably dispose pre-confirmation failures,
   could retain candidate/cookie/checkout custody, and target contention was
   incomplete across tables/states. Fixed with failure wrapping and cleanup,
   authorization revocation, custody release, complete partial indexes, and an
   advisory-lock cross-table ownership trigger returning
   `DATABASE_UNIQUE_TARGET`.
4. Rollback validation, candidate verification, confirmation wait, official
   pointer commit, and live verification lacked complete durable replay events.
   Fixed with one ordered event for every transition and an exact sequence
   assertion in full acceptance.

Additional security mismatches were also resolved: Leadership candidate
cookies are now `SameSite=Strict` with an explicit same-site continuation;
candidate routes/sessions force private no-store/no-referrer/noindex headers
and omit analytics/advertising; the Leadership-to-Studio exchange requires an
exact bearer secret; and receipt key IDs must match the configured attestation
key ID.

## Fresh-review verification

- Studio `pnpm verify`: 17 test files, 623 tests, formatting, lint, strict
  TypeScript, Prisma validation, bootstrap verification, secret scan, and
  production build passed.
- Leadership `pnpm verify`: 9 test files, 42 tests, lint, strict TypeScript,
  exact content validation, and production build passed. The build reports the
  candidate continuation route and active privacy proxy.
- Fresh database `situation_studio_migration_test_reviewfix4_20260719` on
  PostgreSQL 16.12: all 13 forward migrations and all three grant scripts
  applied; full acceptance passed while Git SSH, askpass, and terminal prompts
  were disabled.
- The reviewer repeated the full verifier on a separate fresh disposable
  PostgreSQL 16.12 database and removed that database/role afterward.
- Acceptance ended with publication `RECONCILED`, rollback `RECONCILED`, two
  idempotent deliveries, 14 durable events, the exact eight-event rollback
  sequence, failed rollback candidate custody released, and injected exhausted
  recovery durably `RECONCILIATION_REQUIRED`.
- The reviewer also ran truly concurrent publication-first and rollback-first
  cross-table races. In each direction the loser waited about two seconds and
  then received `DATABASE_UNIQUE_TARGET`; neither direction deadlocked.
- Built-header probes confirmed Studio `form-action` contains only self and the
  configured Leadership origin, while Leadership candidate plumbing/session
  responses are no-store/no-referrer/noindex.
- No production system, production database, Git remote, or credential was
  mutated. Backup/PITR work remains deferred and continues to block Checkpoint
  5 independently of this code review.

Do not enter credentials, private keys, session material, candidate exchange
tokens, or database URLs in this record.

## Required evidence

Read these documents and compare every claim to implementation and tests:

- `SPEC-database-publication-migration.md`;
- `docs/database-publication-checkpoint-1.md`;
- `docs/database-publication-checkpoint-3.md`;
- `docs/database-publication-checkpoint-4.md`;
- `docs/database-publication-checkpoint-5.md`;
- `artifacts/reports/acceptance.json`.

Run `pnpm verify` in both repositories and run
`pnpm verify:database-publication` against a fresh, grant-provisioned
PostgreSQL 16 database while Git SSH transport is forced to fail. Record the
exact database name, migration count, terminal publication/rollback states,
event count, and whether any Git process, remote, or credential was required.

## Adversarial review checklist

### Schema and authority

- Try to mutate or delete a validated snapshot, member, edge, blob, event,
  confirmation, receipt, and historical Git publication.
- Try to bootstrap or move an official pointer without the exact fenced state
  transition. Try null official, generation skip/reuse, candidate replacement,
  and two active candidates.
- Verify every managed content body and graph edge is in the complete snapshot,
  and executable application code/unknown MDX components cannot enter it.
- Verify the production bootstrap refuses a wrong target, hash, non-clean
  target, or partial pre-existing state and is idempotent at the exact boundary.

### Authorization and attestation

- Attempt candidate selection by guessed snapshot UUID/hash, replayed or
  expired exchange token, stolen cookie with the wrong reviewer/audience,
  revoked authorization, URL/referrer token, and ordinary anonymous request.
- Verify exchange is one-time, cookies are HttpOnly/Secure/SameSite, and no
  token or body appears in logs, metrics, errors, redirects, or documentation.
- Forge, replay, race, stale-date, future-date, wrong-publication, wrong-hash,
  and wrong-key Leadership observations. Verify timing-safe HMAC comparison and
  idempotent duplicate receipt handling.
- Attempt confirmation from an AI/service identity, stale session, wrong
  approval/policy/hash/generation, duplicate request, and rollback request with
  a mismatched current official snapshot.

### Crash, contention, and recovery

- Terminate before and after every durable transition. Confirm retries resume
  one identity, create no partial pointer state, and preserve ordered events.
- Race unrelated publications and rollback/publication requests. Confirm one
  database-enforced winner and one explicit contention result.
- Fail candidate observation before confirmation; public bytes/pointer must be
  unchanged. Fail official and rollback live observation after pointer commit;
  the exact previous pointer must be restored and independently observed.
- Corrupt the database manifest/blob and cache manifest/body/receipt/pointer.
  Verify corrupt data never activates and last-known-good remains exact.
- Restart Leadership with PostgreSQL unavailable, then recover PostgreSQL.
  Verify degraded frozen-cache service and exact convergence without candidate
  leakage or partial content.

### Privilege and operations boundary

- Verify Leadership can execute only the allowlisted official/candidate reader
  functions and cannot read tables, credentials, users, sessions, drafts, AI
  output, or arbitrary candidates or mutate anything.
- Verify web, AI, worker, materializer, publisher, operations, and migrator
  identities have only the documented capabilities; specifically, AI/worker
  cannot approve, confirm, move pointers, or attest.
- Verify Git transport can be unavailable for the full content publication and
  rollback. Application source deployment may still use Git.
- Challenge the five-minute RPO/60-minute RTO design, off-host encryption/key
  custody, restore isolation, frozen-cache boot, prior-app rollback, host
  capacity thresholds, unrelated-service checks, and every abort condition in
  the Checkpoint 5 runbook.

## Acceptance rule

The review is accepted only if no high/critical implementation finding remains,
every claimed Checkpoint 4 security and recovery invariant has direct evidence,
and the reviewer records an explicit `accepted` result. A conditional result,
missing implementation test, or unexplained mismatch keeps Checkpoint 4
pending. Off-host PITR/RPO/RTO proof is the separate hard Checkpoint 5 gate; it
does not change the Checkpoint 4 code verdict. Review acceptance by itself does
not permit production shadow mutation, public cutover, publication, rollback,
or decommission.
