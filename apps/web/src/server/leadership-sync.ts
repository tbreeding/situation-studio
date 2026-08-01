import {
  captureLeadershipReleaseReconciliationGuard,
  readOfficialLeadershipRelease,
  recordLeadershipReleaseObservationFailure,
  reconcileOfficialLeadershipRelease,
  type LeadershipReleaseReconciliationGuard,
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
  let observationGuard: LeadershipReleaseReconciliationGuard | undefined;
  active = (async () => {
    const studio = database();
    const capture = await captureLeadershipReleaseReconciliationGuard(studio);
    observationGuard = capture.guard;
    if (capture.state === "BLOCKED") {
      nextObservationAt = Date.now() + 5_000;
      return;
    }
    const snapshot = await readOfficialLeadershipRelease(databaseUrl);
    const result = await reconcileOfficialLeadershipRelease(
      studio,
      snapshot,
      observationGuard,
    );
    nextObservationAt =
      Date.now() +
      (result.state === "BLOCKED" || result.state === "STALE_GUARD"
        ? 5_000
        : 30_000);
  })()
    .catch(async () => {
      nextObservationAt = Date.now() + 10_000;
      if (observationGuard)
        await recordLeadershipReleaseObservationFailure(
          database(),
          observationGuard,
        ).catch(() => undefined);
      throw new Error("Leadership observation failed.");
    })
    .finally(() => {
      active = undefined;
    });
  return active;
}
