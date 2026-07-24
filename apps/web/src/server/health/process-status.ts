export type SafeProcessState =
  | "fresh"
  | "stale"
  | "stopping"
  | "provider-auth-failed"
  | "provider-unavailable"
  | "provider-output-invalid";

export type BackupReadinessState =
  "verified" | "stale" | "not-yet-verified" | "deferred";

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

export function backupReadiness(input: {
  mode: string | undefined;
  verifiedAtAgeSeconds: number | null;
}): { state: BackupReadinessState; degraded: boolean } {
  if (input.mode === "deferred") return { state: "deferred", degraded: false };
  if (input.mode && input.mode !== "required")
    return { state: "not-yet-verified", degraded: true };
  if (input.verifiedAtAgeSeconds === null)
    return { state: "not-yet-verified", degraded: true };
  if (input.verifiedAtAgeSeconds > 26 * 60 * 60)
    return { state: "stale", degraded: true };
  return { state: "verified", degraded: false };
}
