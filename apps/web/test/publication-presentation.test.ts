import { describe, expect, test } from "vitest";
import {
  isAwaitingHumanConfirmation,
  publicationDecisionLabel,
  publicationProgressSteps,
  shouldPollPublication,
} from "../src/lib/publication-presentation";

const stagingStates = [
  "REQUESTED",
  "WORKTREE_READY",
  "APPLIED",
  "VALIDATED",
  "COMMITTED",
  "PUSHED",
  "PREVIEW_BUILT",
  "PREVIEW_VERIFIED",
] as const;

const terminalCases = [
  ["RECONCILED", "Published and reconciled"],
  ["FAILED_PREVIEW", "Candidate staging failed safely"],
  ["AUTO_ROLLED_BACK", "Previous release restored"],
  ["RECONCILIATION_REQUIRED", "Reconciliation required"],
] as const;

const expectedSteps = [
  [
    "confirmation",
    "Confirmation recorded",
    "Your explicit approval is attached to this exact candidate.",
  ],
  [
    "git",
    "Protected Git main advanced",
    "The staged commit becomes the official repository baseline.",
  ],
  [
    "leadership",
    "Leadership release verified",
    "The same staged release is checked again on Leadership.",
  ],
  [
    "studio",
    "Studio reconciled and custody released",
    "The new baseline is recorded and publisher custody ends.",
  ],
] as const;

describe("publication presentation", () => {
  test.each(stagingStates)("polls while the publisher is in %s", (state) => {
    expect(shouldPollPublication(state, false)).toBe(true);
    expect(publicationDecisionLabel(state, false)).toBe(
      "Preparing the staged candidate",
    );
    expect(isAwaitingHumanConfirmation(state, false)).toBe(false);
  });

  test("separates a staged candidate from the official baseline", () => {
    expect(isAwaitingHumanConfirmation("AWAITING_CONFIRMATION", false)).toBe(
      true,
    );
    expect(publicationDecisionLabel("AWAITING_CONFIRMATION", false)).toBe(
      "Awaiting your confirmation",
    );
    expect(shouldPollPublication("AWAITING_CONFIRMATION", false)).toBe(false);
  });

  test.each([
    [true, false],
    [false, true],
    [true, true],
  ] as const)(
    "polls after confirmation (recorded=%s, locally submitted=%s)",
    (finalConfirmed, confirmationSubmitted) => {
      expect(
        shouldPollPublication(
          "AWAITING_CONFIRMATION",
          finalConfirmed,
          confirmationSubmitted,
        ),
      ).toBe(true);
      expect(
        isAwaitingHumanConfirmation("AWAITING_CONFIRMATION", finalConfirmed),
      ).toBe(!finalConfirmed);
    },
  );

  test("starts automatic progress as soon as confirmation is submitted", () => {
    expect(
      publicationProgressSteps("AWAITING_CONFIRMATION", false, true).map(
        (step) => step.status,
      ),
    ).toEqual(["complete", "current", "pending", "pending"]);
  });

  test.each([
    [
      "AWAITING_CONFIRMATION",
      false,
      ["current", "pending", "pending", "pending"],
    ],
    [
      "AWAITING_CONFIRMATION",
      true,
      ["complete", "current", "pending", "pending"],
    ],
    ["CUTOVER", true, ["complete", "complete", "current", "pending"]],
    ["LIVE_VERIFIED", true, ["complete", "complete", "complete", "current"]],
    ["RECONCILED", true, ["complete", "complete", "complete", "complete"]],
  ] as const)(
    "maps %s (confirmed=%s) to exact progress",
    (state, finalConfirmed, expected) => {
      expect(
        publicationProgressSteps(state, finalConfirmed).map(
          (step) => step.status,
        ),
      ).toEqual(expected);
    },
  );

  test.each(["CUTOVER", "LIVE_VERIFIED"])(
    "shows final publication in progress for %s even if confirmation is stale",
    (state) => {
      expect(publicationDecisionLabel(state, false)).toBe(
        "Final publication in progress",
      );
    },
  );

  test.each(terminalCases)(
    "%s is terminal and has an unambiguous label",
    (state, label) => {
      expect(shouldPollPublication(state, true)).toBe(false);
      expect(shouldPollPublication(state, false, true)).toBe(false);
      expect(publicationDecisionLabel(state, true)).toBe(label);
    },
  );

  test.each(expectedSteps)(
    "keeps the %s progress copy stable",
    (key, label, description) => {
      const step = publicationProgressSteps("RECONCILED", true).find(
        (candidate) => candidate.key === key,
      );
      expect(step).toMatchObject({ key, label, description });
    },
  );

  test.each([
    ["REQUESTED", false],
    ["PREVIEW_VERIFIED", false],
    ["AWAITING_CONFIRMATION", false],
    ["AWAITING_CONFIRMATION", true],
    ["CUTOVER", true],
    ["LIVE_VERIFIED", true],
  ] as const)(
    "has exactly one current step for active state %s",
    (state, confirmed) => {
      const steps = publicationProgressSteps(state, confirmed);
      expect(steps.filter((step) => step.status === "current")).toHaveLength(1);
      expect(steps).toHaveLength(4);
      expect(new Set(steps.map((step) => step.key)).size).toBe(4);
    },
  );

  test("has no current or pending work after reconciliation", () => {
    const steps = publicationProgressSteps("RECONCILED", true);
    expect(steps.every((step) => step.status === "complete")).toBe(true);
  });

  test.each(["", "UNKNOWN", "CORRUPT_STATE"])(
    "fails a foreign state %j into a non-polling preparation presentation",
    (state) => {
      expect(shouldPollPublication(state, false)).toBe(false);
      expect(isAwaitingHumanConfirmation(state, false)).toBe(false);
      expect(publicationDecisionLabel(state, false)).toBe(
        "Preparing the staged candidate",
      );
    },
  );
});
