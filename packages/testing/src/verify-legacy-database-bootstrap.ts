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
    "Legacy bootstrap verification is allowed only in a dedicated situation_studio_migration_test_* database.",
  );

const database = createDatabaseClient(databaseUrl, 2);

try {
  for (const alias of bootstrapLegacyAliases) {
    const canonical = await database.artifact.findUniqueOrThrow({
      where: { logicalId: alias.canonicalLogicalId },
    });
    if (!canonical.active || canonical.canonicalPath !== alias.canonicalPath)
      throw new Error(
        `Legacy alias ${alias.legacyLogicalId} was not adopted exactly.`,
      );
    if (
      await database.artifact.findUnique({
        where: { logicalId: alias.legacyLogicalId },
      })
    )
      throw new Error(`Legacy alias ${alias.legacyLogicalId} still exists.`);
  }
  for (const retirement of bootstrapLegacyRetirements) {
    const retired = await database.artifact.findUniqueOrThrow({
      where: { logicalId: retirement.logicalId },
    });
    if (retired.active || retired.canonicalPath !== retirement.canonicalPath)
      throw new Error(
        `Legacy artifact ${retirement.logicalId} was not retired exactly.`,
      );
  }
  for (const move of bootstrapLegacyPathMoves) {
    const moved = await database.artifact.findUniqueOrThrow({
      where: { logicalId: move.logicalId },
    });
    if (!moved.active || moved.canonicalPath !== move.canonicalPath)
      throw new Error(
        `Legacy path for ${move.logicalId} was not moved exactly.`,
      );
  }
  const transition = await database.auditEvent.findFirst({
    where: { action: "artifact_registry.bootstrap_transition" },
    orderBy: { createdAt: "desc" },
  });
  const before = transition?.beforeMetadata as
    | {
        adoptedAliases?: unknown[];
        movedPaths?: unknown[];
        retiredArtifacts?: unknown[];
      }
    | undefined;
  const after = transition?.afterMetadata as
    | {
        adoptedAliases?: unknown[];
        movedPaths?: unknown[];
        retiredArtifactCount?: number;
        activeArtifactCount?: number;
      }
    | undefined;
  if (
    !transition ||
    before?.adoptedAliases?.length !== bootstrapLegacyAliases.length ||
    before.movedPaths?.length !== bootstrapLegacyPathMoves.length ||
    before.retiredArtifacts?.length !== bootstrapLegacyRetirements.length ||
    after?.adoptedAliases?.length !== bootstrapLegacyAliases.length ||
    after.movedPaths?.length !== bootstrapLegacyPathMoves.length ||
    after.retiredArtifactCount !== bootstrapLegacyRetirements.length ||
    after.activeArtifactCount !== 32
  )
    throw new Error("Legacy registry transition audit evidence is incomplete.");
  process.stdout.write(
    `Verified legacy registry transition: ${bootstrapLegacyAliases.length} aliases adopted, ${bootstrapLegacyPathMoves.length} path moved, ${bootstrapLegacyRetirements.length} artifacts retired without deletion.\n`,
  );
} finally {
  await database.$disconnect();
}
