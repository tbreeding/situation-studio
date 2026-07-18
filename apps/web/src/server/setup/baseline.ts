import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { DatabaseClient } from "@situation-studio/db";

type BaselineManifest = {
  commit: string;
  parserVersion: string;
  artifacts: {
    logicalId: string;
    type: string;
    path: string;
    contentHash: string;
    byteLength: number;
  }[];
};
type BaselineGraph = {
  nodes: { id: string; type: string; path?: string; label: string }[];
  edges: { source: string; target: string; type: string; evidence: string }[];
};

export async function importLegacyBaseline(
  database: DatabaseClient,
  studioRoot: string,
  leadershipRoot: string,
) {
  const baselineRoot = path.join(studioRoot, "artifacts/baseline");
  const manifestBody = fs.readFileSync(
    path.join(baselineRoot, "manifest.json"),
    "utf8",
  );
  const graphBody = fs.readFileSync(
    path.join(baselineRoot, "graph.json"),
    "utf8",
  );
  const manifest = JSON.parse(manifestBody) as BaselineManifest;
  const graph = JSON.parse(graphBody) as BaselineGraph;
  const manifestHash = createHash("sha256").update(manifestBody).digest("hex");
  const graphHash = createHash("sha256").update(graphBody).digest("hex");
  const existing = await database.repositorySnapshot.findUnique({
    where: { commitSha: manifest.commit },
  });
  if (existing)
    return {
      imported: false,
      snapshotId: existing.id,
      situations: await database.situation.count(),
      artifacts: await database.artifact.count(),
    };

  return database.$transaction(
    async (transaction) => {
      const snapshot = await transaction.repositorySnapshot.create({
        data: {
          commitSha: manifest.commit,
          manifest: JSON.parse(manifestBody),
          manifestHash,
          parserVersion: manifest.parserVersion,
          importKind: "LEGACY_IMPORT",
          validationState: "PASSED",
        },
      });

      const situations = new Map<string, string>();
      for (const item of manifest.artifacts.filter(
        (artifact) => artifact.type === "SITUATION",
      )) {
        const raw = fs.readFileSync(
          path.join(leadershipRoot, item.path),
          "utf8",
        );
        const data = matter(raw).data as { slug: string; title: string };
        const situation = await transaction.situation.create({
          data: {
            slug: data.slug,
            title: data.title,
            lifecycle: "ACTIVE",
            publicationState: "PUBLISHED",
          },
        });
        situations.set(`situation:${data.slug}`, situation.id);
      }

      const artifactIds = new Map<string, string>();
      for (const node of graph.nodes) {
        const manifestArtifact = manifest.artifacts.find(
          (artifact) => artifact.logicalId === node.id,
        );
        const basePath =
          manifestArtifact?.path ??
          node.path ??
          `virtual/${node.type.toLowerCase()}/${node.id.replace(/[^a-z0-9-]+/giu, "-")}`;
        const canonicalPath = manifestArtifact
          ? basePath
          : `${basePath}#${node.id}`;
        const artifact = await transaction.artifact.create({
          data: {
            logicalId: node.id,
            type: node.type as never,
            canonicalPath,
            primarySituationId: situations.get(node.id) ?? null,
            repositorySnapshotId: snapshot.id,
          },
        });
        artifactIds.set(node.id, artifact.id);
        if (manifestArtifact) {
          const body = fs.readFileSync(
            path.join(leadershipRoot, manifestArtifact.path),
            "utf8",
          );
          await transaction.contentBlob.upsert({
            where: { hash: manifestArtifact.contentHash },
            create: {
              hash: manifestArtifact.contentHash,
              body,
              byteLength: Buffer.byteLength(body),
            },
            update: {},
          });
        }
      }

      for (const edge of graph.edges) {
        const sourceId = artifactIds.get(edge.source);
        const targetId = artifactIds.get(edge.target);
        if (sourceId && targetId)
          await transaction.artifactEdge.create({
            data: {
              snapshotId: snapshot.id,
              sourceId,
              targetId,
              edgeType: edge.type as never,
              evidence: edge.evidence,
            },
          });
      }

      for (const item of manifest.artifacts.filter(
        (artifact) => artifact.type === "SITUATION",
      )) {
        const situationId = situations.get(item.logicalId);
        const artifactId = artifactIds.get(item.logicalId);
        if (!situationId || !artifactId)
          throw new Error(`Missing imported identity for ${item.logicalId}`);
        const version = await transaction.situationVersion.create({
          data: {
            situationId,
            sourceKind: "LEGACY_IMPORT",
            snapshotId: snapshot.id,
            manifestHash,
          },
        });
        await transaction.versionArtifact.create({
          data: {
            versionId: version.id,
            artifactId,
            path: item.path,
            type: "SITUATION",
            contentHash: item.contentHash,
            changeKind: "NO_CHANGE",
          },
        });
        const publication = await transaction.publication.create({
          data: {
            situationId,
            versionId: version.id,
            kind: "LEGACY_IMPORT",
            commitSha: manifest.commit,
            manifestHash,
            releaseId: `legacy:${manifest.commit}`,
            healthState: "IMPORTED_BASELINE",
          },
        });
        await transaction.situation.update({
          where: { id: situationId },
          data: { currentPublicationId: publication.id },
        });
      }

      await transaction.auditEvent.create({
        data: {
          actorType: "SERVICE",
          action: "legacy.import",
          targetType: "repository_snapshot",
          targetId: snapshot.id,
          correlationId: crypto.randomUUID(),
          outcome: "SUCCEEDED",
          afterMetadata: {
            commit: manifest.commit,
            manifestHash,
            graphHash,
            situations: situations.size,
            artifacts: artifactIds.size,
          },
        },
      });
      return {
        imported: true,
        snapshotId: snapshot.id,
        situations: situations.size,
        artifacts: artifactIds.size,
      };
    },
    { isolationLevel: "Serializable", timeout: 30_000 },
  );
}
