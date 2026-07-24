import { describe, expect, it } from "vitest";
import {
  backupReadiness,
  safeProcessState,
} from "../src/server/health/process-status";

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

describe("backup readiness", () => {
  it("reports an explicit launch deferral without fabricating a receipt", () => {
    expect(
      backupReadiness({
        mode: "deferred",
        verifiedAtAgeSeconds: null,
      }),
    ).toEqual({ state: "deferred", degraded: false });
  });

  it("requires a recent verified backup by default", () => {
    expect(
      backupReadiness({
        mode: undefined,
        verifiedAtAgeSeconds: null,
      }),
    ).toEqual({ state: "not-yet-verified", degraded: true });
    expect(
      backupReadiness({
        mode: "required",
        verifiedAtAgeSeconds: 26 * 60 * 60 + 1,
      }),
    ).toEqual({ state: "stale", degraded: true });
    expect(
      backupReadiness({
        mode: "required",
        verifiedAtAgeSeconds: 60,
      }),
    ).toEqual({ state: "verified", degraded: false });
  });

  it("fails closed for an unknown mode", () => {
    expect(
      backupReadiness({
        mode: "optional",
        verifiedAtAgeSeconds: null,
      }),
    ).toEqual({ state: "not-yet-verified", degraded: true });
  });
});
