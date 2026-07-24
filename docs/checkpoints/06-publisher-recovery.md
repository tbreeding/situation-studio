# Checkpoint 6 — Publisher and recovery

Status: complete locally on 2026-07-23.

The publisher assembles the newest complete Leadership release, replaces only
the target bundle and owned variants, validates canonical manifest/body hashes,
inserts immutable release rows, and promotes through the restricted
expected-generation function. Unrelated releases rebase automatically; a
changed target yields `NEEDS_REFRESH`.

Success requires matching database and running-runtime release IDs and manifest
hashes. Studio then records the release observation, production occurrence,
verification receipt, backup request, and audit event before releasing the
checkout. A runtime mismatch triggers generation-fenced restoration and keeps
the draft and checkout. Failed restoration creates the global
`RECOVERY_REQUIRED` publication fence.

Cross-database Testcontainers coverage proves least-privilege roles, complete
successor assembly, unrelated-content equality, one Leadership release per
Studio publication ID, automatic restoration, and process restart after each
durable boundary: candidate persistence, Leadership promotion, and runtime
verification. All seven publisher integration scenarios pass.
