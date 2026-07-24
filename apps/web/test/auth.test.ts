import { describe, expect, test } from "vitest";
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
});
