import { describe, expect, it } from "vitest";
import {
  formattedRetryTime,
  reviewRetryStatusText,
} from "../src/components/review-retry-status";

describe("review retry presentation", () => {
  it("presents the stage, safe class, attempt count, and durable schedule", () => {
    expect(
      reviewRetryStatusText({
        stage: "bundle-writer",
        failureClass: "PROVIDER_TRANSIENT",
        attempt: 2,
        maximumAttempts: 3,
        scheduledAt: "2026-07-25T12:34:56.000Z",
      }),
    ).toEqual({
      title: "Retrying bundle-writer",
      detail:
        "provider transient failure; attempt 2 of 3; scheduled 2026-07-25T12:34:56.000Z",
    });
  });

  it("does not expose an unknown raw failure value", () => {
    expect(
      reviewRetryStatusText({
        stage: "critic-nvc",
        failureClass: "provider stderr: sensitive detail",
        attempt: 1,
        maximumAttempts: 3,
        scheduledAt: "2026-07-25T12:34:56.000Z",
      }).detail,
    ).toMatch(/^provider failure;/u);
  });

  it("formats the schedule deterministically for server and client rendering", () => {
    expect(formattedRetryTime("2026-07-25T12:34:56.000Z")).toBe(
      "2026-07-25 12:34:56 UTC",
    );
  });
});
