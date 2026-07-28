import { describe, expect, it } from "vitest";
import { REVIEW_POLICY_VERSION, reviewPolicyForRole } from "../src/runtime";

describe("packaged leadership-review policy", () => {
  it("loads a versioned role-specific critic policy", () => {
    expect(REVIEW_POLICY_VERSION).toMatch(
      /^review-leadership-situations-[a-f0-9]{16}$/u,
    );
    const policy = reviewPolicyForRole("critic-nvc");
    expect(policy).toContain(
      "Nonviolent Communication and power/request clarity",
    );
    expect(policy).toContain("Seek disconfirming evidence.");
    expect(policy).not.toContain(
      "Management operating cadence and behavioral feedback",
    );
  });

  it("packages the new adjudication and page-language gates", () => {
    expect(reviewPolicyForRole("adjudicator")).toContain(
      "PUBLIC_EXPRESSION: explicit | implicit | internal-only | omit",
    );
    const pagePolicy = reviewPolicyForRole("audit-page-language");
    expect(pagePolicy).toContain("FIRST_ACTION_IN_30_SECONDS");
    expect(pagePolicy).toContain("MANAGER_CAN_ACT_WITHOUT_JARGON");
  });

  it("packages the mediated issue-register stage", () => {
    const policy = reviewPolicyForRole("issue-register");
    expect(policy).toContain("ISSUE: I-<number>");
    expect(policy).toContain("Combine duplicate findings");
  });

  it("rejects a job pinned to an unavailable policy", () => {
    expect(() =>
      reviewPolicyForRole("surface-mapper", "old-review-policy"),
    ).toThrow(/unavailable/u);
  });
});
