import { describe, expect, test } from "vitest";
import {
  candidateFormActionOrigin,
  studioContentSecurityPolicy,
} from "../src/lib/content-security-policy";

describe("Studio content security policy", () => {
  test("allows forms only to self and the configured Leadership origin", () => {
    const policy = studioContentSecurityPolicy(
      "test-nonce",
      "https://candidate.example.test/private/path",
    );
    expect(policy).toContain(
      "form-action 'self' https://candidate.example.test",
    );
    expect(policy).not.toContain("/private/path");
  });

  test("falls back to the production Leadership origin on invalid input", () => {
    expect(candidateFormActionOrigin("not a URL")).toBe(
      "https://leadership.timsprototypes.com",
    );
  });
});
