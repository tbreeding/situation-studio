export type SafeProcessState =
  | "fresh"
  | "stale"
  | "stopping"
  | "provider-auth-failed"
  | "provider-unavailable"
  | "provider-output-invalid";

const REVIEW_PROVIDER_STATES: Record<string, SafeProcessState> = {
  PROVIDER_AUTH_FAILED: "provider-auth-failed",
  PROVIDER_UNAVAILABLE: "provider-unavailable",
  PROVIDER_OUTPUT_INVALID: "provider-output-invalid",
};

export function safeProcessState(input: {
  id: string;
  heartbeatStatus?: string | undefined;
  ageSeconds: number | null;
}): SafeProcessState {
  if (input.ageSeconds === null || input.ageSeconds > 60) return "stale";
  if (input.heartbeatStatus === "STOPPING") return "stopping";
  if (input.id === "review-worker" && input.heartbeatStatus)
    return REVIEW_PROVIDER_STATES[input.heartbeatStatus] ?? "fresh";
  return "fresh";
}
