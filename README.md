# Situation Studio

Situation Studio is the private administration application for creating, reviewing, and publishing coherent Leadership Field Guide learning bundles.

The application deliberately keeps two authorities separate:

- PostgreSQL owns identities, sessions, checkouts, drafts, AI jobs, review history, approvals, and publication records.
- the Leadership Git repository owns the exact published artifact tree and deployable commit history.

The current implementation is a pnpm workspace with visible privilege boundaries under `apps/` and pure domain contracts under `packages/`. External provider execution defaults to disabled. The unreleased worktree includes a real Codex-first review worker, Claude fallback, trusted repository publisher, final-confirmation gate, and durable rollback; production still requires separately provisioned service/API credentials and restricted Git authority.

## Current production status

The protected web application is live at `https://situation-studio.timsprototypes.com` through the TimsPrototypes outer gate. RP1 serves it from `192.168.1.120:3015` as PM2 process `situation-studio-web`; the current recorded release is `20260718T131848Z`. PostgreSQL is migrated, the 15-situation/37-artifact legacy baseline is loaded, and the first administrator is active.

Provider execution remains disabled. Real AI review and publication remain fail-closed until qualified service/API credentials, a restricted publisher identity, and the backup/restore controls in the operations documents are completed. The web release must not be interpreted as authorization for fake-provider or fake-publication behavior in production.

## Unreleased Codex-first workflow

Situation Studio now selects OpenAI/Codex first for every review role using `gpt-5.6-sol`; Claude Opus is fallback-only. Production uses the OpenAI Responses API with `store: false` and requires a dedicated `OPENAI_API_KEY`. Personal Codex or Claude CLI authentication is accepted only when the worker is explicitly in isolated `validation` mode and is rejected in production mode.

The full local workflow is implemented: checkout and visible Check in, unsaved-change cancellation, saved revision preservation, 22-role review, active-job cancellation, deterministic candidate edits, connected-surface validation, immutable approval, trusted build, protected preview, final human confirmation, atomic Git/release cutover, reconciliation, and forward-history rollback.

On 2026-07-18 that flow completed against a disposable PostgreSQL database and bare Git remote. All 22 selected runs used `gpt-5.6-sol`, all review gates passed, publication reconciled commit `01babf29268317b3ca9bbddfd61c6dbe264912fc`, and rollback reconciled commit `e4057416e2627b0d02dc459f25daa66c6248cb10`. The rollback tree exactly matched baseline tree `340bef0d08dfababca804e3a811eb7918bb99959`. This is validation evidence, not a production deployment.

## Desktop operations experience

The approved desktop UI/UX pass is implemented and locally verified at 1280×800 and 1440×900. It adds capability-aware/current navigation, searchable attention-first inventory controls, a four-section immutable creation brief, rendered guidance with exact expandable MDX source, a plain-language candidate lifecycle, navigable situation dependencies, validated archive confirmation, and action-oriented Jobs and Capacity empty states.

The pass does not change published Leadership artifact bytes, workflow or RBAC invariants, provider execution, production data, or deployment state. The live release named above remains unchanged until a separately approved deployment.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm baseline:generate
pnpm verify
pnpm test:browser
```

The 36-case browser matrix runs desktop Chromium at 1280×800 and 1440×900 plus the existing mobile regression cases. In the latest production-runtime run, 28 applicable cases passed and 8 desktop-only cases were intentionally skipped on mobile. Desktop coverage includes containment, role-aware navigation, inventory behavior, client-side creation validation with no invalid mutation, all 15 read-only published artifacts, rendered/source switching, keyboard-safe Source expansion, real dependency navigation, visible Check in with cancel/discard behavior, a disposable proposal sentinel that cannot be mistaken for published guidance, archive cancellation, console checks, and critical/serious accessibility scans.

See `HANDOFF.md` for the exact continuation state. Read `docs/architecture.md`, `docs/data-model.md`, `docs/publication-saga.md`, `docs/operations.md`, and `docs/rp1-assessment.md` before changing production behavior.

`deploy.sh` provides the RP1 versioned-release path and has been exercised successfully. It verifies locally, builds an immutable release, applies migrations and runtime grants, imports the baseline idempotently, cuts over the `current` symlink, restarts PM2, and health-checks the private origin. It does not register gateway routes, create human credentials, enable providers, grant Git authority, or establish backup policy.
