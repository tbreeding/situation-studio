import { describe, expect, it } from "vitest";
import {
  buildReviewStatusSnapshot,
  reviewStageDisplayName,
  type ReviewStatusRecord,
} from "../src/server/review-status";
import {
  LEGACY_REVIEW_STAGE_TOTAL,
  reviewStatusSnapshotSchema,
  REVIEW_STAGE_TOTAL,
  REVIEW_STATUS_SCHEMA_VERSION,
} from "../src/review-status-contract";

const reviewJobId = "11111111-1111-4111-8111-111111111111";

function statusRecord(
  overrides: Partial<ReviewStatusRecord> = {},
): ReviewStatusRecord {
  return {
    id: reviewJobId,
    state: "QUEUED",
    laneOwner: false,
    retryNotBefore: null,
    failureCode: null,
    failureReasonCode: null,
    failureStageOrdinal: null,
    failureStageRole: null,
    proposal: null,
    steps: Array.from({ length: REVIEW_STAGE_TOTAL }, (_, index) => ({
      ordinal: index + 1,
      roleCode: index === 0 ? "context-mapper" : `stage-${index + 1}`,
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
      schemaVersion: REVIEW_STATUS_SCHEMA_VERSION,
      reviewJobId,
      state: "QUEUED",
      completedStages: 0,
      totalStages: REVIEW_STAGE_TOTAL,
      currentStage: {
        ordinal: 1,
        code: "context-mapper",
        displayName: "Mapping the situation context",
        state: "READY",
        attempt: null,
      },
      laneState: "WAITING",
      retry: null,
      terminal: null,
      failure: null,
      proposalReady: false,
    });
    expect(snapshot.stages).toHaveLength(REVIEW_STAGE_TOTAL);
    expect(snapshot.snapshotId).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps historical 22-stage review snapshots readable", () => {
    const legacy = statusRecord({
      steps: Array.from({ length: LEGACY_REVIEW_STAGE_TOTAL }, (_, index) => ({
        ordinal: index + 1,
        roleCode: index === 0 ? "surface-mapper" : `legacy-stage-${index + 1}`,
        state: index === 0 ? "READY" : "PENDING",
        runs: [],
      })),
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
    expect(snapshot.failure).toEqual({
      failureClass: "PROVIDER_TRANSIENT",
      reasonCode: "PROVIDER_TRANSIENT",
      title: "The review provider was interrupted",
      explanation: "The provider timed out or returned a temporary error.",
      stage: {
        ordinal: 1,
        code: "context-mapper",
        displayName: "Mapping the situation context",
      },
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toMatch(
      /private prompt|evidence|stderr|secret-token|claimToken|internal-claim/iu,
    );
    expect(Object.keys(snapshot).sort()).toEqual([
      "completedStages",
      "currentStage",
      "failure",
      "laneState",
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

  it("explains a focused candidate failure without exposing raw output", () => {
    const record = statusRecord({
      state: "FAILED",
      laneOwner: false,
      failureCode: "APPLICATION",
      failureReasonCode: "CANDIDATE_AUDIT_REVISE",
      failureStageOrdinal: 4,
      failureStageRole: "candidate-audit",
    });
    record.steps = record.steps.map((step) =>
      step.ordinal < 4
        ? { ...step, state: "SUCCEEDED" }
        : step.ordinal === 4
          ? {
              ...step,
              state: "FAILED",
              runs: [
                {
                  attempt: 1,
                  failureClass: "OUTPUT_INVALID",
                  retryable: true,
                },
              ],
            }
          : step,
    );
    const snapshot = buildReviewStatusSnapshot(record);
    expect(snapshot).toMatchObject({
      state: "FAILED",
      laneState: "RELEASED",
      failure: {
        failureClass: "OUTPUT_INVALID",
        reasonCode: "CANDIDATE_AUDIT_REVISE",
        title: "The candidate still needs revision",
        stage: {
          ordinal: 4,
          code: "candidate-audit",
          displayName: "Auditing the exact candidate",
        },
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/raw output|stderr|prompt/iu);
  });

  it("falls back to a bounded display name for an unknown safe role code", () => {
    expect(reviewStageDisplayName("future-review-stage", 7)).toBe(
      "Review stage 7",
    );
  });
});
