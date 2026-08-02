import { describe, expect, it } from "vitest";
import {
  inlineSuggestionPieces,
  reviewSuggestionCounts,
  type ReviewChangeView,
  type ReviewProposalView,
} from "@/components/agent-revision-review";

function change(override: Partial<ReviewChangeView> = {}): ReviewChangeView {
  return {
    id: "change-1",
    targetKind: "SECTION",
    targetKey: "The short answer",
    applicationMode: "AUTOMATIC",
    beforeHash: "a".repeat(64),
    beforeBody: "Name the pattern clearly.",
    afterBody: "Name the observable pattern clearly.",
    afterHash: "b".repeat(64),
    editorBody: null,
    editorHash: null,
    modified: false,
    problem: "The original wording is vague.",
    explanation: "Makes the opening observable.",
    rationale: "Specific observations reduce defensiveness.",
    writtenByRoleCode: "bundle-writer",
    identifiedByRoleCodes: ["critic-nvc"],
    evidenceRoleCodes: ["critic-manager-tools"],
    findingIds: ["finding-1"],
    state: "PENDING",
    ...override,
  };
}

function proposal(changes: ReviewChangeView[]): ReviewProposalView {
  return {
    id: "proposal-1",
    summary: "A concise retained summary.",
    candidate: null,
    changes,
    findings: [
      {
        id: "finding-1",
        findingKey: "critic-nvc:observable-language",
        severity: "IMPORTANT",
        targetKind: "SECTION",
        targetKey: "The short answer",
        summary: "The opening is not observable.",
        rationale: "Observable language separates facts from judgments.",
        sourceRoleCode: "critic-nvc",
        evidenceRoleCodes: ["critic-manager-tools"],
      },
      {
        id: "finding-2",
        findingKey: "critic-coaching:missing-question",
        severity: "CONSIDER",
        targetKind: "SECTION",
        targetKey: "3 — Say",
        summary: "No safe replacement was generated.",
        rationale: "The editor should choose a context-specific question.",
        sourceRoleCode: "critic-coaching",
        evidenceRoleCodes: [],
      },
    ],
  };
}

describe("agent revision review presentation", () => {
  it("keeps every manual suggestion out of Accept all", () => {
    expect(
      reviewSuggestionCounts(
        proposal([
          change(),
          change({
            id: "legacy-section",
            applicationMode: "MANUAL",
            targetKey: "3 — Say",
          }),
          change({
            id: "manual",
            applicationMode: "MANUAL",
            targetKind: "EMBED",
            findingIds: [],
          }),
          change({ id: "accepted", state: "ACCEPTED" }),
        ]),
      ),
    ).toEqual({
      unresolvedAutomatic: 1,
      unresolvedManual: 2,
      unlinkedFindings: 1,
    });
    expect(reviewSuggestionCounts(proposal([]))).toEqual({
      unresolvedAutomatic: 0,
      unresolvedManual: 0,
      unlinkedFindings: 2,
    });
  });

  it("uses the editor-modified replacement in the inline diff", () => {
    const replacement = inlineSuggestionPieces(
      change({
        editorBody: "Name one directly observed pattern.",
        modified: true,
      }),
    );
    expect(replacement.after).toBe("Name one directly observed pattern.");
    expect(replacement.before).toBe("Name the pattern clearly.");
  });

  it("removes a repeated section heading from a legacy suggestion", () => {
    expect(
      inlineSuggestionPieces(
        change({
          applicationMode: "MANUAL",
          afterBody: "## The short answer\nName one directly observed pattern.",
        }),
      ).after,
    ).toBe("Name one directly observed pattern.");
  });
});
