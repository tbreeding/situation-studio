import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256 } from "@situation-studio/domain";
import liveCapabilities from "./fixtures/leadership-runtime-capabilities-20260802.json";
import {
  LeadershipCapabilityError,
  assertLeadershipRuntimeCompatible,
  leadershipCapabilitySchemaVersion,
  leadershipRuntimeCapabilitiesSchema,
  leadershipTypedParityPredicate,
  requiredContentContractIdentity,
  requiredLeadershipFeatures,
  requiredPublicationCompilerIdentity,
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
      publicationCompiler: requiredPublicationCompilerIdentity,
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
  it("accepts the exact deployed Leadership capability payload", async () => {
    const serialized = JSON.stringify(liveCapabilities);
    const { capabilityDigest, ...capabilitySet } = liveCapabilities;

    expect(Buffer.byteLength(serialized, "utf8")).toBe(1524);
    expect(sha256(serialized)).toBe(
      "a9679dd4b1e42bf4c6836fbd9dcd249c581cd66cf56ca1650faedd0bb5e74866",
    );
    expect(serialized.endsWith("\n")).toBe(false);
    expect(Buffer.byteLength(canonicalJson(capabilitySet), "utf8")).toBe(1439);
    expect(canonicalJson(capabilitySet).endsWith("\n")).toBe(true);
    expect(sha256(canonicalJson(capabilitySet))).toBe(capabilityDigest);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(serialized, {
            status: 200,
            headers: {
              "cache-control": "no-store",
              "content-type": "application/json",
            },
          }),
      ),
    );

    await expect(
      runtimeCapabilitiesFromHealth("https://leadership.example/health"),
    ).resolves.toEqual(liveCapabilities);
  });

  it("preserves additive digest-covered fields during schema validation", () => {
    const { capabilityDigest: _digest, ...capabilitySet } = compatible();
    const extendedCapabilitySet = {
      ...capabilitySet,
      deployment: {
        ...capabilitySet.deployment,
        runtime: "nodejs",
      },
      contracts: {
        ...capabilitySet.contracts,
        extension: {
          nullable: null,
          unicode: "Příliš žluťoučký kůň",
        },
      },
      extension: { enabled: true },
    };
    const candidate = {
      ...extendedCapabilitySet,
      capabilityDigest: sha256(canonicalJson(extendedCapabilitySet)),
    };
    const parsed = leadershipRuntimeCapabilitiesSchema.parse(candidate);

    expect(parsed.deployment.runtime).toBe("nodejs");
    expect(parsed.contracts.extension).toEqual({
      nullable: null,
      unicode: "Příliš žluťoučký kůň",
    });
    expect(parsed.extension).toEqual({ enabled: true });
    expect(assertLeadershipRuntimeCompatible(parsed)).toEqual(candidate);
  });

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
