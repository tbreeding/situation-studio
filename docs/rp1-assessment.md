# RP1 deployment assessment — inspected 2026-07-18, updated 2026-07-19

The RP1 host was inspected read-only before the first deployment mutation. The current-state entries below were updated from the verified July 19 deployment.

## Current deployment

- Protected URL: `https://situation-studio.timsprototypes.com`.
- Private origin: `http://192.168.1.120:3015`.
- PM2 processes: `situation-studio-web`, `situation-studio-worker`, and `situation-studio-publisher`.
- Current recorded release: `20260719T055257Z` (implementation commit `974e6db`).
- Database: `situation_studio` in PostgreSQL 16, with seven committed migrations applied.
- Baseline: 15 situations and 37 artifacts imported idempotently.
- TimsPrototypes route: registered and enabled.
- First administrator: bootstrapped and active; no credential is recorded in Git or documentation.
- Provider execution: OpenAI Responses API enabled with Codex first; Claude fallback is optional and not configured.
- Publisher execution: enabled with a least-privilege database login, repository-scoped Leadership deploy key, fixed release roots, and one Leadership activation target.
- Leadership candidate: exact commit `b6e40575eb823dc32c62644775895ad84a80d2d1` is staged on the sole Leadership runtime; protected Git `main` remains `9a870e5c70fef9ae71506cb3138745b88363a190` pending final human confirmation.

## Confirmed capacity

- Raspberry Pi 5-class ARM64 host, 4 CPU cores and 8 GB RAM; approximately 5.2 GB was available during inspection.
- Approximately 458 GB filesystem capacity with 6% in use and 2 GB swap.
- PostgreSQL 16.12 runs in the existing `postgres16` container with `max_connections = 100`; 44 connections were observed. Studio therefore keeps the documented small pools and must stay below the 70-connection warning threshold for the whole cluster.
- Port 3015 was unused and is reserved by Studio. Leadership continues to use its existing single runtime on port 3005.
- The Leadership beta remains a versioned release/symlink deployment on its sole port 3005 runtime. Studio is a separate release tree with three PM2 processes.

## Gate and network evidence

The existing TimsPrototypes wildcard tunnel already supports the `situation-studio` slug. Registration must use the owner GUI and a literal allowlisted private RP1 IPv4; it must not add a Cloudflare or Traefik rule manually. Studio must bind only that private IPv4 and still enforce its own login, exact public Host/Origin, CSRF, and secure host-only cookies.

PostgreSQL currently listens on all IPv4 and IPv6 interfaces. This is a pre-existing host risk, not a reason to weaken Studio credentials. Before inviting an external friend, inventory every current database consumer, then restrict host/firewall exposure without breaking those services. Until that review is complete, use SCRAM, separate roles, loopback database URLs, and no broad grants.

## Prerequisite status

The protected web beta, real AI worker, and trusted candidate-staging publisher are live. Final publication remains paused at the explicit human-confirmation boundary. Current prerequisite status:

| Prerequisite                                                                           | Status                               |
| -------------------------------------------------------------------------------------- | ------------------------------------ |
| Mode-0600 `shared/web.env` and `shared/migrator.env` with distinct database identities | Complete                             |
| Interactive first-administrator bootstrap                                              | Complete                             |
| Provider service/API credentials and qualified real-adapter production run             | Complete; 22/22 Codex roles passed   |
| Restricted publisher service identity, Git deploy key, and release capability          | Complete; candidate staging verified |
| Encrypted database backup and clean restore rehearsal                                  | Pending                              |
| TimsPrototypes registration and protected external route                               | Complete                             |

Production final publication and rollback still require explicit human direction and verification. Production must not substitute the web process or an administrator's personal Git/provider credentials. The remaining external-beta blockers are automated encrypted backup/restore evidence and coordinated database listener/firewall hardening.
