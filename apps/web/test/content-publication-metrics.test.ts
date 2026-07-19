import { describe, expect, test } from "vitest";
import { contentPublicationMetrics } from "../src/lib/content-publication-metrics";

describe("content publication metrics", () => {
  test("reports safe publication, rollback, cache, and durable event metrics", () => {
    const metrics = contentPublicationMetrics({
      now: new Date("2026-07-19T15:30:00.000Z"),
      backend: "database",
      target: {
        code: "leadership-production",
        generation: 7n,
        officialSnapshot: { manifestHash: "a".repeat(64) },
        candidateSnapshot: { manifestHash: "b".repeat(64) },
      },
      latestPublication: {
        state: "RECONCILED",
        terminalOutcome: "PUBLISHED",
        createdAt: new Date("2026-07-19T15:28:00.000Z"),
        updatedAt: new Date("2026-07-19T15:29:00.000Z"),
      },
      latestRollback: {
        state: "AUTO_ROLLED_BACK",
        terminalOutcome: "PREVIOUS_VERSION_RESTORED",
        updatedAt: new Date("2026-07-19T15:29:10.000Z"),
      },
      latestObservation: {
        snapshotHash: "a".repeat(64),
        cacheSource: "LAST_KNOWN_GOOD",
        healthResult: "DEGRADED",
        observedAt: new Date("2026-07-19T15:29:30.000Z"),
      },
      latestEventAt: new Date("2026-07-19T15:29:45.000Z"),
      activePublications: 0,
      validationFailures24Hours: 2,
    });

    expect(metrics.target).toMatchObject({
      generation: "7",
      officialSnapshotHash: "a".repeat(64),
      candidateSnapshotHash: "b".repeat(64),
    });
    expect(metrics.publication).toMatchObject({
      latestLatencyMilliseconds: 60_000,
      validationFailures24Hours: 2,
    });
    expect(metrics.rollback.latestOutcome).toBe("PREVIOUS_VERSION_RESTORED");
    expect(metrics.leadership).toMatchObject({
      cacheSource: "LAST_KNOWN_GOOD",
      cacheObservationAgeSeconds: 30,
    });
    expect(metrics.outbox).toMatchObject({
      deliveryMode: "transactional-direct-replay",
      lagSeconds: 0,
      latestEventAgeSeconds: 15,
    });
    expect(JSON.stringify(metrics)).not.toMatch(
      /password|secret|token|contentBody/iu,
    );
  });
});
