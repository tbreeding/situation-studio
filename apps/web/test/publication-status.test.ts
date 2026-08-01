import { describe, expect, it } from "vitest";
import {
  buildPublicationStatusSnapshot,
  type PublicationStatusRecord,
} from "../src/server/publication-status";
import { publicationStatusSnapshotSchema } from "../src/publication-status-contract";

const publicationJobId = "22222222-2222-4222-8222-222222222222";

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
  it("starts with a clear five-step user-facing workflow", () => {
    const snapshot = buildPublicationStatusSnapshot(statusRecord());
    expect(publicationStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot).toMatchObject({
      schemaVersion: "publication-status-v1",
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
    });
    expect(snapshot.stages[4]?.state).toBe("FAILED");
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|database detail/iu);
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
