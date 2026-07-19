import { NextResponse } from "next/server";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { contentPublicationMetrics } from "@/lib/content-publication-metrics";

const activeStates = [
  "REQUESTED",
  "SNAPSHOT_MATERIALIZED",
  "SNAPSHOT_VALIDATED",
  "CANDIDATE_AVAILABLE",
  "CANDIDATE_VERIFIED",
  "AWAITING_CONFIRMATION",
  "OFFICIAL_POINTER_COMMITTED",
  "RESTORING_PREVIOUS",
] as const;

export async function GET() {
  const session = await currentSession();
  if (!session?.permissions.has("system.admin"))
    return NextResponse.json({ error: "not found" }, { status: 404 });

  try {
    const client = database();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    const [
      target,
      latestPublication,
      latestRollback,
      latestObservation,
      latestEvent,
      activePublications,
      validationFailures24Hours,
    ] = await Promise.all([
      client.publicationTarget.findUnique({
        where: { code: "leadership-production" },
        select: {
          code: true,
          generation: true,
          officialSnapshot: { select: { manifestHash: true } },
          candidateSnapshot: { select: { manifestHash: true } },
        },
      }),
      client.databasePublication.findFirst({
        orderBy: { updatedAt: "desc" },
        select: {
          state: true,
          terminalOutcome: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      client.databasePublication.findFirst({
        where: { rollbackRequestId: { not: null } },
        orderBy: { updatedAt: "desc" },
        select: { state: true, terminalOutcome: true, updatedAt: true },
      }),
      client.leadershipObservationReceipt.findFirst({
        where: { target: { code: "leadership-production" } },
        orderBy: { observedAt: "desc" },
        select: {
          snapshotHash: true,
          cacheSource: true,
          healthResult: true,
          observedAt: true,
        },
      }),
      client.publicationEvent.findFirst({
        where: { target: { code: "leadership-production" } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      client.databasePublication.count({
        where: { state: { in: [...activeStates] } },
      }),
      client.validationRun.count({
        where: { state: "FAILED", finishedAt: { gte: since } },
      }),
    ]);

    return NextResponse.json(
      contentPublicationMetrics({
        now: new Date(),
        backend: environment().PUBLICATION_BACKEND,
        target,
        latestPublication,
        latestRollback,
        latestObservation,
        latestEventAt: latestEvent?.createdAt ?? null,
        activePublications,
        validationFailures24Hours,
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "not-ready", databaseReachable: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
