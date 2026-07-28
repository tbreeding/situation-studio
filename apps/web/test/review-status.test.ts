import { describe, expect, it } from "vitest";
import {
  buildReviewStatusSnapshot,
  reviewStageDisplayName,
  type ReviewStatusRecord,
} from "../src/server/review-status";
import {
  reviewStatusSnapshotSchema,
  REVIEW_STAGE_TOTAL,
} from "../src/review-status-contract";

const reviewJobId = "11111111-1111-4111-8111-111111111111";

function statusRecord(
  overrides: Partial<ReviewStatusRecord> = {},
): ReviewStatusRecord {
  return {
    id: reviewJobId,
    state: "QUEUED",
    retryNotBefore: null,
    failureCode: null,
    proposal: null,
    steps: Array.from({ length: REVIEW_STAGE_TOTAL }, (_, index) => ({
      ordinal: index + 1,
      roleCode: index === 0 ? "surface-mapper" : `stage-${index + 1}`,
      state: index === 0 ? "READY" : "PENDING",
      runs: [],
    })),
    ...overrides,
  };
}

describe("public review-status snapshots", () => {
  it("builds a complete runtime-valid initial snapshot with a display name", () => {
    const snapshot = buildReviewStatusSnapshot(statusRecord());
    expect(reviewStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      schemaVersion: "review-status-v2",
      reviewJobId,
      state: "QUEUED",
      completedStages: 0,
      totalStages: REVIEW_STAGE_TOTAL,
      currentStage: {
        ordinal: 1,
        code: "surface-mapper",
        displayName: "Mapping the review surfaces",
        state: "READY",
        attempt: null,
      },
      retry: null,
      terminal: null,
      proposalReady: false,
    });
    expect(snapshot.stages).toHaveLength(REVIEW_STAGE_TOTAL);
    expect(snapshot.snapshotId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps historical 22-stage review snapshots readable", () => {
    const legacy = statusRecord({
      steps: statusRecord().steps.slice(0, 22),
    });
    const snapshot = buildReviewStatusSnapshot(legacy);
    expect(reviewStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.totalStages).toBe(22);
    expect(snapshot.stages).toHaveLength(22);
  });

  it("projects only bounded safe retry data and never raw provider evidence", () => {
    const record = statusRecord({
      retryNotBefore: new Date("2026-07-25T12:34:56.000Z"),
      failureCode: "raw provider stderr: secret-token",
    });
    record.steps[0] = {
      ...record.steps[0]!,
      runs: [
        {
          attempt: 2,
          failureClass: "PROVIDER_TRANSIENT",
          retryable: true,
          providerOutput: "private prompt and evidence",
          stderr: "secret-token",
          claimToken: "internal-claim",
        } as never,
      ],
    };
    const snapshot = buildReviewStatusSnapshot(record);
    expect(snapshot.retry).toEqual({
      state: "SCHEDULED",
      stageOrdinal: 1,
      failureClass: "PROVIDER_TRANSIENT",
      attempt: 2,
      maximumAttempts: 3,
      scheduledAt: "2026-07-25T12:34:56.000Z",
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(
      /private prompt|evidence|stderr|secret-token|claimToken|internal-claim/iu,
    );
    expect(Object.keys(snapshot).sort()).toEqual([
      "completedStages",
      "currentStage",
      "proposalReady",
      "retry",
      "reviewJobId",
      "schemaVersion",
      "snapshotId",
      "stages",
      "state",
      "terminal",
      "totalStages",
    ]);
  });

  it("uses a deterministic identity that changes only with the safe projection", () => {
    const record = statusRecord();
    const first = buildReviewStatusSnapshot(record);
    const repeated = buildReviewStatusSnapshot(record);
    expect(repeated.snapshotId).toBe(first.snapshotId);

    record.steps[0] = { ...record.steps[0]!, state: "SUCCEEDED" };
    record.steps[1] = { ...record.steps[1]!, state: "READY" };
    const advanced = buildReviewStatusSnapshot(record);
    expect(advanced.snapshotId).not.toBe(first.snapshotId);
    expect(advanced.completedStages).toBe(1);
  });

  it("falls back to a bounded display name for an unknown safe role code", () => {
    expect(reviewStageDisplayName("future-review-stage", 7)).toBe(
      "Review stage 7",
    );
  });
});
