import fs from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  sha256,
  snapshotManifestSchema,
  validateCanonicalSnapshot,
} from "@situation-studio/content-contracts";
import {
  createDatabaseClient,
  Prisma,
  type DatabaseClient,
} from "@situation-studio/db";
import matter from "gray-matter";
import { packageRoot, readPackagedBodies } from "./database-bootstrap-package";
import {
  matchesBootstrapLegacyAlias,
  matchesBootstrapLegacyPathMove,
  matchesBootstrapLegacyRetirement,
} from "./database-bootstrap-legacy";

const databaseUrl = process.env.DATABASE_URL;
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const root = packageRoot(studioRoot);
const manifestBody = fs.readFileSync(path.join(root, "manifest.json"), "utf8");
const manifest = snapshotManifestSchema.parse(JSON.parse(manifestBody));
const manifestHash = sha256(manifestBody);
const targetCode = process.env.DATABASE_PUBLICATION_BOOTSTRAP_TARGET;
const databaseName = databaseUrl
  ? decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
  : "";
const disposableMode = databaseName.startsWith(
  "situation_studio_migration_test_",
);
const productionApproval = `bootstrap:leadership-production:${manifestHash}`;
const productionMode =
  !disposableMode &&
  targetCode === "leadership-production" &&
  process.env.DATABASE_PUBLICATION_BOOTSTRAP_APPROVAL === productionApproval;

if (!databaseUrl || (!disposableMode && !productionMode))
  throw new Error(
    "Refusing bootstrap backfill outside a dedicated situation_studio_migration_test_* database without the exact production target and manifest-hash approval.",
  );

const bodies = readPackagedBodies(studioRoot, manifest.artifacts);
const parsed = await validateCanonicalSnapshot(manifestBody, bodies);
const database = createDatabaseClient(databaseUrl, 2);

type TargetIdentity = {
  id: string;
  officialSnapshotId: string | null;
  candidateSnapshotId: string | null;
  generation: bigint;
};

function targetIdentity(value: TargetIdentity): string {
  return canonicalJson({
    id: value.id,
    officialSnapshotId: value.officialSnapshotId,
    candidateSnapshotId: value.candidateSnapshotId,
    generation: value.generation.toString(),
  });
}

async function verifyDatabaseSnapshot(
  client: DatabaseClient,
  snapshotId: string,
): Promise<void> {
  const snapshot = await client.contentSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
    include: {
      artifacts: { include: { content: true } },
      edges: { include: { source: true, target: true } },
    },
  });
  if (
    snapshot.validationState !== "VALIDATED" ||
    snapshot.manifest !== manifestBody ||
    snapshot.manifestHash !== manifestHash ||
    snapshot.artifactCount !== manifest.artifacts.length ||
    snapshot.totalByteLength !==
      BigInt(
        manifest.artifacts.reduce(
          (total, artifact) => total + artifact.byteLength,
          0,
        ),
      )
  )
    throw new Error(
      "Database snapshot identity or totals do not match package.",
    );
  const members = [...snapshot.artifacts].sort((left, right) =>
    left.canonicalPath.localeCompare(right.canonicalPath),
  );
  if (members.length !== manifest.artifacts.length)
    throw new Error("Database snapshot membership is incomplete.");
  for (const [index, member] of members.entries()) {
    const expected = manifest.artifacts[index];
    if (
      !expected ||
      member.logicalId !== expected.logicalId ||
      member.canonicalPath !== expected.path ||
      member.artifactType !== expected.type ||
      member.contentHash !== expected.contentHash ||
      member.byteLength !== expected.byteLength ||
      member.content.encoding !== expected.encoding
    )
      throw new Error(
        `Database membership mismatch at ${expected?.path ?? index}.`,
      );
    const actualBytes =
      member.content.encoding === "BINARY"
        ? member.content.binaryBody
        : new TextEncoder().encode(member.content.body);
    if (!actualBytes || sha256(actualBytes) !== expected.contentHash)
      throw new Error(`Database blob mismatch at ${expected.path}.`);
  }
  const edges = snapshot.edges
    .map((edge) => ({
      source: edge.source.logicalId,
      target: edge.target.logicalId,
      type: edge.edgeType,
      evidence: edge.evidence,
    }))
    .sort((left, right) =>
      `${left.source}\0${left.type}\0${left.target}`.localeCompare(
        `${right.source}\0${right.type}\0${right.target}`,
      ),
    );
  if (canonicalJson(edges) !== canonicalJson(manifest.edges))
    throw new Error("Database graph does not match canonical manifest.");
}

async function verifyAllDatabaseBlobs(client: DatabaseClient): Promise<number> {
  const blobs = await client.contentBlob.findMany({
    select: {
      hash: true,
      body: true,
      encoding: true,
      binaryBody: true,
      byteLength: true,
    },
  });
  for (const blob of blobs) {
    const bytes =
      blob.encoding === "BINARY"
        ? blob.binaryBody
        : new TextEncoder().encode(blob.body);
    if (
      !bytes ||
      bytes.byteLength !== blob.byteLength ||
      sha256(bytes) !== blob.hash ||
      (blob.encoding === "BINARY" && blob.body !== "") ||
      (blob.encoding === "UTF8" && blob.binaryBody !== null)
    )
      throw new Error(`Pre-existing content blob ${blob.hash} is invalid.`);
  }
  return blobs.length;
}

function assertManagedRegistry(
  artifacts: Array<{ logicalId: string; canonicalPath: string }>,
): void {
  const managedPaths = artifacts.sort((left, right) =>
    left.canonicalPath.localeCompare(right.canonicalPath),
  );
  const expected = manifest.artifacts.map((artifact) => ({
    logicalId: artifact.logicalId,
    canonicalPath: artifact.path,
  }));
  if (canonicalJson(managedPaths) !== canonicalJson(expected))
    throw new Error(
      "Active managed artifact registry does not exactly match the bootstrap inventory.",
    );
}

async function verifyManagedRegistry(client: DatabaseClient): Promise<void> {
  assertManagedRegistry(
    await client.artifact.findMany({
      where: { active: true },
      select: { logicalId: true, canonicalPath: true },
    }),
  );
}

async function ensureProductionTarget(
  client: DatabaseClient,
  snapshotId: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await client.publicationTarget.findUnique({
    where: { code: "leadership-production" },
  });
  if (existing) {
    if (
      existing.officialSnapshotId !== snapshotId ||
      !existing.bootstrappedAt ||
      existing.candidateSnapshotId ||
      existing.candidatePublicationRequestId ||
      existing.candidateRollbackRequestId ||
      existing.currentDatabasePublicationId
    )
      throw new Error(
        "Existing Leadership publication target is not the exact clean bootstrap boundary.",
      );
    return { id: existing.id, created: false };
  }

  return client.$transaction(
    async (transaction) => {
      const created = await transaction.publicationTarget.create({
        data: { code: "leadership-production" },
      });
      const bootstrapped = await transaction.publicationTarget.update({
        where: { id: created.id },
        data: {
          officialSnapshotId: snapshotId,
          bootstrappedAt: new Date(),
          generation: { increment: 1 },
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "SERVICE",
          action: "publication_target.bootstrap",
          targetType: "publication_target",
          targetId: bootstrapped.id,
          correlationId: crypto.randomUUID(),
          outcome: "SUCCEEDED",
          afterMetadata: {
            code: bootstrapped.code,
            officialSnapshotId: snapshotId,
            manifestHash,
            generation: bootstrapped.generation.toString(),
          },
        },
      });
      return { id: bootstrapped.id, created: true };
    },
    { isolationLevel: "Serializable", timeout: 60_000 },
  );
}

async function backfill(client: DatabaseClient): Promise<{
  snapshotId: string;
  created: boolean;
}> {
  const existing = await client.contentSnapshot.findUnique({
    where: { manifestHash },
  });
  if (existing) {
    await verifyDatabaseSnapshot(client, existing.id);
    return { snapshotId: existing.id, created: false };
  }

  const result = await client.$transaction(
    async (transaction) => {
      let repositorySnapshot = await transaction.repositorySnapshot.findUnique({
        where: { commitSha: manifest.source.historicalCommit },
      });
      if (!repositorySnapshot)
        repositorySnapshot = await transaction.repositorySnapshot.create({
          data: {
            commitSha: manifest.source.historicalCommit,
            manifest: JSON.parse(manifestBody) as Prisma.InputJsonValue,
            manifestHash,
            parserVersion: "database-bootstrap-v1",
            importKind: "LEGACY_IMPORT",
            validationState: "PASSED",
          },
        });

      const activeRegistry = await transaction.artifact.findMany({
        where: { active: true },
        select: { id: true, logicalId: true, canonicalPath: true, type: true },
      });
      const canonicalByLogicalId = new Map(
        manifest.artifacts.map((artifact) => [artifact.logicalId, artifact]),
      );
      const adoptedAliases: Array<{
        artifactId: string;
        legacyLogicalId: string;
        canonicalLogicalId: string;
        canonicalPath: string;
        type: string;
      }> = [];
      const movedPaths: Array<{
        artifactId: string;
        logicalId: string;
        legacyPath: string;
        canonicalPath: string;
        type: string;
      }> = [];
      const retiredArtifacts: Array<{
        artifactId: string;
        logicalId: string;
        canonicalPath: string;
        type: string;
      }> = [];

      for (const existing of activeRegistry) {
        const canonical = canonicalByLogicalId.get(existing.logicalId);
        if (canonical) {
          if (
            (canonical.path !== existing.canonicalPath ||
              canonical.type !== existing.type) &&
            !matchesBootstrapLegacyPathMove(
              {
                logicalId: canonical.logicalId,
                canonicalPath: canonical.path,
                type: canonical.type,
              },
              existing,
            )
          )
            throw new Error(
              `Active artifact ${existing.logicalId} has an unapproved legacy path or type at ${existing.canonicalPath}.`,
            );
          continue;
        }
        const aliasTarget = manifest.artifacts.find((artifact) =>
          matchesBootstrapLegacyAlias(
            {
              logicalId: artifact.logicalId,
              canonicalPath: artifact.path,
              type: artifact.type,
            },
            existing,
          ),
        );
        if (aliasTarget) continue;
        if (matchesBootstrapLegacyRetirement(existing)) continue;
        throw new Error(
          `Active managed artifact ${existing.logicalId} at ${existing.canonicalPath} is outside the approved bootstrap transition.`,
        );
      }

      for (const existing of activeRegistry) {
        if (!matchesBootstrapLegacyRetirement(existing)) continue;
        await transaction.artifact.update({
          where: { id: existing.id },
          data: { active: false },
        });
        retiredArtifacts.push({
          artifactId: existing.id,
          logicalId: existing.logicalId,
          canonicalPath: existing.canonicalPath,
          type: existing.type,
        });
      }

      const situationIds = new Map<string, string>();
      for (const artifact of manifest.artifacts.filter(
        (candidate) => candidate.type === "SITUATION",
      )) {
        const bytes = bodies.get(artifact.contentHash);
        if (!bytes) throw new Error(`Missing ${artifact.path}.`);
        const frontmatter = matter(new TextDecoder().decode(bytes)).data as {
          slug: string;
          title: string;
        };
        const situation = await transaction.situation.upsert({
          where: { slug: frontmatter.slug },
          create: {
            slug: frontmatter.slug,
            title: frontmatter.title,
            lifecycle: "ACTIVE",
            publicationState: "PUBLISHED",
          },
          update: {},
        });
        situationIds.set(artifact.logicalId, situation.id);
      }

      const artifactIds = new Map<string, string>();
      for (const artifact of manifest.artifacts) {
        const [byLogicalId, byPath] = await Promise.all([
          transaction.artifact.findUnique({
            where: { logicalId: artifact.logicalId },
          }),
          transaction.artifact.findUnique({
            where: { canonicalPath: artifact.path },
          }),
        ]);
        if (byLogicalId && byPath && byLogicalId.id !== byPath.id)
          throw new Error(
            `Artifact identity collision for ${artifact.logicalId} at ${artifact.path}.`,
          );
        if (
          byLogicalId &&
          (byLogicalId.canonicalPath !== artifact.path ||
            byLogicalId.type !== artifact.type) &&
          !matchesBootstrapLegacyPathMove(
            {
              logicalId: artifact.logicalId,
              canonicalPath: artifact.path,
              type: artifact.type,
            },
            byLogicalId,
          )
        )
          throw new Error(
            `Artifact ${artifact.logicalId} has an unapproved legacy path or type.`,
          );
        const approvedAlias =
          !byLogicalId &&
          byPath &&
          matchesBootstrapLegacyAlias(
            {
              logicalId: artifact.logicalId,
              canonicalPath: artifact.path,
              type: artifact.type,
            },
            byPath,
          );
        if (byPath && byPath.logicalId !== artifact.logicalId && !approvedAlias)
          throw new Error(`Artifact path is owned by ${byPath.logicalId}.`);
        const existingArtifact = byLogicalId ?? byPath;
        if (approvedAlias && byPath)
          adoptedAliases.push({
            artifactId: byPath.id,
            legacyLogicalId: byPath.logicalId,
            canonicalLogicalId: artifact.logicalId,
            canonicalPath: artifact.path,
            type: byPath.type,
          });
        if (
          byLogicalId &&
          (byLogicalId.canonicalPath !== artifact.path ||
            byLogicalId.type !== artifact.type) &&
          matchesBootstrapLegacyPathMove(
            {
              logicalId: artifact.logicalId,
              canonicalPath: artifact.path,
              type: artifact.type,
            },
            byLogicalId,
          )
        )
          movedPaths.push({
            artifactId: byLogicalId.id,
            logicalId: byLogicalId.logicalId,
            legacyPath: byLogicalId.canonicalPath,
            canonicalPath: artifact.path,
            type: byLogicalId.type,
          });
        const managedArtifact = existingArtifact
          ? await transaction.artifact.update({
              where: { id: existingArtifact.id },
              data: {
                logicalId: artifact.logicalId,
                canonicalPath: artifact.path,
                type: artifact.type,
                primarySituationId:
                  situationIds.get(artifact.logicalId) ?? null,
                active: true,
              },
            })
          : await transaction.artifact.create({
              data: {
                logicalId: artifact.logicalId,
                canonicalPath: artifact.path,
                type: artifact.type,
                primarySituationId:
                  situationIds.get(artifact.logicalId) ?? null,
                repositorySnapshotId: repositorySnapshot.id,
              },
            });
        artifactIds.set(artifact.logicalId, managedArtifact.id);

        const bytes = bodies.get(artifact.contentHash);
        if (!bytes) throw new Error(`Missing blob ${artifact.contentHash}.`);
        const existingBlob = await transaction.contentBlob.findUnique({
          where: { hash: artifact.contentHash },
        });
        if (!existingBlob)
          await transaction.contentBlob.create({
            data:
              artifact.encoding === "BINARY"
                ? {
                    hash: artifact.contentHash,
                    body: "",
                    encoding: "BINARY",
                    binaryBody: new Uint8Array(bytes),
                    byteLength: bytes.byteLength,
                  }
                : {
                    hash: artifact.contentHash,
                    body: new TextDecoder("utf-8", { fatal: true }).decode(
                      bytes,
                    ),
                    encoding: "UTF8",
                    byteLength: bytes.byteLength,
                  },
          });
      }

      assertManagedRegistry(
        await transaction.artifact.findMany({
          where: { active: true },
          select: { logicalId: true, canonicalPath: true },
        }),
      );

      const snapshot = await transaction.contentSnapshot.create({
        data: {
          manifest: manifestBody,
          manifestHash,
          validationPolicyHash: manifest.validationPolicyHash,
          artifactCount: manifest.artifacts.length,
          totalByteLength: BigInt(
            manifest.artifacts.reduce(
              (total, artifact) => total + artifact.byteLength,
              0,
            ),
          ),
        },
      });
      for (const artifact of manifest.artifacts) {
        const artifactId = artifactIds.get(artifact.logicalId);
        if (!artifactId) throw new Error(`Missing ${artifact.logicalId}.`);
        await transaction.contentSnapshotArtifact.create({
          data: {
            snapshotId: snapshot.id,
            artifactId,
            logicalId: artifact.logicalId,
            canonicalPath: artifact.path,
            artifactType: artifact.type,
            contentHash: artifact.contentHash,
            byteLength: artifact.byteLength,
          },
        });
      }
      for (const edge of manifest.edges) {
        const sourceArtifactId = artifactIds.get(edge.source);
        const targetArtifactId = artifactIds.get(edge.target);
        if (!sourceArtifactId || !targetArtifactId)
          throw new Error(`Missing graph endpoint for ${edge.source}.`);
        await transaction.contentSnapshotEdge.create({
          data: {
            snapshotId: snapshot.id,
            sourceArtifactId,
            targetArtifactId,
            edgeType: edge.type,
            evidence: edge.evidence,
          },
        });
      }
      await transaction.contentSnapshot.update({
        where: { id: snapshot.id },
        data: { validationState: "VALIDATED", verifiedAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "SERVICE",
          action: "content_snapshot.bootstrap",
          targetType: "content_snapshot",
          targetId: snapshot.id,
          correlationId: crypto.randomUUID(),
          outcome: "SUCCEEDED",
          afterMetadata: {
            manifestHash,
            artifactCount: manifest.artifacts.length,
            edgeCount: manifest.edges.length,
            sourceRelease: manifest.source.releaseId,
          },
        },
      });
      if (
        adoptedAliases.length > 0 ||
        movedPaths.length > 0 ||
        retiredArtifacts.length > 0
      )
        await transaction.auditEvent.create({
          data: {
            actorType: "SERVICE",
            action: "artifact_registry.bootstrap_transition",
            targetType: "repository_snapshot",
            targetId: repositorySnapshot.id,
            correlationId: crypto.randomUUID(),
            outcome: "SUCCEEDED",
            beforeMetadata: {
              adoptedAliases: adoptedAliases.map((value) => ({
                artifactId: value.artifactId,
                logicalId: value.legacyLogicalId,
                canonicalPath: value.canonicalPath,
                type: value.type,
              })),
              movedPaths: movedPaths.map((value) => ({
                artifactId: value.artifactId,
                logicalId: value.logicalId,
                canonicalPath: value.legacyPath,
                type: value.type,
              })),
              retiredArtifacts,
            },
            afterMetadata: {
              adoptedAliases: adoptedAliases.map((value) => ({
                artifactId: value.artifactId,
                logicalId: value.canonicalLogicalId,
                canonicalPath: value.canonicalPath,
                type: value.type,
              })),
              movedPaths: movedPaths.map((value) => ({
                artifactId: value.artifactId,
                logicalId: value.logicalId,
                canonicalPath: value.canonicalPath,
                type: value.type,
              })),
              retiredArtifactCount: retiredArtifacts.length,
              activeArtifactCount: manifest.artifacts.length,
              manifestHash,
            },
          },
        });
      return snapshot.id;
    },
    { isolationLevel: "Serializable", timeout: 60_000 },
  );
  await verifyDatabaseSnapshot(client, result);
  return { snapshotId: result, created: true };
}

try {
  const preexistingBlobs = await verifyAllDatabaseBlobs(database);
  const beforeTargets = await database.publicationTarget.findMany({
    select: {
      id: true,
      officialSnapshotId: true,
      candidateSnapshotId: true,
      generation: true,
    },
    orderBy: { id: "asc" },
  });
  const first = await backfill(database);
  const second = await backfill(database);
  if (second.created || second.snapshotId !== first.snapshotId)
    throw new Error("Bootstrap backfill is not idempotent.");
  const afterTargets = await database.publicationTarget.findMany({
    select: {
      id: true,
      officialSnapshotId: true,
      candidateSnapshotId: true,
      generation: true,
    },
    orderBy: { id: "asc" },
  });
  let targetResult: { id: string; created: boolean } | null = null;
  if (productionMode)
    targetResult = await ensureProductionTarget(database, first.snapshotId);
  else if (
    beforeTargets.map(targetIdentity).join("") !==
    afterTargets.map(targetIdentity).join("")
  )
    throw new Error("Bootstrap backfill changed a publication target pointer.");
  await verifyAllDatabaseBlobs(database);
  await verifyManagedRegistry(database);
  process.stdout.write(
    `Database bootstrap ${first.created ? "created" : "reused"} and idempotently verified: snapshot ${first.snapshotId}, manifest ${manifestHash}, ${parsed.routeProbes.length} route probes, ${preexistingBlobs} pre-existing blobs verified, ${targetResult ? `target ${targetResult.created ? "created" : "reused"} at exact official snapshot` : "zero target changes"}.\n`,
  );
} finally {
  await database.$disconnect();
}
