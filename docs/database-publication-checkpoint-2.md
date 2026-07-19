# Database-authoritative publication — Checkpoint 2

Status: implemented and verified locally on 2026-07-19. No production
migration, production backfill, publication-target mutation, Leadership shadow
read, reader cutover, publication retry, deployment, or remote Git operation
was performed.

## Result

The deterministic bootstrap manifest is
`cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e`.
It materializes 32 managed artifacts, 99 body-derived relationships, 349,232
canonical bytes, and 24 dynamic-route contract probes. Rebuilding the package
twice produces identical canonical manifest bytes and the same hash.

The package is under `artifacts/database-publication/bootstrap/`:

- `manifest.json` is the exact canonical snapshot manifest and covers both
  artifact membership and graph edges;
- `blobs/<sha256>` contains every canonical body, including the binary logo;
- `inventory.json` records discovery roots, raw source evidence, canonical
  hashes, lengths, encodings, and normalization;
- `parity-report.json` records 32 exact canonical-source matches and zero
  mismatches;
- `graph.json` is the cache-oriented projection of the 99 manifest edges;
- `route-probes.json` enumerates every situation, guide, practice, and tool
  route whose render inputs compile and validate;
- `tool-extraction.json` binds the old executable surface to the new data
  surface and its fixed semantic behavior hash;
- `receipt.json` records the manifest, policy, source release, counts, and
  total bytes without a nondeterministic generation timestamp.

The historical Git commit and release remain evidence fields only. Neither the
builder, independent verifier, nor database backfill invokes Git or contacts a
Git remote.

## Complete inventory boundary

The old frozen manifest had 29 bodies. It omitted three files inside the
specification's supporting-source-material boundary: the workshop README, the
README's PNG logo, and the source-material booklist CSV. The canonical
inventory closes that gap and contains:

| Artifact type       |  Count |
| ------------------- | -----: |
| Situation MDX       |     15 |
| Guide MDX           |      3 |
| Practice JSON       |      3 |
| Source artifacts    |      3 |
| Author catalog      |      1 |
| Tool catalog        |      1 |
| Syllabus/lessons    |      4 |
| Preparation prompt  |      1 |
| Binary source asset |      1 |
| **Total**           | **32** |

Discovery walks only the approved roots and rejects symlinks, traversal,
unsupported file kinds, oversized artifacts, invalid UTF-8 text, and unknown
managed filesystem entries. Application routes, components, promotion output,
validators, and other executable files remain application code and are not
snapshot members.

Text bodies use one documented canonical rule: CRLF and CR become LF and all
trailing newlines become exactly one LF. Twenty-nine files were already exact.
The booklist CSV, workshop README, and lesson-plan-generator prompt required
only that newline normalization. Binary bytes are never normalized. The PNG is
192,856 unchanged bytes with SHA-256
`1768afcfe69527e4b176e216e665281cf1f267080e066ba882f61ed71bf8e7d0`.

## Converted executable content

There was one code-embedded managed surface: `../leadership/lib/tools.ts`.
Its three tool definitions and 22 fields now live in the validated data file
`../leadership/content/tools/tools.json`. `lib/tools.ts` is a compatibility
adapter that parses and exports that catalog with the unchanged `tools`,
`ToolConfig`, `ToolField`, and `getTool` API.

The frozen executable-file hash is
`0e8448ffd733457c3f704c99fddeb7cb66374636a27c9fb18624356b00c1b00e`.
The recorded pre-migration behavior and extracted catalog both have semantic
hash `e813da8f2cfb790bfaf7bfd9e79e28ef75aa81c3e335fae447cf6565b11c9c1f`.
Leadership tests additionally prove the three IDs and 9/7/6 field counts
remain unchanged.

No TypeScript or JavaScript body is approved for database import. The old
`lib/tools.ts` path is removed from the managed-path allowlist.

## Shared contract package

`packages/content-contracts` is the pure package
`@situation-studio/content-contracts`. It has no filesystem, React, Next.js,
database, or Git dependency. It owns:

- situation and guide frontmatter, practice, source, author, and tool schemas;
- approved paths, artifact classification, media types, encodings, and size
  limits;
- canonical text/JSON and SHA-256 rules;
- immutable manifest and graph schemas;
- exact manifest/hash/body validation and duplicate ID/path rejection;
- reviewer/date provenance and body-derived reference validation;
- allowlisted MDX components, executable-MDX rejection, and MDX compilation;
- route-contract projection for every dynamic content surface;
- deterministic add/modify/no-change/delete overlay semantics.

Studio tests and the database materializer consume the workspace package.
Leadership consumes the same compiled package as the vendored, versioned
`vendor/situation-studio-content-contracts-0.1.0.tgz`; `lib/schema.ts` now only
re-exports the shared schemas and types. This keeps Leadership independently
installable while establishing one implementation of the contract.

The only approved custom MDX components are `PracticeEmbed` and
`PreparedAction`. Module syntax, executable attributes, unsafe HTML elements,
unknown uppercase components, invalid component/frontmatter bindings, invalid
JSON, missing references, corrupt hashes, duplicate identities, and excessive
sizes all fail closed.

## Database backfill

The additive migration
`20260719163000_database_publication_binary_content_expand/migration.sql`
adds `ASSET` and content encoding support. Existing UTF-8 blobs keep their
current representation. Binary bodies use immutable `bytea`; the legacy
required text body remains an empty compatibility value. Database checks and
snapshot-finalization triggers hash the representation selected by the
encoding.

`packages/testing/src/backfill-database-bootstrap.ts`:

1. refuses every database whose name does not match the dedicated
   `situation_studio_migration_test_*` safety pattern;
2. verifies every pre-existing blob before making changes;
3. validates the frozen package independently;
4. reconciles the managed artifact registry, including the tool path move;
5. inserts missing immutable text and binary blobs;
6. materializes all 32 snapshot members and 99 same-snapshot edges;
7. finalizes the snapshot only after database hash/count/length checks pass;
8. reruns itself and proves the second pass reuses the exact snapshot;
9. verifies complete database byte and graph parity; and
10. proves all official/candidate pointers and target generations are
    unchanged.

On PostgreSQL 16.12, a fresh nine-migration database created snapshot
`e8b6b77b-de5f-44e3-8562-e2ee93e56a29`. A second backfill was a no-op. The
database snapshot and package manifest were byte-identical, all 32 bodies and
99 edges matched, and there were zero publication-target changes. This UUID is
disposable test evidence, not a production identity.

A PostgreSQL 16 custom-format dump of that backfilled database was 534,564
bytes with SHA-256
`9c10881825c50f40ebdb6039343e041e95205567bbcb28074411ba149b16522d`.
Restoring it into a separate database preserved the same snapshot UUID,
manifest, 32 text/binary blobs, and 99 edges; the backfill verifier reused the
snapshot and again reported zero target changes.

The backfill deliberately does not create or bootstrap a publication target.
Selecting an official snapshot and adding any Leadership database reader are
later approval-gated checkpoints.

## Deterministic verification

The Checkpoint 2 command is:

```text
DATABASE_URL=<dedicated migration-test database> pnpm verify:database-publication
```

It validates Prisma, rebuilds and independently verifies the complete package
without Git, runs the Checkpoint 1 database invariants and privilege boundary,
and runs the idempotent database backfill/parity proof. Separately, the full
Studio suite and Leadership lint/typecheck/content/unit/build suites remain
application-deployment verification.

Checkpoint 2 stops here. A production shadow reader, database content adapter,
candidate view, persistent cache, target bootstrap, public read cutover, and
database publisher are not authorized by this checkpoint.
