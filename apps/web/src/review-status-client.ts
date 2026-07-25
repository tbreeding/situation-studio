import {
  isTerminalReviewState,
  type ReviewStatusSnapshot,
} from "@/review-status-contract";

export type ReviewConnectionPhase =
  "idle" | "connecting" | "open" | "reconnecting" | "closed";

export type LiveReviewState = {
  reviewJobId: string | null;
  generation: number;
  connection: ReviewConnectionPhase;
  snapshot: ReviewStatusSnapshot | null;
};

export type LiveReviewAction =
  | {
      type: "sync";
      generation: number;
      snapshot: ReviewStatusSnapshot | null;
    }
  | {
      type: "start";
      reviewJobId: string;
      generation: number;
      snapshot: ReviewStatusSnapshot;
    }
  | {
      type: "open" | "connection-error";
      reviewJobId: string;
      generation: number;
    }
  | {
      type: "snapshot";
      reviewJobId: string;
      generation: number;
      snapshot: ReviewStatusSnapshot;
    }
  | {
      type: "stop";
      reviewJobId: string;
      generation: number;
    };

export function initialLiveReviewState(
  snapshot: ReviewStatusSnapshot | null,
): LiveReviewState {
  return {
    reviewJobId: snapshot?.reviewJobId ?? null,
    generation: 0,
    connection: "idle",
    snapshot,
  };
}

function matchesCurrentConnection(
  state: LiveReviewState,
  action: Exclude<LiveReviewAction, { type: "start" | "sync" }>,
) {
  return (
    state.reviewJobId === action.reviewJobId &&
    state.generation === action.generation
  );
}

export function reduceLiveReviewState(
  state: LiveReviewState,
  action: LiveReviewAction,
): LiveReviewState {
  if (action.type === "sync")
    return {
      reviewJobId: action.snapshot?.reviewJobId ?? null,
      generation: action.generation,
      connection: action.snapshot ? "closed" : "idle",
      snapshot: action.snapshot,
    };
  if (action.type === "start")
    return {
      reviewJobId: action.reviewJobId,
      generation: action.generation,
      connection: "connecting",
      snapshot: action.snapshot,
    };
  if (!matchesCurrentConnection(state, action)) return state;
  if (action.type === "open")
    return isTerminalReviewState(state.snapshot?.state ?? "CANCELLED")
      ? state
      : { ...state, connection: "open" };
  if (action.type === "connection-error")
    return isTerminalReviewState(state.snapshot?.state ?? "CANCELLED")
      ? state
      : { ...state, connection: "reconnecting" };
  if (action.type === "stop") return { ...state, connection: "closed" };
  if (action.type !== "snapshot") return state;
  if (action.snapshot.reviewJobId !== state.reviewJobId) return state;
  if (action.snapshot.snapshotId === state.snapshot?.snapshotId) return state;
  return {
    ...state,
    connection: isTerminalReviewState(action.snapshot.state)
      ? "closed"
      : "open",
    snapshot: action.snapshot,
  };
}

export const SAFE_REVIEW_FAILURE_LABELS = {
  PROVIDER_CAPACITY: "Provider capacity",
  PROVIDER_TRANSIENT: "Temporary provider interruption",
  PROVIDER_AUTH: "Provider authentication",
  OUTPUT_INVALID: "Provider response validation",
  APPLICATION: "Review processing",
  CANCELLED: "Cancelled attempt",
} as const;

export function reviewProgressText(snapshot: ReviewStatusSnapshot) {
  return `${snapshot.completedStages} of ${snapshot.totalStages} stages complete`;
}

export function retryCountdown(scheduledAt: string, nowMilliseconds: number) {
  const remaining = new Date(scheduledAt).getTime() - nowMilliseconds;
  if (!Number.isFinite(remaining) || remaining <= 0) return "Retry due now";
  const seconds = Math.ceil(remaining / 1_000);
  if (seconds < 60)
    return `Retry in ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(seconds / 60);
  return `Retry in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export type ReviewAnnouncementState = {
  message: string;
  lastAnnouncedAt: number;
  snapshotId: string | null;
};

export const REVIEW_ANNOUNCEMENT_THROTTLE_MS = 5_000;

function announcementText(snapshot: ReviewStatusSnapshot) {
  const progress = reviewProgressText(snapshot);
  if (snapshot.state === "SUCCEEDED")
    return `Review complete. ${progress}. Loading the proposal.`;
  if (snapshot.state === "FAILED")
    return `Review stopped after ${progress}. You can retry the review.`;
  if (snapshot.state === "CANCELLED")
    return `Review cancelled after ${progress}. Editing is available.`;
  if (snapshot.retry && snapshot.currentStage)
    return `${progress}. ${snapshot.currentStage.displayName} will retry automatically.`;
  if (snapshot.currentStage)
    return `${progress}. Current stage: ${snapshot.currentStage.displayName}.`;
  return `${progress}. Review queued.`;
}

export function nextReviewAnnouncement(
  state: ReviewAnnouncementState,
  previous: ReviewStatusSnapshot | null,
  snapshot: ReviewStatusSnapshot,
  nowMilliseconds: number,
): ReviewAnnouncementState {
  if (state.snapshotId === snapshot.snapshotId) return state;
  const importantTransition =
    !previous ||
    snapshot.state !== previous.state ||
    Boolean(snapshot.retry) !== Boolean(previous.retry) ||
    isTerminalReviewState(snapshot.state);
  if (
    !importantTransition &&
    nowMilliseconds - state.lastAnnouncedAt < REVIEW_ANNOUNCEMENT_THROTTLE_MS
  )
    return { ...state, snapshotId: snapshot.snapshotId };
  return {
    message: announcementText(snapshot),
    lastAnnouncedAt: nowMilliseconds,
    snapshotId: snapshot.snapshotId,
  };
}

export function terminalRefreshDelay(
  snapshot: ReviewStatusSnapshot,
  reducedMotion: boolean,
) {
  if (!isTerminalReviewState(snapshot.state)) return null;
  if (reducedMotion) return 0;
  return snapshot.state === "SUCCEEDED" ? 700 : 250;
}
