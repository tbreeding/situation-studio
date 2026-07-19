# Database publication Checkpoint 3 — shadow reader and private candidate

Recorded 2026-07-19. This checkpoint changed no production reader, database,
publication target, release, or credential.

## Delivered boundary

Leadership now has one server-only reader contract with explicit `filesystem`,
`shadow`, and `database` modes. The contract covers situations, guides,
practices, preparation tools, sources, authors, route metadata, related content,
feeds, sitemap entries, and dynamic route parameters. Database reads use the
two batched, binary-safe `leadership_read_*_snapshot_v2` functions and never
accept an arbitrary public snapshot UUID.

The immutable cache is keyed by manifest hash. Every manifest and blob is
verified before installation; official activation uses an atomic durable
pointer. Database mode falls back only to the last hash-verified official
cache. It does not fall back to repository content. Shadow mode continues
serving filesystem bytes while independently recording manifest, byte, graph,
parse, and route-contract parity.

Private candidate access uses a 15-minute, one-time exchange authorization
bound to target, snapshot UUID/hash, human reviewer, audience, and expiry. The
exchange token is posted cross-origin in a form body rather than placed in a
URL. Leadership stores only HttpOnly candidate cookies. Public requests always
select the official pointer. Candidate rendering displays a persistent private
preview warning and emits a signed observation receipt for the exact loaded
hash.

## Verification evidence

- Canonical filesystem/database shadow comparison: exact manifest
  `cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`,
  32 artifacts, 99 edges, zero mismatches, one batched database snapshot call.
- Cache tests: corrupt manifest/blob rejection, candidate non-activation,
  database outage fallback, clean-process restart from last-known-good,
  database recovery convergence, and no repository fallback in database mode.
- A browser exercise found a real concurrent cache-install race. The cache now
  treats `EEXIST`/`ENOTEMPTY` as a content-addressed winner only after the
  winner's complete verification receipt exists. A concurrent three-writer
  regression test passes.
- Rebuilt production-mode browser contract: a one-time exchange rendered the
  exact candidate title with the `Private candidate preview` warning; leaving
  candidate mode removed the marker and returned the same route to the exact
  official title. The candidate observation stored `CANDIDATE`, `HEALTHY`,
  `DATABASE`, and the exact candidate snapshot hash.
- Candidate lifecycle invariants reject expired authorization, replayed
  exchange, wrong-cookie guessing, wrong audience, direct snapshot-table read,
  and revoked authorization.
- Leadership verification: lint, strict TypeScript, content validation, 20
  tests, and the production build with 50 generated routes/pages passed.

## Measured local production-build budget

Measured against PostgreSQL 16.12 and a 32-artifact snapshot:

| Measure                                                |      Result |
| ------------------------------------------------------ | ----------: |
| First database-mode route after process start          |    122.5 ms |
| Warm route requests                                    |  7.2–8.7 ms |
| Snapshot database calls per refresh                    |           1 |
| Next.js resident set after official/candidate exercise | 171,152 KiB |
| Shadow mismatches                                      |           0 |

These are acceptance guardrails for production observation, not universal
latency promises. Production cutover still requires host capacity and shadow
evidence from the RP1 itself.

## Checkpoint result

Checkpoint 3 is complete locally. Production remains Git-authoritative and in
filesystem reader mode until the later production shadow and cutover gates.
