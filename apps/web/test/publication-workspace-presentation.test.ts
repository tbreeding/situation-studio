import { describe, expect, test } from "vitest";
import {
  publicationWorkspacePresentation,
  publicationWorkspaceStateValues,
  shouldPollPublication,
  type PublicationWorkspacePhase,
  type PublicationWorkspaceState,
} from "../src/lib/publication-presentation";

const phaseByState: Record<
  PublicationWorkspaceState,
  PublicationWorkspacePhase
> = {
  REQUESTED: "PREPARING",
  SNAPSHOT_MATERIALIZED: "PREPARING",
  SNAPSHOT_VALIDATED: "PREPARING",
  CANDIDATE_AVAILABLE: "CANDIDATE_REVIEW",
  CANDIDATE_VERIFIED: "CANDIDATE_REVIEW",
  WORKTREE_READY: "PREPARING",
  APPLIED: "PREPARING",
  VALIDATED: "PREPARING",
  COMMITTED: "PREPARING",
  PUSHED: "PREPARING",
  PREVIEW_BUILT: "PREPARING",
  PREVIEW_VERIFIED: "CANDIDATE_REVIEW",
  AWAITING_CONFIRMATION: "AWAITING_CONFIRMATION",
  OFFICIAL_POINTER_COMMITTED: "PUBLISHING",
  RESTORING_PREVIOUS: "RESTORING",
  CUTOVER: "PUBLISHING",
  LIVE_VERIFIED: "PUBLISHING",
  RECONCILED: "PUBLISHED",
  FAILED_PREVIEW: "FAILED",
  AUTO_ROLLED_BACK: "RESTORED",
  RECONCILIATION_REQUIRED: "BLOCKED",
};

const activeStates = new Set<PublicationWorkspaceState>([
  "REQUESTED",
  "SNAPSHOT_MATERIALIZED",
  "SNAPSHOT_VALIDATED",
  "CANDIDATE_AVAILABLE",
  "CANDIDATE_VERIFIED",
  "WORKTREE_READY",
  "APPLIED",
  "VALIDATED",
  "COMMITTED",
  "PUSHED",
  "PREVIEW_BUILT",
  "PREVIEW_VERIFIED",
  "AWAITING_CONFIRMATION",
  "OFFICIAL_POINTER_COMMITTED",
  "RESTORING_PREVIOUS",
  "CUTOVER",
  "LIVE_VERIFIED",
]);

const terminalStates = new Set<PublicationWorkspaceState>([
  "RECONCILED",
  "FAILED_PREVIEW",
  "AUTO_ROLLED_BACK",
  "RECONCILIATION_REQUIRED",
]);

const cases = publicationWorkspaceStateValues.flatMap((state) =>
  (["database", "git"] as const).flatMap((backend) =>
    ([false, true] as const).map((finalConfirmed) => ({
      state,
      backend,
      finalConfirmed,
    })),
  ),
);

function renderCase(input: (typeof cases)[number]) {
  return publicationWorkspacePresentation({
    ...input,
    candidateIdentity: "a".repeat(64),
  });
}

function allCopy(input: ReturnType<typeof renderCase>) {
  return [
    input.candidateBadge,
    input.decisionLabel,
    input.leadershipDisplay,
    input.leadershipDetail,
  ].join(" | ");
}

describe("publication workspace presentation contract", () => {
  test("enumerates the complete persisted publication state vocabulary", () => {
    expect(publicationWorkspaceStateValues).toHaveLength(21);
    expect(new Set(publicationWorkspaceStateValues).size).toBe(21);
    expect(Object.keys(phaseByState).sort()).toEqual(
      [...publicationWorkspaceStateValues].sort(),
    );
  });

  test.each(cases)(
    "$backend $state (confirmed=$finalConfirmed) returns one complete presentation",
    (input) => {
      const presentation = renderCase(input);
      expect(presentation.phase).toBe(
        input.state === "AWAITING_CONFIRMATION" && input.finalConfirmed
          ? "PUBLISHING"
          : phaseByState[input.state],
      );
      expect(presentation.candidateBadge.trim().length).toBeGreaterThan(0);
      expect(presentation.decisionLabel.trim().length).toBeGreaterThan(0);
      expect(presentation.leadershipDisplay.trim().length).toBeGreaterThan(0);
      expect(presentation.leadershipDetail.trim().length).toBeGreaterThan(0);
    },
  );

  test.each(cases)(
    "$backend $state has mutually exclusive active and terminal flags",
    (input) => {
      const presentation = renderCase(input);
      expect(presentation.active).toBe(activeStates.has(input.state));
      expect(presentation.terminal).toBe(terminalStates.has(input.state));
      expect(presentation.active && presentation.terminal).toBe(false);
    },
  );

  test.each(["database", "git"] as const)(
    "%s failed preview never claims active work or an active candidate",
    (backend) => {
      for (const finalConfirmed of [false, true]) {
        const presentation = publicationWorkspacePresentation({
          state: "FAILED_PREVIEW",
          finalConfirmed,
          backend,
          candidateIdentity: "f".repeat(64),
        });
        expect(presentation).toMatchObject({
          phase: "FAILED",
          active: false,
          terminal: true,
          candidateBadge: "Preview failed",
          leadershipDisplay: "Official baseline unchanged",
        });
        expect(allCopy(presentation)).not.toMatch(
          /\b(?:preparing|ready|activating|verifying|in progress|not yet official)\b/iu,
        );
        expect(allCopy(presentation)).not.toContain("ffffffff");
      }
    },
  );

  test.each(["RECONCILED", "AUTO_ROLLED_BACK"] as const)(
    "%s never claims pending work",
    (state) => {
      for (const backend of ["database", "git"] as const) {
        const copy = allCopy(
          publicationWorkspacePresentation({
            state,
            finalConfirmed: true,
            backend,
            candidateIdentity: "b".repeat(64),
          }),
        );
        expect(copy).not.toMatch(
          /\b(?:preparing|ready|activating|verifying|in progress|not yet official)\b/iu,
        );
      }
    },
  );

  test("reconciled publication describes one official result", () => {
    const presentation = publicationWorkspacePresentation({
      state: "RECONCILED",
      finalConfirmed: true,
      backend: "database",
      candidateIdentity: "c".repeat(64),
    });
    expect(presentation).toMatchObject({
      phase: "PUBLISHED",
      candidateBadge: "Published",
      decisionLabel: "Published successfully",
      leadershipDisplay: "Official baseline",
    });
    expect(allCopy(presentation)).not.toMatch(/failed|blocked|unavailable/iu);
  });

  test("reconciliation-required state makes no success or progress claim", () => {
    const presentation = publicationWorkspacePresentation({
      state: "RECONCILIATION_REQUIRED",
      finalConfirmed: true,
      backend: "database",
      candidateIdentity: "d".repeat(64),
    });
    expect(presentation).toMatchObject({
      phase: "BLOCKED",
      active: false,
      terminal: true,
      candidateBadge: "Publication blocked",
      leadershipDisplay: "State requires reconciliation",
    });
    expect(allCopy(presentation)).not.toMatch(
      /\b(?:published successfully|preparing|activating|verifying)\b/iu,
    );
  });

  test.each(["CANDIDATE_AVAILABLE", "CANDIDATE_VERIFIED"] as const)(
    "database %s describes a private candidate consistently",
    (state) => {
      const copy = allCopy(
        publicationWorkspacePresentation({
          state,
          finalConfirmed: false,
          backend: "database",
          candidateIdentity: "e".repeat(64),
        }),
      );
      expect(copy).toContain("Private candidate");
      expect(copy).toContain("Snapshot eeeeeeee · not yet official");
      expect(copy).not.toMatch(/staged|Git|commit/iu);
      expect(copy).not.toMatch(/failed|unchanged|restored/iu);
    },
  );

  test.each(["CANDIDATE_AVAILABLE", "PREVIEW_VERIFIED"] as const)(
    "git %s describes one staged candidate consistently",
    (state) => {
      const copy = allCopy(
        publicationWorkspacePresentation({
          state,
          finalConfirmed: false,
          backend: "git",
          candidateIdentity: "1".repeat(64),
        }),
      );
      expect(copy).toContain("Candidate staged");
      expect(copy).toContain("Commit 11111111 · not yet official");
      expect(copy).not.toMatch(/private|database|snapshot/iu);
      expect(copy).not.toMatch(/failed|unchanged|restored/iu);
    },
  );

  test("confirmation changes awaiting-confirmation copy without changing its exact candidate", () => {
    const pending = publicationWorkspacePresentation({
      state: "AWAITING_CONFIRMATION",
      finalConfirmed: false,
      backend: "database",
      candidateIdentity: "2".repeat(64),
    });
    const recorded = publicationWorkspacePresentation({
      state: "AWAITING_CONFIRMATION",
      finalConfirmed: true,
      backend: "database",
      candidateIdentity: "2".repeat(64),
    });
    expect(pending).toMatchObject({
      phase: "AWAITING_CONFIRMATION",
      decisionLabel: "Awaiting your confirmation",
    });
    expect(recorded).toMatchObject({
      phase: "PUBLISHING",
      decisionLabel: "Final publication in progress",
      leadershipDisplay: "Candidate confirmed",
    });
    expect(pending.leadershipDetail).toContain("22222222");
    expect(recorded.leadershipDetail).toContain("Confirmation is recorded");
  });

  test.each(
    publicationWorkspaceStateValues.filter(
      (state) =>
        ![
          "AWAITING_CONFIRMATION",
          "OFFICIAL_POINTER_COMMITTED",
          "CUTOVER",
          "LIVE_VERIFIED",
          "RECONCILED",
        ].includes(state),
    ),
  )(
    "%s cannot be promoted by a stray final-confirmation timestamp",
    (state) => {
      for (const backend of ["database", "git"] as const) {
        const unconfirmed = publicationWorkspacePresentation({
          state,
          finalConfirmed: false,
          backend,
          candidateIdentity: "5".repeat(64),
        });
        const strayConfirmation = publicationWorkspacePresentation({
          state,
          finalConfirmed: true,
          backend,
          candidateIdentity: "5".repeat(64),
        });
        expect(strayConfirmation).toEqual(unconfirmed);
      }
    },
  );

  test("restoration is active, visible publisher work and remains pollable", () => {
    const presentation = publicationWorkspacePresentation({
      state: "RESTORING_PREVIOUS",
      finalConfirmed: true,
      backend: "database",
      candidateIdentity: "3".repeat(64),
    });
    expect(presentation).toMatchObject({
      phase: "RESTORING",
      active: true,
      terminal: false,
      candidateBadge: "Restoring previous version",
      decisionLabel: "Restoring the previous official version",
      leadershipDisplay: "Restoring official baseline",
    });
    expect(shouldPollPublication("RESTORING_PREVIOUS", true)).toBe(true);
  });

  test.each(["", "UNKNOWN", "CORRUPT_STATE", "failed_preview"])(
    "unknown state %j fails closed without inventing progress",
    (state) => {
      const presentation = publicationWorkspacePresentation({
        state,
        finalConfirmed: false,
        backend: "database",
        candidateIdentity: "4".repeat(64),
      });
      expect(presentation).toEqual({
        phase: "UNKNOWN",
        active: false,
        terminal: false,
        candidateBadge: "Publication state unavailable",
        decisionLabel: "Publication state unavailable",
        leadershipDisplay: "Publication state unavailable",
        leadershipDetail:
          "Studio cannot safely describe this request. No active or completed publication is being claimed.",
      });
      expect(allCopy(presentation)).not.toMatch(
        /\b(?:preparing|ready|activating|verifying|in progress|published successfully)\b/iu,
      );
      expect(shouldPollPublication(state, false)).toBe(false);
    },
  );
});
