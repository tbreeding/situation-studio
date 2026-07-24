import {
  importLeadershipRelease,
  readOfficialLeadershipRelease,
} from "@situation-studio/leadership-bridge";
import { database } from "@/server/database";
import { environment } from "@/server/environment";

let active: Promise<void> | undefined;
let nextObservationAt = 0;

export function reconcileLeadershipRelease(options?: { force?: boolean }) {
  const databaseUrl = environment().LEADERSHIP_STUDIO_READER_DATABASE_URL;
  if (!databaseUrl) return Promise.resolve();
  if (!options?.force && Date.now() < nextObservationAt)
    return active ?? Promise.resolve();
  if (active) return active;
  active = (async () => {
    const snapshot = await readOfficialLeadershipRelease(databaseUrl);
    const cursor = await database().leadershipSyncCursor.findUnique({
      where: { id: "official" },
    });
    if (
      cursor?.lastReleaseId !== snapshot.identity.releaseId ||
      cursor.lastManifestHash !== snapshot.identity.manifestHash
    )
      await importLeadershipRelease(database(), snapshot, "EXTERNAL_IMPORT");
    else
      await database().leadershipSyncCursor.update({
        where: { id: "official" },
        data: { lastSuccessfulAt: new Date(), lastErrorCode: null },
      });
    nextObservationAt = Date.now() + 30_000;
  })()
    .catch(async () => {
      nextObservationAt = Date.now() + 10_000;
      await database()
        .leadershipSyncCursor.updateMany({
          where: { id: "official" },
          data: { lastErrorCode: "LEADERSHIP_OBSERVATION_FAILED" },
        })
        .catch(() => undefined);
      throw new Error("Leadership observation failed.");
    })
    .finally(() => {
      active = undefined;
    });
  return active;
}
