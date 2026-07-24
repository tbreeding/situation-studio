import { describe, expect, it } from "vitest";
import {
  applySectionProposal,
  bundleHash,
  canonicalText,
  createScopedVariant,
  deriveSituationStatus,
  parseSituationSections,
  publicationConflictDecision,
  requiredSituationSections,
  reviewStages,
  serializeSituationSections,
  sha256,
  type SituationBundle,
  type SituationSections,
} from "../src/index";

function sections(): SituationSections {
  return Object.fromEntries(
    requiredSituationSections.map((section) => [section, `${section} body.`]),
  ) as SituationSections;
}

function bundle(): SituationBundle {
  const body = serializeSituationSections(sections());
  return {
    schemaVersion: "situation-bundle-v1",
    contractVersion: "test",
    validationPolicyVersion: "test",
    situationId: "d7682090-ae7f-442d-9e5e-7f9bd942104b",
    visibility: "PUBLIC",
    metadata: {
      slug: "repeatedly-misses-deadlines",
      title: "A teammate repeatedly misses important deadlines",
      description:
        "A careful field guide for addressing a recurring delivery pattern without losing clarity or trust.",
      stakes:
        "The pattern is affecting commitments, trust, and the rest of the team.",
      primarySkill: "feedback",
      preparationTime: "15 minutes",
      emotionalLoad: "high",
      pattern: "repeated-pattern",
      scope: "individual",
      tags: ["feedback", "delivery"],
      audience: ["manager"],
      support: [],
      published: "2026-07-01",
      lastReviewed: "2026-07-23",
      author: "tim-breeding",
      reviewer: "tim-breeding",
      socialHook: "Address the pattern early, clearly, and with room to learn.",
      campaignCluster: "delivery",
    },
    bodyHash: sha256(canonicalText(body)),
    artifacts: [],
    relationships: [],
    promotion: {},
    contextHashes: [],
  };
}

describe("domain invariants", () => {
  it("derives the small editorial status model", () => {
    expect(
      deriveSituationStatus({
        visibility: "PUBLIC",
        draftBundleHash: "a",
        productionBundleHash: "b",
      }),
    ).toEqual({ primary: "Draft saved", activity: null });
    expect(
      deriveSituationStatus({
        visibility: "PUBLIC",
        checkoutOwner: "Maya",
        activity: "Review queued",
      }),
    ).toEqual({
      primary: "Checked out by Maya",
      activity: "Review queued",
    });
    expect(deriveSituationStatus({ visibility: "RETIRED" }).primary).toBe(
      "Retired",
    );
  });

  it("canonicalizes bundle order before hashing", () => {
    const left = bundle();
    const right = { ...left, contextHashes: [...left.contextHashes].reverse() };
    expect(bundleHash(left)).toBe(bundleHash(right));
  });

  it("round-trips all required editable sections", () => {
    const original = sections();
    const serialized = serializeSituationSections(original);
    expect(parseSituationSections(serialized)).toEqual(original);
  });

  it("applies exactly one proposal section", () => {
    const original = sections();
    const updated = applySectionProposal(original, {
      id: "82d81dd7-a6fb-4a80-9e40-a6e2877f895c",
      targetKind: "SECTION",
      targetKey: "The short answer",
      beforeHash: sha256(canonicalText(original["The short answer"])),
      afterBody: "Updated short answer.",
      rationale: "Clearer opening.",
    });
    expect(updated["The short answer"]).toBe("Updated short answer.");
    expect(updated["1 — See"]).toBe(original["1 — See"]);
  });

  it("forks shared content with owner and base provenance", () => {
    const variant = createScopedVariant({
      situationId: "d7682090-ae7f-442d-9e5e-7f9bd942104b",
      kind: "PRACTICE",
      originalLogicalId: "practice:listen-first",
      originalContentHash: "a".repeat(64),
      changedBody: "Changed for this situation.",
    });
    expect(variant.artifact.visibility).toBe("SITUATION_SCOPED");
    expect(variant.artifact.forkedFromContentHash).toBe("a".repeat(64));
  });

  it("rebases unrelated releases and blocks target conflicts", () => {
    expect(
      publicationConflictDecision({
        draftBaseBundleHash: "same",
        observedTargetBundleHash: "same",
        baseReleaseId: "old",
        observedReleaseId: "new",
      }),
    ).toEqual({ kind: "PROCEED", rebase: true });
    expect(
      publicationConflictDecision({
        draftBaseBundleHash: "old",
        observedTargetBundleHash: "changed",
        baseReleaseId: "old-release",
        observedReleaseId: "new-release",
      }).kind,
    ).toBe("NEEDS_REFRESH");
  });

  it("defines the complete durable 22-stage review DAG", () => {
    expect(reviewStages).toHaveLength(22);
    expect(reviewStages[0]).toMatchObject({
      role: "surface-mapper",
      dependencies: [],
    });
    expect(reviewStages.at(-1)?.dependencies).toHaveLength(3);
  });
});
