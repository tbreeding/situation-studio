import { describe, expect, it } from "vitest";
import { REVIEW_POLICY_VERSION } from "@situation-studio/review-policy";
import { LEGACY_REVIEW_POLICY_VERSION, rolePrompt } from "../src/review";

describe("review role prompt policy compatibility", () => {
  it("keeps legacy-pinned reviews on their original prompt assembly", () => {
    const prompt = rolePrompt(
      "audit-teaching-alignment",
      LEGACY_REVIEW_POLICY_VERSION,
    );

    expect(prompt).toContain(
      "You are the audit-teaching-alignment stage in a leadership-content editorial review.",
    );
    expect(prompt).not.toContain("## Packaged review policy");
    expect(prompt).not.toContain(REVIEW_POLICY_VERSION);
  });

  it("adds the packaged policy to current reviews", () => {
    const prompt = rolePrompt("critical-review", REVIEW_POLICY_VERSION);

    expect(prompt).toContain("## Packaged review policy");
    expect(prompt).toContain(REVIEW_POLICY_VERSION);
    expect(prompt).toContain("Nonviolent Communication");
    expect(prompt).toContain("Manager Tools");
    expect(prompt).toContain("Emit only typed findings");
  });

  it("keeps model output declarative and makes the final audit an exact gate", () => {
    const builder = rolePrompt("candidate-builder", REVIEW_POLICY_VERSION);
    expect(builder).toContain("changeIntents");
    expect(builder).toContain(
      "Never invent IDs, hashes, application modes, or patch operations",
    );
    expect(builder).toContain("role-code:finding-id");

    const audit = rolePrompt("candidate-audit", REVIEW_POLICY_VERSION);
    expect(audit).toContain("exact materializedCandidate");
    expect(audit).toContain("candidateHash");
    expect(audit).toContain("verdict PASS");
    expect(audit).toContain("REVISE");
    expect(audit).toContain("single bounded repair pass");
  });

  it("defines the candidate target grammar for legacy and current jobs", () => {
    for (const policyVersion of [
      LEGACY_REVIEW_POLICY_VERSION,
      REVIEW_POLICY_VERSION,
    ]) {
      const prompt = rolePrompt("bundle-writer", policyVersion);
      expect(prompt).toContain("section/subheading");
      expect(prompt).toContain("section#named-block");
      expect(prompt).toContain("#new-variant-id");
      expect(prompt).toContain("sourceReferences");
      expect(prompt).toContain("MANUAL");
      expect(prompt).toContain(
        "String values such as title or description must include JSON double quotes",
      );
    }
  });

  it("continues to reject unknown policy versions", () => {
    expect(() =>
      rolePrompt("audit-teaching-alignment", "unknown-review-policy"),
    ).toThrow(/unavailable/u);
  });
});
