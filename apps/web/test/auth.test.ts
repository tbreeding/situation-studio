import { describe, expect, test } from "vitest";
import { publicUrl } from "@/server/auth/public-url";
import { safeReturnTo } from "@/server/auth/return-to";
import { canonicalUsername } from "@/server/auth/throttle";

describe("authentication input boundaries", () => {
  test.each([
    [undefined, "/"],
    [null, "/"],
    ["", "/"],
    ["https://attacker.example/steal", "/"],
    ["//attacker.example/steal", "/"],
    ["///attacker.example/steal", "/"],
    ["javascript:alert(1)", "/"],
    ["/", "/"],
    ["/operations", "/operations"],
    ["/situations/abc?tab=review#result", "/situations/abc?tab=review#result"],
  ])("normalizes return destination %j", (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });

  test("canonicalizes usernames without creating confusable whitespace variants", () => {
    expect(canonicalUsername("  Studio.Admin  ")).toBe("studio.admin");
  });

  test("builds authentication redirects from the public origin", () => {
    expect(
      publicUrl(
        "/situations/active?tab=review",
        "https://situation-studio.example",
      ).href,
    ).toBe("https://situation-studio.example/situations/active?tab=review");
  });
});
