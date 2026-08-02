# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Changed agent review orchestration to keep one review focused through retry waits and terminal failures, pause later reviews until it succeeds or is explicitly stopped, and show safe stage-specific failure explanations. Retrying a historical failure now focuses and resumes that exact retained job, or reports which existing focus must be finished or stopped first.
- Changed automatic section-suggestion acceptance to reject additions, removals, or attribute changes to managed `PracticeEmbed` and `PreparedAction` tags; make those component edits explicitly in the raw MDX editor.
- Changed publication to fail closed for default new-situation drafts and scoped guide variants that content-contract 0.2.0 cannot yet represent as a valid canonical Leadership snapshot.
- Changed live publication verification to use a bounded convergence window, refresh its job lease and publisher heartbeat during every probe, and retain distinct allowlisted runtime-health explanations for the original verification failure and any automatic-recovery failure.
- Changed Leadership promotion to renew its Studio lease throughout release assembly and to recheck the exact claim, checkout, and situation fences immediately before pointer promotion and again before commit, so a reclaimed publisher rolls back instead of publishing stale work.
- Changed a `RECOVERY_REQUIRED` publication to lock new checkouts and editorial changes across Studio until an administrator restores and verifies a known Leadership release; saved work remains available for inspection.
- Changed publication submission and follow-up deployment to fail closed until Studio has a recent, complete, encrypted, receipt-attested off-site backup and a passed restore drill. Workspaces explain the pause while preserving saved drafts, checkouts, and review work; materially future evidence is rejected.
- Added a one-time, checksum-fenced legacy backup-attestation transition so the initially deferred release can adopt receipt-bound off-site evidence without rewriting historical receipts.
- Changed backup execution to require one unambiguous source and receipt endpoint for the same `situation_studio` host, port, and database before single-flight, time-bounded processing with stale-claim recovery and fenced terminal updates, so a misdirected or interrupted run cannot produce trusted evidence.
- Changed follow-up deployment to hold one token-fenced atomic remote lease through verification or rollback and to require an exact, review-state-anchored, decryptable encrypted off-site backup created after full application quiescence before migration.
- Changed restore-drill evidence to be receipt-bound, no more than 30 days old, recorded only after the exact local and configured off-site objects still match the verified receipt, and rejected when the restored production dataset is empty.

### Fixed

- Fixed restore-drill recording so PostgreSQL's legacy `set_config` result cannot make an otherwise successful, non-empty restore appear malformed; unexpected restore output still fails closed.
- Fixed proposal assembly so case-only differences in bundle-writer evidence links do not discard an otherwise complete review, and future assembly failures resume from the bundle writer with downstream audits rerun.
- Fixed repeated bundle-writer failures for plain-text title and description replacements by requiring JSON-encoded metadata and safely canonicalizing only existing string-valued metadata; malformed arrays, objects, and unknown fields still fail closed.
- Fixed Leadership observation reconciliation so an active or recovery-required publication—and any publication started while an external snapshot is being read—cannot be imported into Studio as verified production state.
- Fixed publication validation so the exact assembled Leadership snapshot is checked before promotion, with safe actionable diagnostics and automatic restoration after an already-promoted restart failure.
- Fixed ambiguous promotion failures so a lost commit acknowledgement or failed post-commit identity read reloads authoritative Studio state and enters the global recovery fence instead of recording an ordinary failure while Leadership may already be advanced.
- Fixed interrupted and concurrent publication attempts so one globally coordinated claim owns every state transition, a lease-lost worker yields without touching its replacement, and the next durable attempt preserves and terminalizes the interrupted record before retrying. Terminal job state, events, and attempt evidence now commit atomically, including Leadership connection failures and Studio commit-acknowledgement ambiguity.
- Fixed follow-up deployment cutover so Studio stops new work, waits for unfinished publication attempts, and records an `active-review-state-continuity-v2` receipt proving both unchanged active checkout/draft/review state and the lane migration's expected queue order and owner.
- Fixed deployment rollback so migration, continuity, local-health, or protected-public-gate failures restore the exact previous release and require its local live and ready checks to pass.
- Fixed first-release preflight so it proves `web.env` is explicitly in deferred backup mode before creating a release; follow-up preflight proves required mode through the same candidate-owned verifier.
