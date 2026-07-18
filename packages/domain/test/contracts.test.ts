import { describe, expect, it } from "vitest";
import {
  briefReadiness,
  canTransition,
  canonicalBundleHash,
  canonicalJson,
  detectSensitiveText,
  draftTransitions,
  effectivePermissions,
  isApprovedArtifactPath,
  publicationSagaTransitions,
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

  it("requires the complete brief and blocks credentials", () => {
    expect(briefReadiness({}).ready).toBe(false);
    expect(detectSensitiveText("token=super-secret-value").blocked).toBe(true);
    expect(
      detectSensitiveText("A manager needs help making a request specific.")
        .blocked,
    ).toBe(false);
  });
});
