import { describe, expect, test } from "vitest";
import { studioContentSecurityPolicy } from "../src/lib/content-security-policy";

describe("Studio content security policy", () => {
  test("allows forms only to the Studio origin", () => {
    expect(studioContentSecurityPolicy("test-nonce")).toContain(
      "form-action 'self'",
    );
  });
});
