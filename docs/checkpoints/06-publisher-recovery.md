# Checkpoint 6 — Publisher and recovery

Status: complete locally on 2026-07-23.

The publisher assembles the newest complete Leadership release, replaces only
the target bundle and owned variants, validates the complete candidate with
Leadership's canonical content contract, inserts immutable release rows, and
promotes through the restricted expected-generation function. Candidate
contract failures occur before pointer movement. Unrelated releases rebase
automatically; a changed target yields `NEEDS_REFRESH`.

Success requires matching database and running-runtime release IDs and manifest
hashes. Studio then records the release observation, production occurrence,
verification receipt, backup request, and audit event before releasing the
checkout. Runtime identity uses a bounded convergence window with per-probe
lease and heartbeat renewal. An unavailable, malformed, or mismatching health
identity triggers generation-fenced restoration, keeps the draft and checkout,
and persists an allowlisted cause for the editor. If restoration also fails,
Studio retains any original verification detail and recovery detail as separate
bounded evidence. Failed restoration creates the global
`RECOVERY_REQUIRED` publication fence, makes no claim about the current live
release, and locks new checkouts and editorial mutations across Studio until
publisher reconciliation verifies a known Leadership release. Saved work
remains inspectable throughout.

Cross-database Testcontainers coverage proves least-privilege roles, complete
successor assembly, unrelated-content equality, one Leadership release per
Studio publication ID, automatic restoration, and process restart after each
durable boundary: candidate persistence, committed-but-not-yet-observed
Leadership promotion, observed Leadership promotion, and runtime verification.
It also proves that a non-crash failure in the commit-observation gap enters
`RECOVERY_REQUIRED`, connection failures finish their attempt, and a reclaimed
job terminalizes its preserved interrupted attempt before retrying. Terminal
Studio state, events, and attempt evidence commit atomically; a matching
committed-success receipt defeats commit-acknowledgement ambiguity. Global
claim coordination and claim-token comparisons ensure a lease-lost worker
cannot overwrite its replacement or begin an obsolete Leadership restoration.
The promotion regression replaces worker A's claim both immediately before the
Leadership pointer call and after that call but before commit; in both cases A
rolls back every candidate row and pointer change, and worker B resumes the
preserved publication successfully.
