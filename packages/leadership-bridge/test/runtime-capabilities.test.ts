import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "@situation-studio/domain";
import {
  LeadershipCapabilityError,
  assertLeadershipRuntimeCompatible,
  leadershipCapabilitySchemaVersion,
  leadershipTypedParityPredicate,
  requiredContentContractIdentity,
  requiredLeadershipFeatures,
  requiredSituationContractIdentity,
  runtimeCapabilitiesFromHealth,
  type LeadershipRuntimeCapabilities,
} from "../src/runtime-capabilities";

function compatible() {
  const capabilitySet = {
    schemaVersion: leadershipCapabilitySchemaVersion,
    deployment: {
      commit: "a".repeat(40),
      releaseId: "20260729T160000Z",
      archiveSha256: "b".repeat(64),
    },
    contracts: {
      content: requiredContentContractIdentity,
      situation: requiredSituationContractIdentity,
    },
    database: { predicate: leadershipTypedParityPredicate },
    features: [...requiredLeadershipFeatures],
  };
  return {
    ...capabilitySet,
    capabilityDigest: sha256(canonicalJson(capabilitySet)),
  };
}

function withValidDigest(
  candidate: LeadershipRuntimeCapabilities,
): LeadershipRuntimeCapabilities {
  const { capabilityDigest: _digest, ...capabilitySet } = candidate;
  return {
    ...capabilitySet,
    capabilityDigest: sha256(canonicalJson(capabilitySet)),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Leadership runtime compatibility", () => {
  it("accepts only the exact contract identities and required features", () => {
    expect(assertLeadershipRuntimeCompatible(compatible())).toEqual(
      compatible(),
    );
    expect(() =>
      assertLeadershipRuntimeCompatible(
        withValidDigest({
          ...compatible(),
          features: requiredLeadershipFeatures.slice(1),
        }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_VERSION_PAIR" }),
    );
    expect(() =>
      assertLeadershipRuntimeCompatible(
        withValidDigest({
          ...compatible(),
          contracts: {
            ...compatible().contracts,
            content: {
              ...compatible().contracts.content,
              packageSha256: "f".repeat(64),
            },
          },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        code: "UNSUPPORTED_CONTRACT_IDENTITY",
      }),
    );
  });

  it("classifies an unavailable endpoint as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      runtimeCapabilitiesFromHealth("https://leadership.example/health"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "RUNTIME_CAPABILITY_UNAVAILABLE",
        retryable: true,
      } satisfies Partial<LeadershipCapabilityError>),
    );
  });

  it("classifies a legacy payload as deterministically unsupported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "healthy" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(
      runtimeCapabilitiesFromHealth("https://leadership.example/health"),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION_PAIR",
      retryable: false,
    });
  });
});
