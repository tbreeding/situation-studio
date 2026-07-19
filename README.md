# Situation Studio

Situation Studio is the private administration application for creating, reviewing, and publishing coherent Leadership Field Guide learning bundles.

The application deliberately keeps two authorities separate:

- PostgreSQL owns identities, sessions, checkouts, drafts, AI jobs, review history, approvals, and publication records.
- the Leadership Git repository owns the exact published artifact tree and deployable commit history.

The current implementation is a pnpm workspace with visible privilege boundaries under `apps/` and pure domain contracts under `packages/`. The protected production deployment runs the real Codex-first review worker with a separate service/API credential and least-privilege database identity. The trusted repository publisher uses a separate database identity and repository-scoped Git key, activates the exact candidate through the single fixed Leadership PM2 process, and verifies that origin before advancing the publication saga.

## Current production status

The protected application is live at `https://situation-studio.timsprototypes.com` through the TimsPrototypes outer gate. RP1 serves it from `192.168.1.120:3015` as PM2 processes `situation-studio-web`, `situation-studio-worker`, and `situation-studio-publisher`. PostgreSQL has seven migrations applied, the 15-situation/37-artifact legacy baseline is loaded, and the first administrator is active.

OpenAI service-API execution is enabled. A live review of `repeatedly-misses-deadlines` completed 22/22 roles with `gpt-5.6-sol`, zero fallbacks, one proposal bundle, and 3/3 validations. The exact revision-2 bundle was human-approved and staged as candidate commit `b6e40575eb823dc32c62644775895ad84a80d2d1` on `https://leadership.timsprototypes.com` while protected Git `main` remains `9a870e5c70fef9ae71506cb3138745b88363a190`. Staging acquires publisher custody after the user has checked in, while another active checkout still blocks the handoff atomically. Fake-provider and fake-publication behavior remain prohibited in production.

Human review now displays immutable bundle artifacts instead of mutable draft bytes. Preparing approval creates a new canonical child bundle, writes the mapped human reviewer and current review date into changed public MDX, preserves open comments, and reruns deterministic exact-byte validation. Approval, staging, and the publisher reject bundles without this provenance. The production proposal is prepared, approved, and preview-verified, but remains unpublished behind the separate **Publish this reviewed bundle** confirmation.

When the 15-minute recent-authentication window expires, sensitive workspace actions now open an in-context password confirmation and automatically resume the exact pending action after success. The confirmation endpoint keeps the existing session and CSRF boundary, throttles failures, and writes audited success or denial events. The rejected pre-fix production preparation attempt created no child bundle or other workflow mutation.

The published/proposal byte comparison is a true aligned line diff. Removed lines are red, added lines are green, blank counterparts keep later lines aligned, exact line numbers remain visible, and scrolling either pane synchronizes both vertical and horizontal positions.

## Codex-first workflow

Situation Studio now selects OpenAI/Codex first for every review role using `gpt-5.6-sol`; Claude Opus is fallback-only. Production uses the OpenAI Responses API with `store: false` and requires a dedicated `OPENAI_API_KEY`. Personal Codex or Claude CLI authentication is accepted only when the worker is explicitly in isolated `validation` mode and is rejected in production mode.

The full local workflow is implemented: checkout and visible Check in, unsaved-change cancellation, saved revision preservation, 22-role review, active-job cancellation, deterministic candidate edits, connected-surface validation, immutable approval, trusted build, staging on the single Leadership candidate runtime, final human confirmation, atomic Git finalization, reconciliation, and forward-history rollback.

On 2026-07-18 the full publication/rollback flow completed against a disposable PostgreSQL database and bare Git remote. All 22 selected runs used `gpt-5.6-sol`, all review gates passed, publication reconciled commit `01babf29268317b3ca9bbddfd61c6dbe264912fc`, and rollback reconciled commit `e4057416e2627b0d02dc459f25daa66c6248cb10`. The rollback tree exactly matched baseline tree `340bef0d08dfababca804e3a811eb7918bb99959`. Production now independently proves checkout, review, proposal validation, approval, publisher custody, exact Git commit/build, candidate activation on Leadership, and the final-confirmation stop. Production Git finalization and rollback remain deliberately unexercised.

## Desktop operations experience

The approved desktop UI/UX pass is deployed and verified at 1280×800 and 1440×900. It adds capability-aware/current navigation, searchable attention-first inventory controls, a four-section immutable creation brief, rendered guidance with exact expandable MDX source, a plain-language candidate lifecycle, navigable situation dependencies, validated archive confirmation, and action-oriented Jobs and Capacity states.

The pass did not change published Leadership artifact bytes or the workflow/RBAC invariants. The production review created a candidate only; no Leadership repository or live publication bytes changed.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm baseline:generate
pnpm verify
pnpm test:browser
```

The 36-case browser matrix runs desktop Chromium at 1280×800 and 1440×900 plus the existing mobile regression cases. In the latest production-runtime run, 28 applicable cases passed and 8 desktop-only cases were intentionally skipped on mobile. Desktop coverage includes containment, role-aware navigation, inventory behavior, client-side creation validation with no invalid mutation, all 15 read-only published artifacts, rendered/source switching, keyboard-safe Source expansion, real dependency navigation, visible Check in with cancel/discard behavior, an aligned highlighted proposal diff with bidirectional linked scrolling, a disposable proposal sentinel that cannot be mistaken for published guidance, archive cancellation, console checks, and critical/serious accessibility scans.

See `HANDOFF.md` for the exact continuation state. Read `docs/architecture.md`, `docs/data-model.md`, `docs/publication-saga.md`, `docs/operations.md`, and `docs/rp1-assessment.md` before changing production behavior.

`deploy.sh` provides the RP1 versioned-release path and has been exercised successfully. It verifies locally, builds an immutable release, applies migrations and explicit web/service grants, imports the baseline idempotently, cuts over the Studio `current` symlink, restarts the web, worker, publisher, and single Leadership process, and health-checks both origins. Credentials and Git authority are provisioned separately from immutable releases; gateway routes remain owner-UI operations.
