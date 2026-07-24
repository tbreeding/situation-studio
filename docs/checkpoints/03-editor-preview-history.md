# Checkpoint 3 — Editor, preview, and history

Status: complete locally on 2026-07-23.

The situation inventory and one-page workspace replace the former jobs,
approval, staging, and publication surfaces. The workspace includes structured
metadata and required-section editing, optional raw MDX, debounced/blur
autosave, scoped artifact tabs, rendered Leadership-style preview, exact source
diff, review proposal controls, production history comparison, restoration
drafts, explicit start-over, check-in, retirement, and one confirmation for
submission.

The bootstrap reader uses a restricted Leadership role and a repeatable-read,
read-only transaction. The parity fixture imports 15 situations from the
official production-shaped release while preserving release identity, hashes,
content bodies, and relationship context. A write attempt through the reader
role fails.

The browser suite verifies checkout, autosave, reload, preview, review/diff,
dialog focus trap and Escape return, check-in, durable database state,
critical/serious accessibility scans, and no page overflow at both desktop
baselines and the narrow mobile viewport.
