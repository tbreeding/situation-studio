export type FinishedReviewSummary = {
  state: string;
  failureCode: string | null;
  finishedAt: Date | null;
};

export const PROVIDER_FAILURE_HEALTH_WINDOW_MS = 5 * 60_000;

export function reviewWorkerIdleStatus(
  latestReview: FinishedReviewSummary | null,
  now = new Date(),
  providerFailureHealthWindowMs = PROVIDER_FAILURE_HEALTH_WINDOW_MS,
) {
  if (latestReview?.state !== "FAILED") return "IDLE";
  if (
    !latestReview.finishedAt ||
    now.getTime() - latestReview.finishedAt.getTime() >
      providerFailureHealthWindowMs
  )
    return "IDLE";

  switch (latestReview.failureCode) {
    case "AUTHENTICATION":
      return "PROVIDER_AUTH_FAILED";
    case "CAPACITY":
    case "TRANSIENT":
      return "PROVIDER_UNAVAILABLE";
    case "INVALID_OUTPUT":
      return "PROVIDER_OUTPUT_INVALID";
    default:
      return "IDLE";
  }
}
