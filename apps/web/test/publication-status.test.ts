import { describe, expect, it } from "vitest";
import {
  buildPublicationStatusSnapshot,
  type PublicationStatusRecord,
} from "../src/server/publication-status";
import {
  isActivePublicationState,
  isPublicationWorkspaceLocked,
  isTerminalPublicationState,
  publicationStatusSnapshotSchema,
} from "../src/publication-status-contract";

const publicationJobId = "22222222-2222-4222-8222-222222222222";
const observedReleaseId = "33333333-3333-4333-8333-333333333333";

function failureDetail(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "publication-failure-detail-v1",
    phase: "RUNTIME_IDENTITY",
    source: "LEADERSHIP_CONTENT_HEALTH",
    reason: "HTTP_STATUS",
    attempts: 24,
    elapsedMs: 11_750,
    lastHttpStatus: 503,
    lastObservedReleaseId: null,
    lastObservedManifestHash: null,
    ...overrides,
  };
}

function statusRecord(
  overrides: Partial<PublicationStatusRecord> = {},
): PublicationStatusRecord {
  return {
    id: publicationJobId,
    state: "REQUESTED",
    failureCode: null,
    events: [{ sequence: 1, kind: "REQUESTED" }],
    ...overrides,
  };
}

describe("public publication-status snapshots", () => {
  it("keeps recovery terminal for display while locking editorial mutations", () => {
    expect(isActivePublicationState("RECOVERY_REQUIRED")).toBe(false);
    expect(isTerminalPublicationState("RECOVERY_REQUIRED")).toBe(true);
    expect(isPublicationWorkspaceLocked("RECOVERY_REQUIRED")).toBe(true);
    expect(isPublicationWorkspaceLocked("RESTORED")).toBe(false);
  });

  it("starts with a clear five-step user-facing workflow", () => {
    const snapshot = buildPublicationStatusSnapshot(statusRecord());
    expect(publicationStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      schemaVersion: "publication-status-v3",
      publicationJobId,
      state: "REQUESTED",
      completedStages: 0,
      totalStages: 5,
      currentStage: {
        code: "STARTING",
        ordinal: 1,
        displayName: "Starting publication",
      },
      terminal: null,
    });
    expect(snapshot.stages.map((stage) => stage.displayName)).toEqual([
      "Starting publication",
      "Building the release",
      "Validating the release",
      "Activating in Leadership",
      "Verifying live content",
    ]);
    expect(snapshot.stages[0]?.state).toBe("ACTIVE");
  });

  it("advances from durable publisher events rather than an estimated timer", () => {
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "PROMOTING",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
          { sequence: 4, kind: "VALIDATED" },
        ],
      }),
    );
    expect(snapshot.completedStages).toBe(3);
    expect(snapshot.currentStage).toMatchObject({
      code: "ACTIVATING",
      ordinal: 4,
    });
    expect(snapshot.stages.map((stage) => stage.state)).toEqual([
      "COMPLETE",
      "COMPLETE",
      "COMPLETE",
      "ACTIVE",
      "PENDING",
    ]);
  });

  it("explains automatic restoration without exposing internal failure data", () => {
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "RESTORED",
        failureCode: "secret database detail",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
          { sequence: 4, kind: "VALIDATED" },
          { sequence: 5, kind: "POINTER_ADVANCED" },
          { sequence: 6, kind: "RESTORE_STARTED" },
          { sequence: 7, kind: "RESTORED" },
        ],
      }),
    );
    expect(snapshot.terminal).toMatchObject({
      state: "RESTORED",
      tone: "WARNING",
      title: "Previous version restored",
      message:
        "The new release did not pass live verification, so Leadership remains on the previous verified version.",
    });
    expect(snapshot.failure).toBeNull();
    expect(snapshot.stages[4]?.state).toBe("FAILED");
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|database detail/iu);
  });

  it("projects bounded HTTP verification evidence into actionable restored copy", () => {
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "RESTORED",
        failureCode: "RUNTIME_HEALTH_UNAVAILABLE_RESTORED",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
          { sequence: 4, kind: "VALIDATED" },
          { sequence: 5, kind: "POINTER_ADVANCED" },
          {
            sequence: 6,
            kind: "RESTORE_STARTED",
            payload: { failureDetail: failureDetail() },
          },
          { sequence: 7, kind: "RESTORED" },
        ],
      }),
    );
    expect(publicationStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.terminal?.message).toBe(
      "Leadership content health returned HTTP 503 after 24 checks, so the previous verified version was restored. Your saved draft and checkout are unchanged.",
    );
    expect(snapshot.failure).toEqual(failureDetail());
    expect(snapshot.recoveryFailure).toBeNull();
  });

  it("keeps original and recovery verification failures distinct when recovery is required", () => {
    const recoveryFailure = failureDetail({
      reason: "IDENTITY_MISMATCH",
      attempts: 8,
      elapsedMs: 4_250,
      lastHttpStatus: 200,
      lastObservedReleaseId: observedReleaseId,
      lastObservedManifestHash: "b".repeat(64),
    });
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "RECOVERY_REQUIRED",
        failureCode: "AUTOMATIC_RESTORATION_FAILED",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
          { sequence: 4, kind: "VALIDATED" },
          { sequence: 5, kind: "POINTER_ADVANCED" },
          {
            sequence: 6,
            kind: "RESTORE_STARTED",
            payload: { failureDetail: failureDetail() },
          },
          {
            sequence: 7,
            kind: "RECOVERY_REQUIRED",
            payload: {
              failureDetail: failureDetail(),
              recoveryFailureDetail: recoveryFailure,
              rawError: "password=private recovery stderr",
            },
          },
        ],
      }),
    );
    expect(publicationStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.terminal).toMatchObject({
      state: "RECOVERY_REQUIRED",
      tone: "ERROR",
      title: "Publication needs attention",
    });
    expect(snapshot.failure).toEqual(failureDetail());
    expect(snapshot.recoveryFailure).toEqual(recoveryFailure);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /password|private|stderr|rawError/iu,
    );
  });

  it("drops stale recovery-failure evidence after a recovery-required job is restored", () => {
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "RESTORED",
        failureCode: "VERIFICATION_FAILED_RESTORED",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
          { sequence: 4, kind: "VALIDATED" },
          { sequence: 5, kind: "POINTER_ADVANCED" },
          {
            sequence: 6,
            kind: "RECOVERY_REQUIRED",
            payload: {
              failureDetail: failureDetail(),
              recoveryFailureDetail: failureDetail({ reason: "UNAVAILABLE" }),
            },
          },
          { sequence: 7, kind: "RESTORED" },
        ],
      }),
    );
    expect(publicationStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.failure).toEqual(failureDetail());
    expect(snapshot.recoveryFailure).toBeNull();
  });

  it("explains a last-observed identity mismatch without exposing raw errors", () => {
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "RESTORED",
        failureCode: "RUNTIME_IDENTITY_MISMATCH_RESTORED",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
          { sequence: 4, kind: "VALIDATED" },
          { sequence: 5, kind: "POINTER_ADVANCED" },
          {
            sequence: 6,
            kind: "RESTORE_STARTED",
            payload: {
              failureDetail: failureDetail({
                reason: "IDENTITY_MISMATCH",
                lastHttpStatus: 200,
                lastObservedReleaseId: observedReleaseId,
                lastObservedManifestHash: "a".repeat(64),
              }),
              rawError: "password=secret",
            },
          },
          { sequence: 7, kind: "RESTORED" },
        ],
      }),
    );
    expect(snapshot.terminal?.message).toContain(
      "did not report the new release after 24 checks",
    );
    expect(snapshot.failure).toMatchObject({
      reason: "IDENTITY_MISMATCH",
      lastHttpStatus: 200,
      lastObservedReleaseId: observedReleaseId,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/password|secret|rawError/iu);
  });

  it("discards malformed or expanded failure-detail payloads", () => {
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "RESTORED",
        failureCode: "VERIFICATION_FAILED_RESTORED",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
          { sequence: 4, kind: "VALIDATED" },
          { sequence: 5, kind: "POINTER_ADVANCED" },
          {
            sequence: 6,
            kind: "RESTORE_STARTED",
            payload: {
              failureDetail: failureDetail({
                rawError: "private diagnostic internals",
              }),
            },
          },
          { sequence: 7, kind: "RESTORED" },
        ],
      }),
    );
    expect(snapshot.failure).toBeNull();
    expect(snapshot.terminal?.message).toBe(
      "The new release did not pass live verification, so Leadership remains on the previous verified version.",
    );
    expect(JSON.stringify(snapshot)).not.toMatch(
      /private|internals|rawError/iu,
    );
  });

  it("explains practice-embed mismatches without exposing validator details", () => {
    const snapshot = buildPublicationStatusSnapshot(
      statusRecord({
        state: "FAILED",
        failureCode: "PRACTICE_EMBED_MISMATCH",
        events: [
          { sequence: 1, kind: "REQUESTED" },
          { sequence: 2, kind: "POINTER_OBSERVED" },
          { sequence: 3, kind: "SNAPSHOT_BUILT" },
        ],
      }),
    );
    expect(snapshot.terminal).toEqual({
      state: "FAILED",
      tone: "ERROR",
      title: "Practice embed does not match",
      message:
        "Production was not changed. In Two-minute practice, make the PracticeEmbed practice ID and variant match the situation metadata before trying again.",
    });
    expect(snapshot.stages.map((stage) => stage.state)).toEqual([
      "COMPLETE",
      "COMPLETE",
      "FAILED",
      "PENDING",
      "PENDING",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("PRACTICE_EMBED_MISMATCH");
  });

  it("reports verified completion and produces a deterministic identity", () => {
    const record = statusRecord({
      state: "SUCCEEDED",
      events: [
        { sequence: 1, kind: "REQUESTED" },
        { sequence: 2, kind: "POINTER_OBSERVED" },
        { sequence: 3, kind: "SNAPSHOT_BUILT" },
        { sequence: 4, kind: "VALIDATED" },
        { sequence: 5, kind: "POINTER_ADVANCED" },
        { sequence: 6, kind: "VERIFIED" },
        { sequence: 7, kind: "SUCCEEDED" },
      ],
    });
    const first = buildPublicationStatusSnapshot(record);
    const repeated = buildPublicationStatusSnapshot(record);
    expect(first.completedStages).toBe(5);
    expect(first.currentStage).toBeNull();
    expect(first.terminal).toMatchObject({
      state: "SUCCEEDED",
      tone: "SUCCESS",
      title: "Published",
    });
    expect(repeated.snapshotId).toBe(first.snapshotId);
  });
});
