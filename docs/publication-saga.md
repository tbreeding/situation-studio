# Publication saga and crash contract

Only a trusted publisher can advance an immutable approved bundle. AI output can never call this boundary.

```mermaid
stateDiagram-v2
  [*] --> REQUESTED
  REQUESTED --> WORKTREE_READY
  WORKTREE_READY --> APPLIED
  APPLIED --> VALIDATED
  VALIDATED --> COMMITTED
  COMMITTED --> PUSHED
  PUSHED --> PREVIEW_BUILT
  PREVIEW_BUILT --> PREVIEW_VERIFIED
  PREVIEW_VERIFIED --> AWAITING_CONFIRMATION
  AWAITING_CONFIRMATION --> CUTOVER
  CUTOVER --> LIVE_VERIFIED
  LIVE_VERIFIED --> RECONCILED
  VALIDATED --> FAILED_PREVIEW
  PUSHED --> FAILED_PREVIEW
  PREVIEW_BUILT --> FAILED_PREVIEW
  CUTOVER --> AUTO_ROLLED_BACK
  LIVE_VERIFIED --> AUTO_ROLLED_BACK
  REQUESTED --> RECONCILIATION_REQUIRED
  RECONCILIATION_REQUIRED --> RECONCILED
```

Every step has a unique logical identity, attempt, fence, input/output hash, and external ID. The Git commit contains the publication UUID and bundle/base hashes as trailers. The release marker contains the same UUID and commit. A retry discovers these identifiers before creating an external side effect.

The crash harness injects termination before and after worktree creation, apply, validation, commit, push, build, preview registration, preview health, final confirmation, cutover, public health, and database finalization. It asserts at most one candidate commit, one logical publication, and one cutover; pre-cutover failures leave public unchanged; post-cutover database failure reconciles from the marker; post-cutover health failure restores the recorded previous release.

Force push and destructive history rewriting are never recovery operations. A rollback is a new audited publication whose tree matches a prior verified release.
