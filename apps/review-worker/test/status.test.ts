import { describe, expect, it } from "vitest";
import { reviewWorkerIdleStatus } from "../src/status";

describe("review worker health status", () => {
  const now = new Date("2026-07-25T12:00:00.000Z");

  it("is idle before any review and after successful or cancelled work", () => {
    expect(reviewWorkerIdleStatus(null)).toBe("IDLE");
    expect(
      reviewWorkerIdleStatus({
        state: "SUCCEEDED",
        failureCode: null,
        finishedAt: now,
      }),
    ).toBe("IDLE");
    expect(
      reviewWorkerIdleStatus({
        state: "CANCELLED",
        failureCode: null,
        finishedAt: now,
      }),
    ).toBe("IDLE");
  });

  it.each([
    ["AUTHENTICATION", "PROVIDER_AUTH_FAILED"],
    ["CAPACITY", "PROVIDER_UNAVAILABLE"],
    ["TRANSIENT", "PROVIDER_UNAVAILABLE"],
    ["INVALID_OUTPUT", "PROVIDER_OUTPUT_INVALID"],
  ])("maps %s failures to the safe status %s", (failureCode, expected) => {
    expect(
      reviewWorkerIdleStatus(
        { state: "FAILED", failureCode, finishedAt: now },
        now,
      ),
    ).toBe(expected);
  });

  it("does not misclassify application failures as provider-health failures", () => {
    expect(
      reviewWorkerIdleStatus(
        {
          state: "FAILED",
          failureCode: "APPLICATION",
          finishedAt: now,
        },
        now,
      ),
    ).toBe("IDLE");
  });

  it("does not let an old terminal provider failure degrade a current worker", () => {
    expect(
      reviewWorkerIdleStatus(
        {
          state: "FAILED",
          failureCode: "TRANSIENT",
          finishedAt: new Date("2026-07-25T11:54:59.999Z"),
        },
        now,
      ),
    ).toBe("IDLE");
  });
});
