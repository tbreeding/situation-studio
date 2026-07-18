import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdapterFailure,
  assertAllowedRequest,
  classifyHttpFailure,
  runDeterministic,
  runOpenAI,
} from "../src/index";

afterEach(() => vi.unstubAllGlobals());

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

  it("requires deterministic candidate edits from the bundle writer", async () => {
    const result = await runDeterministic({
      provider: "deterministic",
      model: "deterministic-fixture-v1",
      effort: "high",
      role: "BUNDLE_WRITER",
      system: "safe",
      evidence: "synthetic evidence",
      outputKind: "bundle-writer",
    });
    expect(result.output).toMatchObject({ candidateEdits: [] });
  });

  it("uses the Codex-first Responses API without provider retention", async () => {
    const output = {
      role: "critic",
      summary: "Reviewed.",
      findings: [],
      provenance: "gpt-5.6-sol",
    };
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "gpt-5.6-sol",
          output: [
            {
              content: [{ type: "output_text", text: JSON.stringify(output) }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await runOpenAI(
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        effort: "high",
        role: "critic",
        system: "safe system",
        evidence: "synthetic evidence",
      },
      "test-api-key-long-enough-for-schema",
    );

    const [, request] = fetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as {
      model: string;
      store: boolean;
    };
    expect(body).toMatchObject({ model: "gpt-5.6-sol", store: false });
    expect(result.output).toEqual(output);
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 7,
      estimated: false,
    });
  });
});
