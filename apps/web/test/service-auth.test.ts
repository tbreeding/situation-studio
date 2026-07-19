import { describe, expect, test } from "vitest";
import {
  attestationKeyMatches,
  trustedBearerMatches,
} from "../src/lib/service-auth";

describe("database-publication service authentication", () => {
  test("requires the exact configured bearer credential", () => {
    const secret = "s".repeat(32);
    expect(trustedBearerMatches(secret, `Bearer ${secret}`)).toBe(true);
    expect(trustedBearerMatches(secret, `Bearer ${"x".repeat(32)}`)).toBe(
      false,
    );
    expect(trustedBearerMatches(undefined, "Bearer ")).toBe(false);
    expect(trustedBearerMatches(secret, null)).toBe(false);
  });

  test("binds a signed receipt to the configured attestation key ID", () => {
    expect(
      attestationKeyMatches("leadership-hmac-v1", "leadership-hmac-v1"),
    ).toBe(true);
    expect(attestationKeyMatches("leadership-hmac-v1", "attacker-key")).toBe(
      false,
    );
  });
});
