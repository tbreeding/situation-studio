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
  type DraftState,
  type PublicationSagaState,
  type SituationLifecycle,
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

const publicationStates = [
  "REQUESTED",
  "WORKTREE_READY",
  "APPLIED",
  "VALIDATED",
  "COMMITTED",
  "PUSHED",
  "PREVIEW_BUILT",
  "PREVIEW_VERIFIED",
  "AWAITING_CONFIRMATION",
  "CUTOVER",
  "LIVE_VERIFIED",
  "RECONCILED",
  "FAILED_PREVIEW",
  "AUTO_ROLLED_BACK",
  "RECONCILIATION_REQUIRED",
] as const satisfies readonly PublicationSagaState[];

const allowedPublicationEdges = new Set([
  "REQUESTED>WORKTREE_READY",
  "REQUESTED>RECONCILIATION_REQUIRED",
  "WORKTREE_READY>APPLIED",
  "WORKTREE_READY>RECONCILIATION_REQUIRED",
  "APPLIED>VALIDATED",
  "APPLIED>RECONCILIATION_REQUIRED",
  "VALIDATED>COMMITTED",
  "VALIDATED>FAILED_PREVIEW",
  "VALIDATED>RECONCILIATION_REQUIRED",
  "COMMITTED>PUSHED",
  "COMMITTED>RECONCILIATION_REQUIRED",
  "PUSHED>PREVIEW_BUILT",
  "PUSHED>FAILED_PREVIEW",
  "PUSHED>RECONCILIATION_REQUIRED",
  "PREVIEW_BUILT>PREVIEW_VERIFIED",
  "PREVIEW_BUILT>FAILED_PREVIEW",
  "PREVIEW_BUILT>RECONCILIATION_REQUIRED",
  "PREVIEW_VERIFIED>AWAITING_CONFIRMATION",
  "PREVIEW_VERIFIED>FAILED_PREVIEW",
  "AWAITING_CONFIRMATION>CUTOVER",
  "AWAITING_CONFIRMATION>FAILED_PREVIEW",
  "CUTOVER>LIVE_VERIFIED",
  "CUTOVER>AUTO_ROLLED_BACK",
  "CUTOVER>RECONCILIATION_REQUIRED",
  "LIVE_VERIFIED>RECONCILED",
  "LIVE_VERIFIED>AUTO_ROLLED_BACK",
  "LIVE_VERIFIED>RECONCILIATION_REQUIRED",
  "AUTO_ROLLED_BACK>RECONCILED",
  "AUTO_ROLLED_BACK>RECONCILIATION_REQUIRED",
  "RECONCILIATION_REQUIRED>RECONCILED",
  "RECONCILIATION_REQUIRED>AUTO_ROLLED_BACK",
]);

const draftStates = [
  "DISCOVERY",
  "DRAFTING",
  "READY_FOR_AI_REVIEW",
  "AI_REVIEW_QUEUED",
  "AI_REVIEW_RUNNING",
  "PROPOSAL_READY",
  "HUMAN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
] as const satisfies readonly DraftState[];

const allowedDraftEdges = new Set([
  "DISCOVERY>DRAFTING",
  "DISCOVERY>READY_FOR_AI_REVIEW",
  "DRAFTING>READY_FOR_AI_REVIEW",
  "DRAFTING>HUMAN_REVIEW",
  "READY_FOR_AI_REVIEW>AI_REVIEW_QUEUED",
  "READY_FOR_AI_REVIEW>DRAFTING",
  "AI_REVIEW_QUEUED>AI_REVIEW_RUNNING",
  "AI_REVIEW_QUEUED>DRAFTING",
  "AI_REVIEW_QUEUED>FAILED",
  "AI_REVIEW_RUNNING>PROPOSAL_READY",
  "AI_REVIEW_RUNNING>FAILED",
  "AI_REVIEW_RUNNING>DRAFTING",
  "PROPOSAL_READY>HUMAN_REVIEW",
  "PROPOSAL_READY>CHANGES_REQUESTED",
  "PROPOSAL_READY>DRAFTING",
  "HUMAN_REVIEW>APPROVED",
  "HUMAN_REVIEW>CHANGES_REQUESTED",
  "HUMAN_REVIEW>DRAFTING",
  "CHANGES_REQUESTED>DRAFTING",
  "CHANGES_REQUESTED>READY_FOR_AI_REVIEW",
  "CHANGES_REQUESTED>HUMAN_REVIEW",
  "APPROVED>PUBLISHING",
  "APPROVED>DRAFTING",
  "PUBLISHING>PUBLISHED",
  "PUBLISHING>FAILED",
  "PUBLISHING>APPROVED",
  "PUBLISHED>DRAFTING",
  "FAILED>DISCOVERY",
  "FAILED>DRAFTING",
  "FAILED>READY_FOR_AI_REVIEW",
  "FAILED>APPROVED",
]);

const lifecycleStates = [
  "UNPUBLISHED",
  "ACTIVE",
  "ARCHIVED",
] as const satisfies readonly SituationLifecycle[];

const allowedLifecycleEdges = new Set([
  "UNPUBLISHED>ACTIVE",
  "UNPUBLISHED>ARCHIVED",
  "ACTIVE>ARCHIVED",
  "ARCHIVED>UNPUBLISHED",
  "ARCHIVED>ACTIVE",
]);

describe("exhaustive state-transition matrices", () => {
  it.each(
    publicationStates.flatMap((from) =>
      publicationStates.map((to) => [from, to] as const),
    ),
  )("publication %s -> %s follows the fail-closed contract", (from, to) => {
    expect(canTransition(publicationSagaTransitions, from, to)).toBe(
      allowedPublicationEdges.has(`${from}>${to}`),
    );
  });

  it.each(
    draftStates.flatMap((from) => draftStates.map((to) => [from, to] as const)),
  )("draft %s -> %s follows the workflow contract", (from, to) => {
    expect(canTransition(draftTransitions, from, to)).toBe(
      allowedDraftEdges.has(`${from}>${to}`),
    );
  });

  it.each(
    lifecycleStates.flatMap((from) =>
      lifecycleStates.map((to) => [from, to] as const),
    ),
  )("situation %s -> %s follows the lifecycle contract", (from, to) => {
    expect(canTransition(situationLifecycleTransitions, from, to)).toBe(
      allowedLifecycleEdges.has(`${from}>${to}`),
    );
  });
});
