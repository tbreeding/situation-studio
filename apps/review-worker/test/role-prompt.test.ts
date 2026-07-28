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
    const prompt = rolePrompt(
      "audit-teaching-alignment",
      REVIEW_POLICY_VERSION,
    );

    expect(prompt).toContain("## Packaged review policy");
    expect(prompt).toContain(REVIEW_POLICY_VERSION);
    expect(prompt).toContain("Post-draft teaching auditor");
  });

  it("continues to reject unknown policy versions", () => {
    expect(() =>
      rolePrompt("audit-teaching-alignment", "unknown-review-policy"),
    ).toThrow(/unavailable/u);
  });
});
