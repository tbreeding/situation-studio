# RP1 deployment assessment — 2026-07-18

The RP1 host was inspected read-only before any deployment mutation.

## Confirmed capacity

- Raspberry Pi 5-class ARM64 host, 4 CPU cores and 8 GB RAM; approximately 5.2 GB was available during inspection.
- Approximately 458 GB filesystem capacity with 6% in use and 2 GB swap.
- PostgreSQL 16.12 runs in the existing `postgres16` container with `max_connections = 100`; 44 connections were observed. Studio therefore keeps the documented small pools and must stay below the 70-connection warning threshold for the whole cluster.
- Ports 3015 and 3016 were unused. Studio reserves 3015; the protected Leadership preview reserves 3016.
- The Leadership beta remains a versioned release/symlink deployment. Studio is a separate release tree and PM2 process.

## Gate and network evidence

The existing TimsPrototypes wildcard tunnel already supports the `situation-studio` slug. Registration must use the owner GUI and a literal allowlisted private RP1 IPv4; it must not add a Cloudflare or Traefik rule manually. Studio must bind only that private IPv4 and still enforce its own login, exact public Host/Origin, CSRF, and secure host-only cookies.

PostgreSQL currently listens on all IPv4 and IPv6 interfaces. This is a pre-existing host risk, not a reason to weaken Studio credentials. Before inviting an external friend, inventory every current database consumer, then restrict host/firewall exposure without breaking those services. Until that review is complete, use SCRAM, separate roles, loopback database URLs, and no broad grants.

## Release blockers that are not approval prompts

External beta remains disabled until all of the following concrete prerequisites exist:

1. mode-0600 `shared/web.env` and `shared/migrator.env` files with distinct credentials;
2. an interactive TTY bootstrap of the first Studio administrator—no generated password in an argument, environment variable, file, or chat;
3. provider service/API credentials and qualified real adapter smoke tests, or provider execution left disabled;
4. a publisher service identity with a restricted Git deploy key and release capability, separate from the web and AI worker;
5. an encrypted backup plus clean restore rehearsal;
6. outer-gate registration and an external browser check only after the private origin is healthy.

Publishing stays deterministic/fake outside protected production until items 3 and 4 are satisfied. The app must not silently substitute the web process or an administrator's personal Git/provider credentials.
