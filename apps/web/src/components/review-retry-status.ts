export type ReviewRetryStatus = {
  stage: string;
  failureClass: string;
  attempt: number;
  maximumAttempts: number;
  scheduledAt: string;
};

export const SAFE_REVIEW_FAILURE_LABELS: Record<string, string> = {
  PROVIDER_CAPACITY: "provider capacity",
  PROVIDER_TRANSIENT: "provider transient failure",
  PROVIDER_AUTH: "provider authentication",
  OUTPUT_INVALID: "invalid provider output",
  APPLICATION: "application failure",
  CANCELLED: "cancelled attempt",
};

export function reviewRetryStatusText(retry: ReviewRetryStatus) {
  const failure =
    SAFE_REVIEW_FAILURE_LABELS[retry.failureClass] ?? "provider failure";
  return {
    title: `Retrying ${retry.stage}`,
    detail: `${failure}; attempt ${retry.attempt} of ${retry.maximumAttempts}; scheduled ${retry.scheduledAt}`,
  };
}

export function formattedRetryTime(value: string) {
  return value.replace("T", " ").replace(/\.\d{3}Z$/u, " UTC");
}
