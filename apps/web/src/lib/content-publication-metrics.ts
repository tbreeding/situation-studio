export type ContentPublicationMetricInput = {
  now: Date;
  backend: "git" | "database";
  target: {
    code: string;
    generation: bigint;
    officialSnapshot: { manifestHash: string } | null;
    candidateSnapshot: { manifestHash: string } | null;
  } | null;
  latestPublication: {
    state: string;
    terminalOutcome: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  latestRollback: {
    state: string;
    terminalOutcome: string | null;
    updatedAt: Date;
  } | null;
  latestObservation: {
    snapshotHash: string;
    cacheSource: string;
    healthResult: string;
    observedAt: Date;
  } | null;
  latestEventAt: Date | null;
  activePublications: number;
  validationFailures24Hours: number;
};

function ageSeconds(now: Date, then: Date | null) {
  return then
    ? Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1_000))
    : null;
}

export function contentPublicationMetrics(
  input: ContentPublicationMetricInput,
) {
  return {
    status: "ready",
    databaseReachable: true,
    backend: input.backend,
    target: input.target
      ? {
          code: input.target.code,
          generation: input.target.generation.toString(),
          officialSnapshotHash:
            input.target.officialSnapshot?.manifestHash ?? null,
          candidateSnapshotHash:
            input.target.candidateSnapshot?.manifestHash ?? null,
        }
      : null,
    publication: {
      activeCount: input.activePublications,
      latestState: input.latestPublication?.state ?? null,
      latestOutcome: input.latestPublication?.terminalOutcome ?? null,
      latestLatencyMilliseconds: input.latestPublication
        ? input.latestPublication.updatedAt.getTime() -
          input.latestPublication.createdAt.getTime()
        : null,
      validationFailures24Hours: input.validationFailures24Hours,
    },
    rollback: {
      latestState: input.latestRollback?.state ?? null,
      latestOutcome: input.latestRollback?.terminalOutcome ?? null,
      latestUpdatedAt: input.latestRollback?.updatedAt.toISOString() ?? null,
    },
    leadership: input.latestObservation
      ? {
          observedSnapshotHash: input.latestObservation.snapshotHash,
          cacheSource: input.latestObservation.cacheSource,
          healthResult: input.latestObservation.healthResult,
          cacheObservationAgeSeconds: ageSeconds(
            input.now,
            input.latestObservation.observedAt,
          ),
          observedAt: input.latestObservation.observedAt.toISOString(),
        }
      : null,
    outbox: {
      deliveryMode: "transactional-direct-replay",
      lagSeconds: 0,
      latestEventAgeSeconds: ageSeconds(input.now, input.latestEventAt),
      latestEventAt: input.latestEventAt?.toISOString() ?? null,
    },
    measuredAt: input.now.toISOString(),
  } as const;
}
