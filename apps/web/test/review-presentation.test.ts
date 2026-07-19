import { describe, expect, test } from "vitest";
import { workflowRoles } from "@situation-studio/domain";
import {
  humanizeReviewRole,
  reviewCompletedCount,
  reviewCurrentStage,
  reviewLastChangedAt,
  reviewPresentation,
  reviewProgressSteps,
  terminalReviewStates,
  type ReviewJobSnapshot,
  type ReviewJobState,
} from "../src/lib/review-presentation";

const now = new Date("2026-07-19T10:00:00.000Z");

function job(
  state: ReviewJobState,
  overrides: Partial<ReviewJobSnapshot> = {},
): ReviewJobSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    state,
    stage: "Waiting for complete-review capacity",
    createdAt: "2026-07-19T09:59:30.000Z",
    startedAt: null,
    finishedAt: null,
    observedAt: now.toISOString(),
    steps: [],
    ...overrides,
  };
}

describe("complete-review presentation", () => {
  test.each([
    ["MAP_LEARNING_SURFACES", "Mapping connected learning surfaces"],
    ["BLIND_CRITIC_1", "Independent critique 1 of 7"],
    ["BLIND_CRITIC_7", "Independent critique 7 of 7"],
    ["REBUTTAL_1", "Response to critique 1 of 7"],
    ["REBUTTAL_7", "Response to critique 7 of 7"],
    ["ADJUDICATOR", "Reconciling reviewer disagreements"],
    ["TEACHING_DESIGNER", "Checking the teaching design"],
    ["BUNDLE_WRITER", "Writing the candidate bundle"],
    ["SEMANTIC_AUDITOR", "Auditing meaning and consistency"],
    ["TEACHING_ALIGNMENT_AUDITOR", "Checking teaching alignment"],
    ["REPOSITORY_INTEGRITY_AUDITOR", "Checking repository integrity"],
    ["REPOSITORY_VALIDATION", "Running final repository validation"],
    ["FUTURE_ROLE", "Future role"],
  ])("translates %s into plain language", (role, label) => {
    expect(humanizeReviewRole(role)).toBe(label);
  });

  test.each([
    ["CANCELLED", true],
    ["SUCCEEDED", true],
    ["INCOMPLETE", true],
    ["FAILED", true],
    ["QUEUED", false],
    ["RUNNING", false],
    ["WAITING_CAPACITY", false],
    ["RETRY_SCHEDULED", false],
    ["CANCELLING", false],
  ] as const)("classifies %s terminal=%s", (state, terminal) => {
    expect(terminalReviewStates.has(state)).toBe(terminal);
  });

  test("counts only unique, declared, succeeded workflow roles", () => {
    const snapshot = job("RUNNING", {
      steps: [
        {
          role: "MAP_LEARNING_SURFACES",
          state: "SUCCEEDED",
          updatedAt: "2026-07-19T09:59:40.000Z",
        },
        {
          role: "MAP_LEARNING_SURFACES",
          state: "SUCCEEDED",
          updatedAt: "2026-07-19T09:59:41.000Z",
        },
        {
          role: "BLIND_CRITIC_1",
          state: "RUNNING",
          updatedAt: "2026-07-19T09:59:42.000Z",
        },
        {
          role: "UNKNOWN",
          state: "SUCCEEDED",
          updatedAt: "2026-07-19T09:59:43.000Z",
        },
      ],
    });
    expect(reviewCompletedCount(snapshot)).toBe(1);
  });

  test("prefers the exact running step over the stored stage copy", () => {
    expect(
      reviewCurrentStage(
        job("RUNNING", {
          stage: "stale stage",
          steps: [
            {
              role: "BUNDLE_WRITER",
              state: "RUNNING",
              updatedAt: "2026-07-19T09:59:50.000Z",
            },
          ],
        }),
      ),
    ).toBe("Writing the candidate bundle");
  });

  test("translates a numbered worker stage when no running row exists yet", () => {
    expect(
      reviewCurrentStage(job("RUNNING", { stage: "8 of 22: blind critic 7" })),
    ).toBe("Independent critique 7 of 7");
  });

  test("uses the newest durable timestamp as last progress", () => {
    expect(
      reviewLastChangedAt(
        job("RUNNING", {
          startedAt: "2026-07-19T09:59:35.000Z",
          steps: [
            {
              role: "MAP_LEARNING_SURFACES",
              state: "SUCCEEDED",
              updatedAt: "2026-07-19T09:59:55.000Z",
            },
          ],
        }),
      ),
    ).toBe("2026-07-19T09:59:55.000Z");
  });

  test("makes a newly queued request explicit and non-actionable", () => {
    const result = reviewPresentation(job("QUEUED"), now);
    expect(result).toMatchObject({
      tone: "active",
      title: "Request accepted — waiting for a review worker",
      completed: 0,
      total: workflowRoles.length,
    });
    expect(result.action).toContain("No action is needed");
    expect(result.detail).toContain("published guidance remains live");
  });

  test("calls out a queue that has not been claimed after two minutes", () => {
    const result = reviewPresentation(
      job("QUEUED", { createdAt: "2026-07-19T09:57:59.000Z" }),
      now,
    );
    expect(result.tone).toBe("warning");
    expect(result.title).toBe("Still waiting for a review worker");
    expect(result.action).toContain("Do not click again");
  });

  test("shows the exact active stage and completed count", () => {
    const steps = workflowRoles.slice(0, 8).map((role, index) => ({
      role,
      state: index === 7 ? "RUNNING" : "SUCCEEDED",
      updatedAt: `2026-07-19T09:59:${String(40 + index).padStart(2, "0")}.000Z`,
    }));
    const result = reviewPresentation(
      job("RUNNING", {
        startedAt: "2026-07-19T09:59:35.000Z",
        steps,
      }),
      now,
    );
    expect(result).toMatchObject({
      tone: "active",
      title: "Independent critique 7 of 7",
      completed: 7,
    });
  });

  test("calls out a running job with no durable progress for five minutes", () => {
    const result = reviewPresentation(
      job("RUNNING", {
        createdAt: "2026-07-19T09:45:00.000Z",
        startedAt: "2026-07-19T09:46:00.000Z",
      }),
      now,
    );
    expect(result.tone).toBe("warning");
    expect(result.eyebrow).toContain("taking longer than expected");
    expect(result.detail).toContain("no new step has been recorded");
  });

  test.each([
    ["WAITING_CAPACITY", "Waiting for AI capacity"],
    ["RETRY_SCHEDULED", "A retry is scheduled"],
  ] as const)("explains the recoverable %s state", (state, title) => {
    const result = reviewPresentation(job(state), now);
    expect(result).toMatchObject({ tone: "warning", title });
    expect(result.detail).toContain("completed steps are saved");
  });

  test.each([
    ["CANCELLING", "Stopping the review", "warning"],
    ["CANCELLED", "Review cancelled", "warning"],
    ["FAILED", "The review failed", "danger"],
    ["INCOMPLETE", "The review is incomplete", "danger"],
  ] as const)(
    "explains terminal/intervention state %s",
    (state, title, tone) => {
      expect(
        reviewPresentation(
          job(state, { finishedAt: "2026-07-19T10:00:00.000Z" }),
          now,
        ),
      ).toMatchObject({ title, tone });
    },
  );

  test("explains successful completion before the server refresh", () => {
    const steps = workflowRoles.map((role) => ({
      role,
      state: "SUCCEEDED",
      updatedAt: "2026-07-19T09:59:59.000Z",
    }));
    const result = reviewPresentation(
      job("SUCCEEDED", {
        startedAt: "2026-07-19T09:55:00.000Z",
        finishedAt: "2026-07-19T10:00:00.000Z",
        steps,
      }),
      now,
    );
    expect(result).toMatchObject({
      tone: "success",
      title: "Candidate ready for your review",
      completed: workflowRoles.length,
    });
  });

  test.each([
    ["QUEUED", ["complete", "current", "pending", "pending"]],
    ["RUNNING", ["complete", "complete", "current", "pending"]],
    ["SUCCEEDED", ["complete", "complete", "complete", "complete"]],
    ["FAILED", ["complete", "pending", "pending", "pending"]],
  ] as const)("maps %s to an exact four-step journey", (state, expected) => {
    const snapshot = job(state, {
      ...(state === "RUNNING" || state === "SUCCEEDED"
        ? { startedAt: "2026-07-19T09:59:40.000Z" }
        : {}),
      ...(state === "SUCCEEDED" || state === "FAILED"
        ? { finishedAt: "2026-07-19T10:00:00.000Z" }
        : {}),
      ...(state === "SUCCEEDED"
        ? {
            steps: workflowRoles.map((role) => ({
              role,
              state: "SUCCEEDED",
              updatedAt: "2026-07-19T09:59:59.000Z",
            })),
          }
        : {}),
    });
    expect(reviewProgressSteps(snapshot).map((step) => step.status)).toEqual(
      expected,
    );
  });

  test.each(["QUEUED", "RUNNING", "SUCCEEDED"] as const)(
    "%s always has four uniquely keyed progress steps",
    (state) => {
      const steps = reviewProgressSteps(job(state));
      expect(steps).toHaveLength(4);
      expect(new Set(steps.map((step) => step.key)).size).toBe(4);
    },
  );
});
