import { createDatabaseClient } from "@situation-studio/db";
import {
  bootstrapLegacyAliases,
  bootstrapLegacyPathMoves,
  bootstrapLegacyRetirements,
} from "./database-bootstrap-legacy";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = databaseUrl
  ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
  : "";
if (
  !databaseUrl ||
  !databaseName.startsWith("situation_studio_migration_test_")
)
  throw new Error(
    "Legacy bootstrap fixtures are allowed only in a dedicated situation_studio_migration_test_* database.",
  );

const database = createDatabaseClient(databaseUrl, 2);
const fixtureCommit = "0000000000000000000000000000000000000001";
const fixtureManifestHash = "0".repeat(64);
const fixtures = [
  ...bootstrapLegacyAliases.map((value) => ({
    logicalId: value.legacyLogicalId,
    canonicalPath: value.canonicalPath,
    type: value.type,
  })),
  ...bootstrapLegacyRetirements,
  ...bootstrapLegacyPathMoves.map((value) => ({
    logicalId: value.logicalId,
    canonicalPath: value.legacyPath,
    type: value.type,
  })),
];

try {
  const repositorySnapshot = await database.repositorySnapshot.upsert({
    where: { commitSha: fixtureCommit },
    create: {
      commitSha: fixtureCommit,
      manifest: { fixture: "legacy-production-registry" },
      manifestHash: fixtureManifestHash,
      parserVersion: "legacy-production-fixture-v1",
      importKind: "LEGACY_IMPORT",
      validationState: "PASSED",
    },
    update: {},
  });
  for (const fixture of fixtures) {
    const [byLogicalId, byPath] = await Promise.all([
      database.artifact.findUnique({
        where: { logicalId: fixture.logicalId },
      }),
      database.artifact.findUnique({
        where: { canonicalPath: fixture.canonicalPath },
      }),
    ]);
    if (byLogicalId && byPath && byLogicalId.id !== byPath.id)
      throw new Error(`Fixture collision for ${fixture.logicalId}.`);
    const existing = byLogicalId ?? byPath;
    if (existing) {
      if (
        existing.logicalId !== fixture.logicalId ||
        existing.canonicalPath !== fixture.canonicalPath ||
        existing.type !== fixture.type
      )
        throw new Error(`Fixture identity mismatch for ${fixture.logicalId}.`);
      await database.artifact.update({
        where: { id: existing.id },
        data: { active: true },
      });
      continue;
    }
    await database.artifact.create({
      data: {
        logicalId: fixture.logicalId,
        canonicalPath: fixture.canonicalPath,
        type: fixture.type,
        repositorySnapshotId: repositorySnapshot.id,
      },
    });
  }
  process.stdout.write(
    `Seeded ${fixtures.length} production-shaped legacy artifact registry rows.\n`,
  );
} finally {
  await database.$disconnect();
}
