import { describe, expect, it } from "vitest";
import {
  AdapterFailure,
  assertAllowedRequest,
  classifyHttpFailure,
  runDeterministic,
} from "../src/index";

describe("provider adapter boundary", () => {
  it("rejects unallowlisted provider/model combinations before execution", () => {
    expect(() =>
      assertAllowedRequest({
        provider: "openai",
        model: "opus",
        effort: "high",
        role: "critic",
        system: "safe",
        evidence: "safe",
      }),
    ).toThrow(AdapterFailure);
  });

  it("blocks credentials before provider transmission", () => {
    expect(() =>
      assertAllowedRequest({
        provider: "anthropic",
        model: "opus",
        effort: "high",
        role: "critic",
        system: "safe",
        evidence: "password=definitely-secret-value",
      }),
    ).toThrow("Sensitive input");
  });

  it("classifies provider failures distinctly", () => {
    expect(classifyHttpFailure(401)).toEqual({
      failureClass: "AUTHENTICATION",
      retryable: false,
    });
    expect(classifyHttpFailure(429)).toEqual({
      failureClass: "CAPACITY",
      retryable: true,
    });
    expect(classifyHttpFailure(503)).toEqual({
      failureClass: "TRANSIENT",
      retryable: true,
    });
  });

  it("produces normalized deterministic output", async () => {
    const result = await runDeterministic({
      provider: "deterministic",
      model: "deterministic-fixture-v1",
      effort: "high",
      role: "critic",
      system: "safe",
      evidence: "synthetic evidence",
    });
    expect(result.output.provenance).toBe("deterministic-fixture-v1");
    expect(result.outputHash).toHaveLength(64);
  });
});
