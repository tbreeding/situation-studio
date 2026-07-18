# RP1 resource, network, backup, and recovery plan

## Live service record

- Public protected route: `https://situation-studio.timsprototypes.com`.
- RP1 origin: `192.168.1.120:3015`.
- Release root: `/home/admin/projects/situation-studio/releases`.
- Active symlink: `/home/admin/projects/situation-studio/current`.
- Shared environment: `/home/admin/projects/situation-studio/shared`.
- PM2 process: `situation-studio-web`.
- Current recorded release: `20260718T131848Z`.

The route and first administrator are active. Provider execution and publisher authority remain disabled. Backup automation and a clean restore rehearsal remain required operational work.

## Allocations

- Studio web: port 3015, pool maximum 8.
- preview Leadership release: port 3016.
- AI/orchestrator pool maximum 5.
- validator and publisher pool maximum 2 each.
- operations pool maximum 2.
- one full review, one build, and one publication at a time; at most four interactive provider turns.

The Studio origin binds only the RP1 LAN address needed by the existing gateway. PostgreSQL clients use localhost/SCRAM. A host firewall rule must deny non-required LAN/Internet access to PostgreSQL before the friend beta; existing consumers must be inventoried before changing the listener.

## Backup

- nightly `pg_dump -Fc situation_studio`, encrypted, mode 0600;
- keep 14 daily and 3 monthly copies;
- copy one encrypted backup off RP1 daily;
- record checksum, size, PostgreSQL version, baseline Git commit, and copy result;
- verify checksum/decrypt/list daily;
- restore to a clean disposable database monthly and reconstruct one publication;
- RPO 24 hours, RTO 4 hours.

Database backup alone is incomplete: preserve the protected Git remote and release/publication manifests. Public Leadership can continue serving its last exact release while Studio is restored.

## Deployment order

Frozen install and complete local verification precede every release. The production sequence is backup, migration, compatible worker health, web symlink cutover, outer-gate check, Studio login, readiness/SSE, and one safe read. Studio rollback repoints to the prior schema-compatible release; no automatic down migration occurs.

`deploy.sh` implements the versioned release, migration, explicit runtime grants, idempotent baseline import, build, symlink cutover, deterministic PM2 restart, health gate, and automatic application rollback. It deliberately does not create credentials, bootstrap a password, register an outer-gate route, enable providers, configure backups, or grant Git publication authority. Those are separate security-boundary operations.

The first administrator is created only from an interactive RP1 TTY:

```sh
cd /home/admin/projects/situation-studio/current
set -a
source /home/admin/projects/situation-studio/shared/web.env
set +a
source ~/.nvm/nvm.sh
nvm use
corepack pnpm admin:bootstrap --username <username> --display-name "<display name>"
```

The command refuses a second active administrator and accepts the password only through its non-echoing TTY prompt. Break-glass reset revokes all sessions for the target administrator:

```sh
corepack pnpm admin:reset --username <username>
```

See `rp1-assessment.md` for the observed host capacity, database listener risk, and concrete external-beta blockers.
