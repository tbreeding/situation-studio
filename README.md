# Situation Studio

Situation Studio is a private editorial workbench for Leadership situations.
An editor checks out one situation, works in durable drafts, optionally runs a
22-stage agent review, previews and compares exact content, and submits one
validated change. Leadership remains the sole public content authority.

The redesign and guarded production release candidate are implemented through
checkpoint 7 of
[SPEC-situation-studio-redesign.md](SPEC-situation-studio-redesign.md).
Checkpoint 8 production deployment still requires its exact approval packet;
production content changes require a later, separately named approval.

## Runtime

The pnpm workspace contains three separately credentialed processes:

- `apps/web` — authentication, inventory, checkouts, editing, preview, history,
  proposals, and administration;
- `apps/review-worker` — one globally serialized durable review DAG;
- `apps/publisher` — complete Leadership release assembly, promotion,
  verification, and automatic restoration.

Studio uses its own PostgreSQL 16 database named `situation_studio`. The
separate `leadership_field_guide` database is read through a SELECT-only role;
only the publisher receives restricted release functions.

## Local setup

Use Node.js 24 and pnpm. Copy [.env.example](.env.example) into a local,
uncommitted environment file and supply disposable database URLs and secrets.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

Bootstrap production-shaped history only against a disposable Leadership
clone and its reader role:

```sh
pnpm bootstrap:leadership
```

## Verification

```sh
pnpm verify
pnpm test:integration
STUDIO_BROWSER_DATABASE_URL=... \
STUDIO_BROWSER_ADMIN_PASSWORD=... \
pnpm test:browser
```

`pnpm verify` generates Prisma, checks formatting and types, runs unit and
security tests, and builds the production web bundle. Integration and browser
tests require disposable PostgreSQL databases and are intentionally separate.

Architecture, checkpoint evidence, and the production approval boundary are
documented in [docs/architecture.md](docs/architecture.md),
[docs/checkpoints](docs/checkpoints), and
[docs/runbooks/production-migration.md](docs/runbooks/production-migration.md).
