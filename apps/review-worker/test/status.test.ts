import { describe, expect, it } from "vitest";
import { reviewWorkerIdleStatus } from "../src/status";

describe("review worker health status", () => {
  it("is idle before any review and after successful or cancelled work", () => {
    expect(reviewWorkerIdleStatus(null)).toBe("IDLE");
    expect(
      reviewWorkerIdleStatus({ state: "SUCCEEDED", failureCode: null }),
    ).toBe("IDLE");
    expect(
      reviewWorkerIdleStatus({ state: "CANCELLED", failureCode: null }),
    ).toBe("IDLE");
  });

  it.each([
    ["AUTHENTICATION", "PROVIDER_AUTH_FAILED"],
    ["CAPACITY", "PROVIDER_UNAVAILABLE"],
    ["TRANSIENT", "PROVIDER_UNAVAILABLE"],
    ["INVALID_OUTPUT", "PROVIDER_OUTPUT_INVALID"],
  ])("maps %s failures to the safe status %s", (failureCode, expected) => {
    expect(reviewWorkerIdleStatus({ state: "FAILED", failureCode })).toBe(
      expected,
    );
  });

  it("does not misclassify application failures as provider-health failures", () => {
    expect(
      reviewWorkerIdleStatus({
        state: "FAILED",
        failureCode: "APPLICATION",
      }),
    ).toBe("IDLE");
  });
});
