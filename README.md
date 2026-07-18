# Situation Studio

Situation Studio is the private administration application for creating, reviewing, and publishing coherent Leadership Field Guide learning bundles.

The application deliberately keeps two authorities separate:

- PostgreSQL owns identities, sessions, checkouts, drafts, AI jobs, review history, approvals, and publication records.
- the Leadership Git repository owns the exact published artifact tree and deployable commit history.

The current implementation is a pnpm workspace with visible privilege boundaries under `apps/` and pure domain contracts under `packages/`. External provider execution defaults to disabled. CI and local acceptance use deterministic fake adapters; production requires separately provisioned service/API credentials.

## Current production status

The protected web application is live at `https://situation-studio.timsprototypes.com` through the TimsPrototypes outer gate. RP1 serves it from `192.168.1.120:3015` as PM2 process `situation-studio-web`; the current recorded release is `20260718T131848Z`. PostgreSQL is migrated, the 15-situation/37-artifact legacy baseline is loaded, and the first administrator is active.

Provider execution remains disabled. Real AI review and publication remain fail-closed until qualified service/API credentials, a restricted publisher identity, and the backup/restore controls in the operations documents are completed. The web release must not be interpreted as authorization for fake-provider or fake-publication behavior in production.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm baseline:generate
pnpm verify
pnpm test:browser
```

See `HANDOFF.md` for the exact continuation state. Read `docs/architecture.md`, `docs/data-model.md`, `docs/publication-saga.md`, `docs/operations.md`, and `docs/rp1-assessment.md` before changing production behavior.

`deploy.sh` provides the RP1 versioned-release path and has been exercised successfully. It verifies locally, builds an immutable release, applies migrations and runtime grants, imports the baseline idempotently, cuts over the `current` symlink, restarts PM2, and health-checks the private origin. It does not register gateway routes, create human credentials, enable providers, grant Git authority, or establish backup policy.
