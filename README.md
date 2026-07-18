# Situation Studio

Situation Studio is the private administration application for creating, reviewing, and publishing coherent Leadership Field Guide learning bundles.

The application deliberately keeps two authorities separate:

- PostgreSQL owns identities, sessions, checkouts, drafts, AI jobs, review history, approvals, and publication records.
- the Leadership Git repository owns the exact published artifact tree and deployable commit history.

The current implementation is a pnpm workspace with visible privilege boundaries under `apps/` and pure domain contracts under `packages/`. External provider execution defaults to disabled. CI and local acceptance use deterministic fake adapters; production requires separately provisioned service/API credentials.

## Local verification

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm baseline:generate
pnpm verify
pnpm test:browser
```

See `docs/architecture.md`, `docs/data-model.md`, `docs/publication-saga.md`, and `docs/operations.md` before deployment.

`deploy.sh` provides an RP1 versioned-release path, but external beta is intentionally fail-closed until the role-separated environment files, interactive administrator bootstrap, provider service credentials, restricted publisher identity, backup/restore proof, and outer-gate registration described in `docs/rp1-assessment.md` exist. Local acceptance never authorizes fake provider or fake publication mode in production.
