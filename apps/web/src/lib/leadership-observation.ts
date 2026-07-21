import { z } from "zod";

export const leadershipObservationSchema = z.object({
  snapshotId: z.string().uuid(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  observationKind: z.enum(["CANDIDATE", "OFFICIAL", "RESTORATION"]),
  cacheSource: z.enum(["DATABASE", "LAST_KNOWN_GOOD"]),
  healthResult: z.enum(["HEALTHY", "DEGRADED", "UNHEALTHY"]),
  applicationReleaseIdentity: z.string().min(1).max(200),
  routeProbeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  attestationKeyId: z.string().min(1).max(100),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  observedAt: z.string().datetime(),
});

export type LeadershipObservation = z.infer<typeof leadershipObservationSchema>;

export function leadershipObservationSignedBody(
  publicationId: string,
  value: Omit<LeadershipObservation, "receiptDigest">,
) {
  return JSON.stringify({
    publicationId,
    snapshotId: value.snapshotId,
    snapshotHash: value.snapshotHash,
    observationKind: value.observationKind,
    cacheSource: value.cacheSource,
    healthResult: value.healthResult,
    applicationReleaseIdentity: value.applicationReleaseIdentity,
    routeProbeHash: value.routeProbeHash,
    attestationKeyId: value.attestationKeyId,
    observedAt: value.observedAt,
  });
}
