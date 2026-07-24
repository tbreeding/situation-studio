export type FinishedReviewSummary = {
  state: string;
  failureCode: string | null;
};

export function reviewWorkerIdleStatus(
  latestReview: FinishedReviewSummary | null,
) {
  if (latestReview?.state !== "FAILED") return "IDLE";

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
