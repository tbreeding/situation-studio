# RP1 deployment assessment — 2026-07-18

The RP1 host was inspected read-only before any deployment mutation.

## Current deployment

- Protected URL: `https://situation-studio.timsprototypes.com`.
- Private origin: `http://192.168.1.120:3015`.
- PM2 process: `situation-studio-web`.
- Current recorded release: `20260718T131848Z`.
- Database: `situation_studio` in PostgreSQL 16, with four committed migrations applied.
- Baseline: 15 situations and 37 artifacts imported idempotently.
- TimsPrototypes route: registered and enabled.
- First administrator: bootstrapped and active; no credential is recorded in Git or documentation.
- Provider execution: disabled.

## Confirmed capacity

- Raspberry Pi 5-class ARM64 host, 4 CPU cores and 8 GB RAM; approximately 5.2 GB was available during inspection.
- Approximately 458 GB filesystem capacity with 6% in use and 2 GB swap.
- PostgreSQL 16.12 runs in the existing `postgres16` container with `max_connections = 100`; 44 connections were observed. Studio therefore keeps the documented small pools and must stay below the 70-connection warning threshold for the whole cluster.
- Ports 3015 and 3016 were unused. Studio reserves 3015; the Leadership preview reserves 3016.
- The Leadership beta remains a versioned release/symlink deployment. Studio is a separate release tree and PM2 process.

## Gate and network evidence

The existing TimsPrototypes wildcard tunnel already supports the `situation-studio` slug. Registration must use the owner GUI and a literal allowlisted private RP1 IPv4; it must not add a Cloudflare or Traefik rule manually. Studio must bind only that private IPv4 and still enforce its own login, exact public Host/Origin, CSRF, and secure host-only cookies.

PostgreSQL currently listens on all IPv4 and IPv6 interfaces. This is a pre-existing host risk, not a reason to weaken Studio credentials. Before inviting an external friend, inventory every current database consumer, then restrict host/firewall exposure without breaking those services. Until that review is complete, use SCRAM, separate roles, loopback database URLs, and no broad grants.

## Prerequisite status

The protected web beta is live, but AI execution and publication remain disabled. Current prerequisite status:

| Prerequisite                                                                           | Status                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------- |
| Mode-0600 `shared/web.env` and `shared/migrator.env` with distinct database identities | Complete                                |
| Interactive first-administrator bootstrap                                              | Complete                                |
| Provider service/API credentials and qualified real-adapter smoke tests                | Pending; provider execution is disabled |
| Restricted publisher service identity, Git deploy key, and release capability          | Pending                                 |
| Encrypted database backup and clean restore rehearsal                                  | Pending                                 |
| TimsPrototypes registration and protected external route                               | Complete                                |

Publishing stays deterministic/fake only in isolated acceptance environments until the provider and publisher prerequisites are satisfied. Production must not silently substitute the web process or an administrator's personal Git/provider credentials.
