import { NextResponse } from "next/server";
import { LeadershipCapabilityError } from "@situation-studio/leadership-bridge";
import { database } from "@/server/database";
import {
  backupReadiness,
  safeProcessState,
} from "@/server/health/process-status";
import { publicationBackupStatus } from "@/server/health/publication-backup-policy";
import { requireCompatibleLeadershipRuntime } from "@/server/leadership-compatibility";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await database().$queryRaw`SELECT 1`;
  } catch {
    return NextResponse.json(
      { status: "not-ready", database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let runtimeCapabilities: Awaited<
    ReturnType<typeof requireCompatibleLeadershipRuntime>
  >;
  try {
    runtimeCapabilities = await requireCompatibleLeadershipRuntime();
  } catch (error) {
    const capabilityError =
      error instanceof LeadershipCapabilityError ? error : null;
    return NextResponse.json(
      {
        status: "not-ready",
        database: "reachable",
        leadershipRuntime: {
          state:
            !capabilityError || capabilityError.retryable
              ? "unavailable"
              : "incompatible",
          code: capabilityError?.code ?? "RUNTIME_CAPABILITY_UNAVAILABLE",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const [cursor, heartbeats, backup, restoreDrillReceipt, recoveryRequired] =
      await Promise.all([
        database().leadershipSyncCursor.findUnique({
          where: { id: "official" },
        }),
        database().processHeartbeat.findMany({
          orderBy: { id: "asc" },
        }),
        database().backupReceipt.findFirst({
          where: {
            state: "VERIFIED",
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            destinationId: true,
            encrypted: true,
            objectKey: true,
            checksum: true,
            byteLength: true,
            verifiedAt: true,
          },
        }),
        database().backupReceipt.findFirst({
          where: {
            state: "VERIFIED",
            OR: [
              { restoreDrillAt: { not: null } },
              { restoreDrillResult: { not: null } },
            ],
          },
          orderBy: [
            { restoreDrillAt: { sort: "desc", nulls: "first" } },
            { createdAt: "desc" },
            { id: "desc" },
          ],
          select: {
            destinationId: true,
            encrypted: true,
            objectKey: true,
            checksum: true,
            byteLength: true,
            verifiedAt: true,
            createdAt: true,
            restoreDrillAt: true,
            restoreDrillResult: true,
          },
        }),
        database().publicationJob.count({
          where: { state: "RECOVERY_REQUIRED" },
        }),
      ]);
    const now = Date.now();
    const ageSeconds = (value: Date | null | undefined) =>
      value ? Math.max(0, Math.floor((now - value.getTime()) / 1_000)) : null;
    const cursorAge = ageSeconds(cursor?.lastSuccessfulAt);
    const requiredProcesses = ["review-worker", "publisher"];
    const processStatus = requiredProcesses.map((id) => {
      const heartbeat = heartbeats.find((item) => item.id === id);
      const age = ageSeconds(heartbeat?.lastSeenAt);
      return {
        id,
        state: safeProcessState({
          id,
          heartbeatStatus: heartbeat?.status,
          ageSeconds: age,
        }),
        ageSeconds: age,
      };
    });
    const backupAge = ageSeconds(backup?.verifiedAt);
    const restoreDrillAge = ageSeconds(restoreDrillReceipt?.restoreDrillAt);
    const backupPolicy = publicationBackupStatus({
      latestVerifiedBackup: backup,
      latestRestoreDrill: restoreDrillReceipt,
      now: new Date(now),
    });
    const backupStatus = backupReadiness({
      mode: process.env.SITUATION_STUDIO_BACKUP_READINESS_MODE,
      publicationStatus: backupPolicy,
    });
    const degraded =
      recoveryRequired > 0 ||
      cursorAge === null ||
      cursorAge > 120 ||
      processStatus.some((process) => process.state !== "fresh") ||
      backupStatus.degraded;
    return NextResponse.json(
      {
        status: degraded ? "degraded" : "ready",
        database: "reachable",
        leadershipObservation: {
          releaseId: cursor?.lastReleaseId ?? null,
          manifestHash: cursor?.lastManifestHash ?? null,
          generation: cursor?.lastPointerGeneration?.toString() ?? null,
          ageSeconds: cursorAge,
          state:
            cursorAge !== null && cursorAge <= 120 && !cursor?.lastErrorCode
              ? "fresh"
              : "stale",
        },
        leadershipRuntime: {
          commit: runtimeCapabilities.deployment.commit,
          capabilityDigest: runtimeCapabilities.capabilityDigest,
          typedParity: runtimeCapabilities.database.predicate,
          state: "compatible",
        },
        processes: processStatus,
        publisher: { recoveryRequired },
        backup: {
          state: backupStatus.state,
          publicationReady: backupPolicy.ready,
          evidenceState: backupPolicy.state,
          ageSeconds: backupAge,
          encrypted: backup?.encrypted ?? null,
          restoreDrill:
            restoreDrillReceipt?.restoreDrillResult === "PASSED"
              ? "passed"
              : "not-yet-passed",
          restoreDrillAgeSeconds: restoreDrillAge,
        },
      },
      {
        status: degraded ? 503 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return NextResponse.json(
      { status: "not-ready", database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
