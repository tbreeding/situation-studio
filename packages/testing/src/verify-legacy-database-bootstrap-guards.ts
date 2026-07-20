import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createDatabaseClient } from "@situation-studio/db";

const execute = promisify(execFile);
const databaseUrl = process.env.DATABASE_URL;
const databaseName = databaseUrl
  ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
  : "";
if (
  !databaseUrl ||
  !databaseName.startsWith("situation_studio_migration_test_")
)
  throw new Error(
    "Legacy bootstrap guard verification is allowed only in a dedicated situation_studio_migration_test_* database.",
  );

const database = createDatabaseClient(databaseUrl, 2);
const fixtureCommit = "0000000000000000000000000000000000000003";
const fixtureManifestHash = "3".repeat(64);

async function expectRejectedIdentity(
  logicalId: string,
  canonicalPath: string,
  type: "TOOL" | "VALIDATOR",
  expectedError: string,
): Promise<void> {
  const repositorySnapshot = await database.repositorySnapshot.upsert({
    where: { commitSha: fixtureCommit },
    create: {
      commitSha: fixtureCommit,
      manifest: { fixture: "legacy-bootstrap-guard" },
      manifestHash: fixtureManifestHash,
      parserVersion: "legacy-bootstrap-guard-v1",
      importKind: "LEGACY_IMPORT",
      validationState: "PASSED",
    },
    update: {},
  });
  const artifact = await database.artifact.create({
    data: {
      logicalId,
      canonicalPath,
      type,
      repositorySnapshotId: repositorySnapshot.id,
    },
  });
  try {
    let output = "";
    try {
      await execute(
        "pnpm",
        ["exec", "tsx", "packages/testing/src/backfill-database-bootstrap.ts"],
        {
          cwd: process.cwd(),
          env: process.env,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      throw new Error(
        `Bootstrap unexpectedly accepted ${canonicalPath} as ${type}.`,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Bootstrap unexpectedly accepted")
      )
        throw error;
      output =
        error && typeof error === "object" && "stderr" in error
          ? String(error.stderr)
          : String(error);
    }
    if (!output.includes(expectedError))
      throw new Error(
        `Bootstrap rejected ${canonicalPath} as ${type} for an unexpected reason: ${output}`,
      );
    const [snapshotCount, targetCount, storedArtifact] = await Promise.all([
      database.contentSnapshot.count(),
      database.publicationTarget.count(),
      database.artifact.findUnique({ where: { id: artifact.id } }),
    ]);
    if (
      snapshotCount !== 0 ||
      targetCount !== 0 ||
      !storedArtifact?.active ||
      storedArtifact.canonicalPath !== canonicalPath ||
      storedArtifact.type !== type
    )
      throw new Error(
        `Rejected identity ${canonicalPath} as ${type} left a partial database transition.`,
      );
  } finally {
    await database.artifact.delete({ where: { id: artifact.id } });
  }
}

try {
  await expectRejectedIdentity(
    "tool:catalog",
    "unexpected/tools.ts",
    "TOOL",
    "unapproved legacy path or type",
  );
  await expectRejectedIdentity(
    "tool:catalog",
    "lib/tools.ts",
    "VALIDATOR",
    "unapproved legacy path or type",
  );
  await expectRejectedIdentity(
    "route:home",
    "virtual/route/route-home#route:home",
    "VALIDATOR",
    "outside the approved bootstrap transition",
  );
  process.stdout.write(
    "Verified bootstrap fails closed on an arbitrary tool path, wrong tool type, and wrong retirement type with zero snapshot/target changes.\n",
  );
} finally {
  await database.$disconnect();
}
