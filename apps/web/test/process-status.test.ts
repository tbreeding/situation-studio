import { describe, expect, it } from "vitest";
import { safeProcessState } from "../src/server/health/process-status";

describe("safe process health status", () => {
  it("reports missing or old heartbeats as stale", () => {
    expect(safeProcessState({ id: "review-worker", ageSeconds: null })).toBe(
      "stale",
    );
    expect(safeProcessState({ id: "review-worker", ageSeconds: 61 })).toBe(
      "stale",
    );
  });

  it.each([
    ["PROVIDER_AUTH_FAILED", "provider-auth-failed"],
    ["PROVIDER_UNAVAILABLE", "provider-unavailable"],
    ["PROVIDER_OUTPUT_INVALID", "provider-output-invalid"],
  ])(
    "reports %s without exposing provider details",
    (heartbeatStatus, state) => {
      expect(
        safeProcessState({
          id: "review-worker",
          heartbeatStatus,
          ageSeconds: 1,
        }),
      ).toBe(state);
    },
  );

  it("does not apply review-provider states to another process", () => {
    expect(
      safeProcessState({
        id: "publisher",
        heartbeatStatus: "PROVIDER_AUTH_FAILED",
        ageSeconds: 1,
      }),
    ).toBe("fresh");
  });
});
