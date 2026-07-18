import { describe, expect, it } from "vitest";
import {
  briefReadiness,
  canTransition,
  canonicalBundleHash,
  canonicalJson,
  detectSensitiveText,
  draftTransitions,
  effectivePermissions,
  finalizeHumanReviewProvenance,
  hasHumanReviewProvenance,
  isApprovedArtifactPath,
  isIsoReviewDate,
  isRepositoryReviewerId,
  publicationSagaTransitions,
  readHumanReviewProvenance,
  requiresHumanReviewProvenance,
  sha256,
  situationLifecycleTransitions,
  type BundleManifest,
} from "../src/index";

const hash = sha256("fixture");
const manifest: BundleManifest = {
  schemaVersion: "1",
  situationId: "situation:fixture",
  revision: 1,
  baseCommit: "9a870e5c70fef9ae71506cb3138745b88363a190",
  baseManifestHash: hash,
  briefHash: null,
  graphHash: hash,
  artifacts: [
    {
      logicalId: "situation:fixture",
      type: "SITUATION",
      path: "content/situations/fixture.mdx",
      baseHash: null,
      candidateHash: hash,
      changeKind: "ADD",
      noChangeRationale: null,
    },
  ],
  relationshipChanges: [],
};

describe("executable domain contracts", () => {
  it("expands the fixed RBAC matrix without conflating approval and publication", () => {
    expect([...effectivePermissions(["EDITOR"])].sort()).toEqual([
      "ai.run",
      "draft.update",
      "situation.create",
    ]);
    expect(effectivePermissions(["REVIEWER"]).has("publication.publish")).toBe(
      false,
    );
    expect(effectivePermissions(["PUBLISHER"]).has("publication.approve")).toBe(
      false,
    );
    expect(effectivePermissions(["ADMINISTRATOR"]).size).toBe(9);
  });

  it("permits only declared lifecycle and saga transitions", () => {
    expect(
      canTransition(situationLifecycleTransitions, "ACTIVE", "ARCHIVED"),
    ).toBe(true);
    expect(
      canTransition(situationLifecycleTransitions, "ACTIVE", "UNPUBLISHED"),
    ).toBe(false);
    expect(canTransition(draftTransitions, "HUMAN_REVIEW", "APPROVED")).toBe(
      true,
    );
    expect(canTransition(publicationSagaTransitions, "PUSHED", "CUTOVER")).toBe(
      false,
    );
  });

  it("canonicalizes JSON independently of insertion order", () => {
    expect(canonicalJson({ z: 1, nested: { b: 2, a: 1 }, a: 2 })).toBe(
      '{"a":2,"nested":{"a":1,"b":2},"z":1}\n',
    );
    expect(canonicalBundleHash(manifest)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("fails artifact paths closed", () => {
    expect(isApprovedArtifactPath("content/situations/example.mdx")).toBe(true);
    expect(isApprovedArtifactPath("../content/situations/example.mdx")).toBe(
      false,
    );
    expect(isApprovedArtifactPath("content/situations/example.js")).toBe(false);
    expect(isApprovedArtifactPath("public/escape.json")).toBe(false);
  });

  it("finalizes exact reviewer provenance without reformatting MDX", () => {
    const original = `---\ntitle: A fixture\nlastReviewed: 2026-07-16\nreviewer: pending-human-review\ntags: [one, two]\n---\n\n# Exact body\n`;
    const finalized = finalizeHumanReviewProvenance(original, {
      reviewer: "timothy-breeding",
      lastReviewed: "2026-07-18",
    });
    expect(finalized).toBe(
      `---\ntitle: A fixture\nlastReviewed: 2026-07-18\nreviewer: timothy-breeding\ntags: [one, two]\n---\n\n# Exact body\n`,
    );
    expect(readHumanReviewProvenance(finalized)).toEqual({
      reviewer: "timothy-breeding",
      lastReviewed: "2026-07-18",
    });
    expect(
      hasHumanReviewProvenance(finalized, {
        reviewer: "timothy-breeding",
        lastReviewed: "2026-07-18",
      }),
    ).toBe(true);
  });

  it("fails review provenance closed for malformed identities, dates, and paths", () => {
    expect(isRepositoryReviewerId("timothy-breeding")).toBe(true);
    expect(isRepositoryReviewerId("Timothy Breeding")).toBe(false);
    expect(isIsoReviewDate("2026-07-18")).toBe(true);
    expect(isIsoReviewDate("2026-02-30")).toBe(false);
    expect(
      requiresHumanReviewProvenance("content/situations/example.mdx"),
    ).toBe(true);
    expect(
      requiresHumanReviewProvenance("content/practices/example.json"),
    ).toBe(false);
    expect(() =>
      finalizeHumanReviewProvenance(
        `---\nreviewer: one\nreviewer: two\nlastReviewed: 2026-07-18\n---\n`,
        { reviewer: "timothy-breeding", lastReviewed: "2026-07-18" },
      ),
    ).toThrow(/exactly one reviewer/u);
  });

  it("requires the complete brief and blocks credentials", () => {
    expect(briefReadiness({}).ready).toBe(false);
    expect(detectSensitiveText("token=super-secret-value").blocked).toBe(true);
    expect(
      detectSensitiveText("A manager needs help making a request specific.")
        .blocked,
    ).toBe(false);
  });
});
