import { createDatabaseClient } from "@situation-studio/db";
import { hashPassword } from "../../../apps/web/src/server/auth/password";
import { seedAuthorization } from "../../../apps/web/src/server/setup/authorization";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = databaseUrl
  ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
  : "";
if (
  !databaseUrl ||
  !databaseName.startsWith("situation_studio_migration_test_playwright_")
)
  throw new Error(
    "Browser workspace fixtures require the Testcontainers database.",
  );

const database = createDatabaseClient(databaseUrl, 3);
try {
  await seedAuthorization(database);
  const admin = await database.user.upsert({
    where: { username: "studio-admin" },
    create: {
      username: "studio-admin",
      displayName: "Studio Administrator",
      repositoryReviewerId: "studio-admin-reviewer",
      passwordHash: await hashPassword("Studio-Test-Only-Password-2026!"),
      state: "ACTIVE",
      identityType: "HUMAN",
    },
    update: {
      state: "ACTIVE",
      repositoryReviewerId: "studio-admin-reviewer",
    },
  });
  const administrator = await database.role.findUniqueOrThrow({
    where: { code: "ADMINISTRATOR" },
  });
  await database.userRoleAssignment.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: administrator.id } },
    create: {
      userId: admin.id,
      roleId: administrator.id,
      grantedById: admin.id,
    },
    update: {},
  });
  const editor = await database.user.upsert({
    where: { username: "studio-editor" },
    create: {
      username: "studio-editor",
      displayName: "Studio Editor",
      passwordHash: await hashPassword("Studio-Test-Only-Password-2026!"),
      state: "ACTIVE",
      identityType: "HUMAN",
    },
    update: { state: "ACTIVE" },
  });
  const editorRole = await database.role.findUniqueOrThrow({
    where: { code: "EDITOR" },
  });
  await database.userRoleAssignment.upsert({
    where: { userId_roleId: { userId: editor.id, roleId: editorRole.id } },
    create: {
      userId: editor.id,
      roleId: editorRole.id,
      grantedById: admin.id,
    },
    update: {},
  });

  const official = await database.contentSnapshot.findFirstOrThrow({
    where: { validationState: "VALIDATED" },
    orderBy: { createdAt: "desc" },
    include: {
      artifacts: {
        where: { artifactType: "SITUATION" },
        include: { artifact: true },
      },
      edges: true,
    },
  });
  const repository = await database.repositorySnapshot.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  });
  for (const member of official.artifacts) {
    const slug = member.logicalId.replace(/^situation:/u, "");
    const situation = await database.situation.findUniqueOrThrow({
      where: { slug },
    });
    if (situation.currentPublicationId) continue;
    const version = await database.situationVersion.create({
      data: {
        situationId: situation.id,
        sourceKind: "LEGACY_IMPORT",
        snapshotId: repository.id,
        manifestHash: official.manifestHash,
      },
    });
    await database.versionArtifact.create({
      data: {
        versionId: version.id,
        artifactId: member.artifactId,
        path: member.canonicalPath,
        type: member.artifactType,
        contentHash: member.contentHash,
        changeKind: "NO_CHANGE",
      },
    });
    const publication = await database.publication.create({
      data: {
        situationId: situation.id,
        versionId: version.id,
        kind: "LEGACY_IMPORT",
        commitSha: repository.commitSha,
        manifestHash: official.manifestHash,
        releaseId: `browser:${repository.commitSha}`,
        healthState: "IMPORTED_BASELINE",
        contentSnapshotId: official.id,
      },
    });
    await database.situation.update({
      where: { id: situation.id },
      data: { currentPublicationId: publication.id },
    });
  }

  for (const edge of official.edges)
    await database.artifactEdge.upsert({
      where: {
        snapshotId_sourceId_targetId_edgeType: {
          snapshotId: repository.id,
          sourceId: edge.sourceArtifactId,
          targetId: edge.targetArtifactId,
          edgeType: edge.edgeType,
        },
      },
      create: {
        snapshotId: repository.id,
        sourceId: edge.sourceArtifactId,
        targetId: edge.targetArtifactId,
        edgeType: edge.edgeType,
        evidence: edge.evidence,
      },
      update: {},
    });

  let target = await database.publicationTarget.findUnique({
    where: { code: "leadership-production" },
  });
  if (!target) {
    const created = await database.publicationTarget.create({
      data: { code: "leadership-production" },
    });
    target = await database.publicationTarget.update({
      where: { id: created.id },
      data: {
        officialSnapshotId: official.id,
        bootstrappedAt: new Date(),
        generation: { increment: 1 },
      },
    });
  }
  if (
    target.officialSnapshotId !== official.id ||
    target.candidateSnapshotId ||
    !target.bootstrappedAt
  )
    throw new Error("Browser publication target is not at a clean boundary.");

  process.stdout.write(
    `Browser workspace ready: ${official.artifacts.length} situations and one exact official target.\n`,
  );
} finally {
  await database.$disconnect();
}
