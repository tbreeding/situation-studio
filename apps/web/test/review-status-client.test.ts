import { describe, expect, it } from "vitest";
import {
  displayedReviewSnapshot,
  initialLiveReviewState,
  nextReviewAnnouncement,
  reduceLiveReviewState,
  retryCountdown,
  terminalRefreshDelay,
  type ReviewAnnouncementState,
} from "../src/review-status-client";
import {
  reviewStatusSnapshotSchema,
  REVIEW_STAGE_TOTAL,
  type ReviewJobState,
  type ReviewStatusSnapshot,
} from "../src/review-status-contract";

const firstJobId = "11111111-1111-4111-8111-111111111111";
const secondJobId = "22222222-2222-4222-8222-222222222222";

function snapshot(input: {
  snapshotCharacter: string;
  reviewJobId?: string;
  state?: ReviewJobState;
  completedStages?: number;
  currentOrdinal?: number | null;
  retry?: boolean;
  proposalReady?: boolean;
}): ReviewStatusSnapshot {
  const state = input.state ?? "RUNNING";
  const completedStages = input.completedStages ?? 0;
  const currentOrdinal =
    input.currentOrdinal === undefined
      ? Math.min(completedStages + 1, REVIEW_STAGE_TOTAL)
      : input.currentOrdinal;
  const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(state);
  const stages = Array.from({ length: REVIEW_STAGE_TOTAL }, (_, index) => {
    const ordinal = index + 1;
    if (ordinal <= completedStages)
      return { ordinal, state: "SUCCEEDED" as const };
    if (ordinal === currentOrdinal)
      return {
        ordinal,
        state:
          state === "FAILED"
            ? ("FAILED" as const)
            : state === "CANCELLED"
              ? ("CANCELLED" as const)
              : input.retry
                ? ("READY" as const)
                : ("RUNNING" as const),
      };
    return {
      ordinal,
      state:
        state === "CANCELLED" ? ("CANCELLED" as const) : ("PENDING" as const),
    };
  });
  return reviewStatusSnapshotSchema.parse({
    schemaVersion: "review-status-v2",
    reviewJobId: input.reviewJobId ?? firstJobId,
    state,
    completedStages,
    totalStages: REVIEW_STAGE_TOTAL,
    stages,
    currentStage:
      currentOrdinal === null
        ? null
        : {
            ordinal: currentOrdinal,
            code: `stage-${currentOrdinal}`,
            displayName: `Human stage ${currentOrdinal}`,
            state: stages[currentOrdinal - 1]!.state,
            attempt: 1,
          },
    retry: input.retry
      ? {
          state: "SCHEDULED",
          stageOrdinal: currentOrdinal,
          failureClass: "PROVIDER_TRANSIENT",
          attempt: 1,
          maximumAttempts: 3,
          scheduledAt: "2026-07-25T12:34:56.000Z",
        }
      : null,
    terminal: terminal
      ? {
          state,
          failureClass: state === "FAILED" ? "PROVIDER_TRANSIENT" : null,
        }
      : null,
    proposalReady: input.proposalReady ?? false,
    snapshotId: input.snapshotCharacter.repeat(64),
  });
}

describe("live review client state", () => {
  it("advances stages without a reload and presents reconnection state", () => {
    const initial = snapshot({ snapshotCharacter: "a" });
    let state = reduceLiveReviewState(initialLiveReviewState(initial), {
      type: "start",
      reviewJobId: firstJobId,
      generation: 1,
      snapshot: initial,
    });
    state = reduceLiveReviewState(state, {
      type: "open",
      reviewJobId: firstJobId,
      generation: 1,
    });
    expect(state.connection).toBe("open");

    const advanced = snapshot({
      snapshotCharacter: "b",
      completedStages: 1,
      currentOrdinal: 2,
    });
    state = reduceLiveReviewState(state, {
      type: "snapshot",
      reviewJobId: firstJobId,
      generation: 1,
      snapshot: advanced,
    });
    expect(state.snapshot).toMatchObject({
      completedStages: 1,
      currentStage: { displayName: "Human stage 2" },
    });

    state = reduceLiveReviewState(state, {
      type: "connection-error",
      reviewJobId: firstJobId,
      generation: 1,
    });
    expect(state.connection).toBe("reconnecting");
  });

  it("rejects stale events from an old review or superseded connection", () => {
    const current = snapshot({ snapshotCharacter: "c" });
    const state = reduceLiveReviewState(initialLiveReviewState(current), {
      type: "start",
      reviewJobId: firstJobId,
      generation: 4,
      snapshot: current,
    });
    const oldConnection = reduceLiveReviewState(state, {
      type: "snapshot",
      reviewJobId: firstJobId,
      generation: 3,
      snapshot: snapshot({
        snapshotCharacter: "d",
        completedStages: 2,
      }),
    });
    expect(oldConnection).toBe(state);
    const oldReview = reduceLiveReviewState(state, {
      type: "snapshot",
      reviewJobId: firstJobId,
      generation: 4,
      snapshot: snapshot({
        snapshotCharacter: "e",
        reviewJobId: secondJobId,
        completedStages: 2,
      }),
    });
    expect(oldReview).toBe(state);
  });

  it("does not let a retained failed snapshot mask a newer successful server snapshot", () => {
    const failed = snapshot({
      snapshotCharacter: "8",
      state: "FAILED",
      completedStages: REVIEW_STAGE_TOTAL - 1,
      currentOrdinal: REVIEW_STAGE_TOTAL,
    });
    const retainedFailure = reduceLiveReviewState(
      initialLiveReviewState(failed),
      {
        type: "sync",
        generation: 1,
        snapshot: failed,
      },
    );
    const succeeded = snapshot({
      snapshotCharacter: "9",
      state: "SUCCEEDED",
      completedStages: REVIEW_STAGE_TOTAL,
      currentOrdinal: null,
      proposalReady: true,
    });

    expect(displayedReviewSnapshot(retainedFailure, succeeded)).toEqual(
      succeeded,
    );
  });

  it("continues to display live progress while its server snapshot is current", () => {
    const server = snapshot({ snapshotCharacter: "a" });
    let state = reduceLiveReviewState(initialLiveReviewState(server), {
      type: "start",
      reviewJobId: firstJobId,
      generation: 1,
      snapshot: server,
    });
    const live = snapshot({
      snapshotCharacter: "b",
      completedStages: 1,
      currentOrdinal: 2,
    });
    state = reduceLiveReviewState(state, {
      type: "snapshot",
      reviewJobId: firstJobId,
      generation: 1,
      snapshot: live,
    });

    expect(displayedReviewSnapshot(state, server)).toEqual(live);
  });

  it.each([
    ["SUCCEEDED", true, "closed"],
    ["FAILED", false, "closed"],
    ["CANCELLED", false, "closed"],
  ] as const)(
    "accepts the %s terminal transition and closes live state",
    (terminalState, proposalReady, connection) => {
      const initial = snapshot({ snapshotCharacter: "f" });
      const started = reduceLiveReviewState(initialLiveReviewState(initial), {
        type: "start",
        reviewJobId: firstJobId,
        generation: 1,
        snapshot: initial,
      });
      const terminal = snapshot({
        snapshotCharacter:
          terminalState === "SUCCEEDED"
            ? "1"
            : terminalState === "FAILED"
              ? "2"
              : "3",
        state: terminalState,
        completedStages: terminalState === "SUCCEEDED" ? REVIEW_STAGE_TOTAL : 1,
        currentOrdinal: terminalState === "SUCCEEDED" ? null : 2,
        proposalReady,
      });
      const ended = reduceLiveReviewState(started, {
        type: "snapshot",
        reviewJobId: firstJobId,
        generation: 1,
        snapshot: terminal,
      });
      expect(ended.connection).toBe(connection);
      expect(ended.snapshot).toEqual(terminal);
    },
  );
});

describe("review timing and accessibility presentation", () => {
  it("presents durable backoff as a live visual countdown", () => {
    expect(
      retryCountdown(
        "2026-07-25T12:34:56.000Z",
        Date.parse("2026-07-25T12:34:50Z"),
      ),
    ).toBe("Retry in 6 seconds");
    expect(
      retryCountdown(
        "2026-07-25T12:34:56.000Z",
        Date.parse("2026-07-25T12:34:56Z"),
      ),
    ).toBe("Retry due now");
  });

  it("throttles ordinary polite announcements but never suppresses terminal state", () => {
    const empty: ReviewAnnouncementState = {
      message: "",
      lastAnnouncedAt: Number.NEGATIVE_INFINITY,
      snapshotId: null,
    };
    const initial = snapshot({ snapshotCharacter: "4" });
    const first = nextReviewAnnouncement(empty, null, initial, 10_000);
    expect(first.message).toContain("Current stage: Human stage 1");

    const advanced = snapshot({
      snapshotCharacter: "5",
      completedStages: 1,
      currentOrdinal: 2,
    });
    const throttled = nextReviewAnnouncement(first, initial, advanced, 11_000);
    expect(throttled.message).toBe(first.message);
    expect(throttled.snapshotId).toBe(advanced.snapshotId);

    const failed = snapshot({
      snapshotCharacter: "6",
      state: "FAILED",
      completedStages: 1,
      currentOrdinal: 2,
    });
    const terminal = nextReviewAnnouncement(
      throttled,
      advanced,
      failed,
      11_500,
    );
    expect(terminal.message).toBe(
      `Review stopped after 1 of ${REVIEW_STAGE_TOTAL} stages complete. You can retry the review.`,
    );
  });

  it("removes the completion delay when reduced motion is requested", () => {
    const completed = snapshot({
      snapshotCharacter: "7",
      state: "SUCCEEDED",
      completedStages: REVIEW_STAGE_TOTAL,
      currentOrdinal: null,
      proposalReady: true,
    });
    expect(terminalRefreshDelay(completed, false)).toBe(700);
    expect(terminalRefreshDelay(completed, true)).toBe(0);
  });
});
