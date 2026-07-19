# Database publication Checkpoint 5 — production preflight and cutover runbook

Recorded 2026-07-19. Status: **blocked before production mutation**. Read-only
discovery and the executable release controls are complete. Checkpoint 4
security/recovery implementation was independently accepted at
2026-07-19T18:57:26Z, but the required off-host PITR evidence is not available.
The user deferred backup work for now; this changes no entrance gate and
authorized no production mutation.

## Read-only production discovery

The following was observed without changing RP1, PostgreSQL, either active
release, PM2, a publication request, or either Git remote:

| Boundary                    | Observation                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Studio active release       | `/home/admin/projects/situation-studio/releases/20260719T094530Z`                                              |
| Leadership active release   | `/home/admin/projects/leadership/releases/ae9f5987-017e-4a80-8c47-c10b5de8b994-b6e40575eb82`                   |
| Production schema           | PostgreSQL 16.12, seven applied migrations                                                                     |
| Application health          | Studio live/ready and Leadership origin healthy                                                                |
| Host capacity               | 5.2 GiB memory available, zero swap used, 401 GiB disk free, load 0.19/0.10/0.08                               |
| Process baseline            | All named PM2 processes online; unrelated `poledne-web` already had seven restarts and three minutes of uptime |
| WAL recovery                | `archive_mode=off`; archive command disabled                                                                   |
| Latest visible logical dump | `shared/predeploy-backups/20260719T053331Z.dump`, mode 0600, 288,442 bytes                                     |
| Off-host/encrypted evidence | No WAL archive or `.gpg`/`.age` evidence under the Studio shared tree                                          |

The host has enough observed capacity for a guarded shadow-reader release, but
capacity does not compensate for missing recovery. The accepted five-minute
RPO, encrypted off-host copy, clean PITR restore, and 60-minute RTO have not
been demonstrated. Production shadow deployment remains behind the independent
Checkpoint 4 review; public database reads remain behind all Checkpoint 5
evidence and explicit cutover approval.

## Release controls prepared locally

- The publisher launcher accepts only `PUBLICATION_BACKEND=git` or
  `PUBLICATION_BACKEND=database`; its default remains `git`. Database mode
  starts the database materializer and does not initialize a Git worktree.
- The Leadership launcher optionally loads the mode-0600
  `/home/admin/projects/leadership/shared/content.env` before starting the
  immutable application release. No content/database secret is stored in a
  release or PM2 configuration.
- Leadership application deployment now requires exact commit approval, clean
  pushed `main`, a 50 MiB committed-source archive limit, full local
  verification, an immutable release, atomic symlink cutover, the sole
  Studio-owned PM2 launcher, sanitized content health, and automatic
  prior-release restoration. The former broad `rsync` path is gone.
- `ops/leadership-content.env.example` records the complete shadow/database,
  cache, candidate-exchange, and attestation configuration.
- The production bootstrap command refuses every non-test database unless both
  `DATABASE_PUBLICATION_BOOTSTRAP_TARGET=leadership-production` and the exact
  approval string
  `bootstrap:leadership-production:cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`
  are present. It creates or reuses only that exact validated official
  snapshot and refuses a non-clean existing target.
- A disposable production-shaped rehearsal created the target at generation
  1, then reran as a no-op against the same snapshot and hash.
- Administrator-scoped Studio metrics expose database reachability,
  publication latency/state/outcome, validation failures, official/candidate
  hashes, latest Leadership observation/cache source, rollback outcome, and
  transactional event age. Leadership `/health/content` exposes only its
  official reader/cache health and never returns mismatch details or bodies.

These controls are local and uncommitted. They are not active on RP1.

## Hard entrance gates

All items must be recorded as passing before the first mutation:

1. An independent reviewer—not the implementation agent—accepts the schema
   invariants, candidate authorization, confirmation, crash-resume,
   auto-restoration, rollback, least-privilege roles, and this recovery plan.
2. The exact Studio and Leadership source revisions are committed, pushed,
   clean, and explicitly approved for the window.
3. An off-host encrypted pgBackRest repository and separate encryption-key
   custody are confirmed. `archive_mode=on`, a working `archive-push`, and
   `archive_timeout=60s` are live; archive age is below three minutes.
4. A base backup plus WAL is restored to a new PostgreSQL 16 container/volume,
   never over production. The requested recovery timestamp is no more than
   five minutes behind the incident point, and the complete timed rehearsal is
   under 60 minutes.
5. The restored database proves exact migration head, target generation and
   pointers, immutable snapshots/blobs/edges, confirmations, events,
   observations, audit records, and body hashes. The verifier and frozen-cache
   boot pass against the restored copy.
6. A current encrypted logical dump and frozen canonical content package are
   copied off-host and independently checksum-verified.
7. No active publication, rollback, candidate, checkout custody, unfinished
   migration, unexplained content mismatch, abnormal load, low disk/memory,
   archive lag, or unrelated-service regression exists.
8. The prior Studio and Leadership application releases are readable and the
   symlink-only rollback rehearsal has passed without a down migration.

Any failed or missing gate stops the checkpoint. A logical dump alone does not
satisfy PITR.

Gate 1 is satisfied for the reviewed local worktree digests recorded in
`docs/database-publication-independent-review.md`. Gates 2–8 remain live-window
requirements; the structural blocker is the missing off-host PITR/RPO/RTO
evidence in gates 3–6.

## Recovery rehearsal record template

Record values, not credentials, in the acceptance artifact:

```text
incident/recovery start UTC:
requested recovery timestamp UTC:
base backup label and completion UTC:
first/last restored WAL segment:
off-host repository identity:
repository encryption: verified / failed
archive age at gate (seconds):
restore container/volume/port:
read-only availability UTC:
elapsed RTO (minutes):
effective RPO (minutes):
migration head:
official snapshot UUID/hash/generation:
snapshot/blob/edge verification:
publication/event/confirmation/observation verification:
frozen-cache boot:
application verifier:
result: pass / stop
```

The repository-specific pgBackRest stanza, off-host location, retention, key
owner, and monitoring destination must be supplied by the infrastructure
owner. Credentials and key material must enter only through protected config
or environment files, never command arguments, logs, Git, or this record.

## Minute-by-minute Checkpoint 5 runbook

This schedule ends before public database-reader cutover.

| Time | Action                                                                                                                                                                                                                                                                                            | Proof / abort condition                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| T−90 | Declare the window and publication freeze. Record exact releases, migration head, official public marker, PM2 PIDs/restarts, ports, host load/memory/disk, and no active request/candidate.                                                                                                       | Stop on any unexplained difference from the discovery baseline.                                                                                    |
| T−80 | Confirm independent review, exact source approvals, clean/pushed `main`, shared env files mode 0600, role existence, cache directory mode 0700, off-host repository/key ownership, and restore target isolation.                                                                                  | Stop if any approval, file, role, or isolated target is missing.                                                                                   |
| T−70 | Run pgBackRest check; force/observe a WAL switch; verify successful off-host archival and archive age below three minutes. Start a final physical backup if the approved schedule requires one.                                                                                                   | Stop on check failure, upload failure, or five-minute archive age.                                                                                 |
| T−60 | Create the encrypted logical dump and frozen canonical content package. Compute local plaintext/ciphertext/package hashes, copy encrypted artifacts off-host, and independently verify remote checksums.                                                                                          | Stop on hash, size, encryption, or copy mismatch.                                                                                                  |
| T−50 | Restore the selected base backup plus WAL into the isolated PostgreSQL 16 rehearsal target. Measure from declared incident time through verified read-only availability.                                                                                                                          | Stop if RPO exceeds five minutes or RTO exceeds 60 minutes.                                                                                        |
| T−35 | Run schema, pointer, body/hash, audit/event, role, application, and frozen-cache checks against the restored target. Destroy no production data.                                                                                                                                                  | Stop on any missing/mismatched row, body, edge, grant, or cache receipt.                                                                           |
| T−25 | Run `SITUATION_STUDIO_PREFLIGHT_ONLY=1` for the exact approved release. Recheck unrelated PM2 processes, especially the pre-existing `poledne-web` restart baseline.                                                                                                                              | Stop on host health, archive lag, source archive, or unrelated-process regression.                                                                 |
| T−20 | Deploy the additive Studio release with web backend still `git` and Leadership still `filesystem`; apply all forward migrations and grants. Do not start a database publication.                                                                                                                  | Deploy automatically restores the prior Studio symlink on health failure; never down-migrate.                                                      |
| T−12 | Apply the exact canonical bootstrap using the migrator identity and approval string. Rerun it to prove idempotence; query target generation 1, exact official hash, and null candidate.                                                                                                           | Stop if an existing target is non-clean or any package/database hash differs.                                                                      |
| T−8  | Install Leadership `content.env` in `shadow` mode and run the guarded exact-commit Leadership application deployment, which reloads only `leadership-field-guide`. Exercise the complete route probe set, health surface, cache receipt, query/memory budget, and filesystem/database comparison. | Its automatic failure path restores the prior Leadership symlink/process; stop on any mismatch, degraded host health, or unrelated-service change. |
| T−3  | Rehearse a clean Leadership restart with PostgreSQL unavailable and prove the exact last-known-good official cache, then database reconvergence. Rehearse both application symlinks to their prior compatible releases and back.                                                                  | Stop if cache boot, exact hash, restart, or prior-release health fails.                                                                            |
| T    | Record zero unexplained mismatches, final capacity, PITR/RPO/RTO, frozen-cache boot, app rollback, and unrelated-site results. Return Leadership to approved shadow state.                                                                                                                        | Stop and request explicit Checkpoint 6 cutover approval; do not change public reader mode.                                                         |

## Checkpoint 6 cutover and abort card

This card is prepared but must not be executed until Checkpoint 5 is accepted.

1. Re-run all read-only gates and freeze publication.
2. Change Studio web `PUBLICATION_BACKEND` from `git` to `database` while
   leaving the separate publisher service on `git`. Change Leadership
   `LEADERSHIP_CONTENT_MODE` from `shadow` to `database`; reload only Studio
   web and `leadership-field-guide`.
3. Verify the official UUID/hash, `/health/content`, every route probe,
   not-found behavior, one database query per refresh, cache receipt, and
   simultaneous anonymous/public isolation from a private candidate session.
4. Verify Studio live/ready and publication metrics. Verify all unrelated PM2
   PIDs/restarts, ports, origin checks, load, memory, disk, PostgreSQL, and WAL
   archive age.
5. On any unexplained mismatch or host regression, restore the frozen
   filesystem/cache configuration and prior Leadership application symlink,
   reload only `leadership-field-guide`, and verify the frozen official hash.
   Do not move the database pointer or run a down migration.
6. Stop and report before creating the first database-authoritative production
   publication.

## Checkpoints 7 and 8 remain evidence-gated

Checkpoint 7 first changes the separate publisher service backend from `git`
to `database`, then needs a separate exact reviewed bundle and human
confirmation, a complete candidate receipt, official pointer commit, live
receipt, reconciliation, UI/SSE completion, and a user-approved observation
period.
The proposed period remains seven days; elapsed observation cannot be replaced
by a local test.

Checkpoint 8 may remove the Git content publisher, deploy key, configuration,
active Git UI/code, and obsolete current-state schema only after the observation
period, another verified restore, and explicit decommission approval. Git-era
history remains readable. The final contract must rerun the complete verifier,
PITR/frozen-cache recovery, and production smoke suite after removal.
