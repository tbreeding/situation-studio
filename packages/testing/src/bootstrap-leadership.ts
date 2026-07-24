import { createDatabaseClient } from "@situation-studio/db";
import {
  importLeadershipRelease,
  proveLeadershipConnectionReadOnly,
  readLeadershipReleaseHistory,
  readOfficialLeadershipRelease,
} from "@situation-studio/leadership-bridge";

const studioUrl = process.env.STUDIO_DATABASE_URL;
const leadershipUrl = process.env.LEADERSHIP_READONLY_DATABASE_URL;

if (!studioUrl) throw new Error("STUDIO_DATABASE_URL is required.");
if (!leadershipUrl)
  throw new Error("LEADERSHIP_READONLY_DATABASE_URL is required.");
if (studioUrl === leadershipUrl)
  throw new Error("Studio and Leadership database URLs must be different.");

const studio = createDatabaseClient(studioUrl, 2);
try {
  const proof = await proveLeadershipConnectionReadOnly(leadershipUrl);
  const snapshot = await readOfficialLeadershipRelease(leadershipUrl);
  const history = await readLeadershipReleaseHistory(leadershipUrl);
  if (proof.release_id !== snapshot.identity.releaseId)
    throw new Error("Leadership pointer changed during bootstrap preparation.");
  let importedDistinctVersions = 0;
  for (const historical of history) {
    const result = await importLeadershipRelease(
      studio,
      historical,
      "BOOTSTRAP_IMPORT",
    );
    importedDistinctVersions += result.imported;
  }
  process.stdout.write(
    `${JSON.stringify({
      releaseId: snapshot.identity.releaseId,
      manifestHash: snapshot.identity.manifestHash,
      pointerGeneration: snapshot.identity.generation,
      artifacts: snapshot.identity.artifactCount,
      edges: snapshot.identity.edgeCount,
      situations: snapshot.situations.length,
      recoverableReleases: history.length,
      importedDistinctVersions,
      leadershipWriteRejected: proof.writeRejected,
    })}\n`,
  );
} finally {
  await studio.$disconnect();
}
