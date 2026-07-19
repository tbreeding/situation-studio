import { describe, expect, test } from "vitest";
import {
  isAwaitingHumanConfirmation,
  publicationDecisionLabel,
  publicationProgressSteps,
  shouldPollPublication,
} from "../src/lib/publication-presentation";

describe("publication presentation", () => {
  test("separates a staged candidate from the official baseline", () => {
    expect(isAwaitingHumanConfirmation("AWAITING_CONFIRMATION", false)).toBe(
      true,
    );
    expect(publicationDecisionLabel("AWAITING_CONFIRMATION", false)).toBe(
      "Awaiting your confirmation",
    );
    expect(shouldPollPublication("AWAITING_CONFIRMATION", false)).toBe(false);
  });

  test("starts automatic progress as soon as confirmation is submitted", () => {
    expect(shouldPollPublication("AWAITING_CONFIRMATION", false, true)).toBe(
      true,
    );
    expect(
      publicationProgressSteps("AWAITING_CONFIRMATION", false, true).map(
        (step) => step.status,
      ),
    ).toEqual(["complete", "current", "pending", "pending"]);
  });

  test("maps trusted publisher states to user-facing progress", () => {
    expect(
      publicationProgressSteps("CUTOVER", true).map((step) => step.status),
    ).toEqual(["complete", "complete", "current", "pending"]);
    expect(
      publicationProgressSteps("LIVE_VERIFIED", true).map(
        (step) => step.status,
      ),
    ).toEqual(["complete", "complete", "complete", "current"]);
    expect(
      publicationProgressSteps("RECONCILED", true).map((step) => step.status),
    ).toEqual(["complete", "complete", "complete", "complete"]);
  });

  test("does not poll terminal or intervention states", () => {
    for (const state of [
      "RECONCILED",
      "FAILED_PREVIEW",
      "AUTO_ROLLED_BACK",
      "RECONCILIATION_REQUIRED",
    ])
      expect(shouldPollPublication(state, true)).toBe(false);
  });
});
