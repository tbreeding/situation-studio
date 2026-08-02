import { z } from "zod";
import {
  PUBLICATION_COMPILER_DIGEST,
  PUBLICATION_COMPILER_IDENTITY,
  canonicalJson,
  sha256,
} from "@situation-studio/domain";

export const leadershipCapabilitySchemaVersion =
  "leadership-studio-capabilities-v1" as const;
export const leadershipTypedParityPredicate =
  "typed-projection-parity-v1" as const;
export const requiredLeadershipFeatures = [
  "authored-physical-id-v1",
  "scoped-renderer-context-v1",
  "typed-projection-parity-v1",
  "affected-route-proof-v2",
  "affected-route-proof-json-v1",
] as const;

// These are immutable package identities shared by the two repositories.
// The content-contract digest is updated mechanically when the Leadership-
// owned 0.3.0 package is packed and vendored.
export const requiredContentContractIdentity = {
  version: "0.3.0",
  packageSha256:
    "ef9a723608977b3f9ea3c25bd1a7cd5f323871854937c0e462a21ca057ee9f7f",
  validationPolicyHash:
    "9131270fbc6a2e579ee10752fddf3f1f133b257a554666ea946bb76439deceee",
} as const;
export const requiredPublicationCompilerIdentity = {
  identity: PUBLICATION_COMPILER_IDENTITY,
  digest: PUBLICATION_COMPILER_DIGEST,
} as const;
export const requiredSituationContractIdentity = {
  version: "1.0.0",
  packageSha256:
    "9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4",
} as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const leadershipRuntimeCapabilitiesSchema = z.object({
  schemaVersion: z.literal(leadershipCapabilitySchemaVersion),
  deployment: z.object({
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    releaseId: z.string().min(1).max(100),
    archiveSha256: sha256Schema,
  }),
  contracts: z.object({
    content: z.object({
      version: z.string().min(1).max(100),
      packageSha256: sha256Schema,
      validationPolicyHash: sha256Schema,
    }),
    publicationCompiler: z.object({
      identity: z.record(z.string(), z.unknown()),
      digest: sha256Schema,
    }),
    situation: z.object({
      version: z.string().min(1).max(100),
      packageSha256: sha256Schema,
    }),
  }),
  database: z.object({
    predicate: z.string().min(1).max(100),
  }),
  features: z.array(z.string().min(1).max(100)),
  capabilityDigest: sha256Schema,
});

export type LeadershipRuntimeCapabilities = z.infer<
  typeof leadershipRuntimeCapabilitiesSchema
>;

export class LeadershipCapabilityError extends Error {
  constructor(
    message: string,
    readonly code:
      | "RUNTIME_CAPABILITY_UNAVAILABLE"
      | "UNSUPPORTED_VERSION_PAIR"
      | "UNSUPPORTED_CONTRACT_IDENTITY",
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "LeadershipCapabilityError";
  }
}

export function assertLeadershipRuntimeCompatible(
  candidate: LeadershipRuntimeCapabilities,
) {
  const { capabilityDigest, ...capabilitySet } = candidate;
  if (sha256(canonicalJson(capabilitySet)) !== capabilityDigest)
    throw new LeadershipCapabilityError(
      "The deployed Leadership capability digest is invalid.",
      "UNSUPPORTED_VERSION_PAIR",
      false,
    );
  const missingFeatures = requiredLeadershipFeatures.filter(
    (feature) => !candidate.features.includes(feature),
  );
  if (
    candidate.database.predicate !== leadershipTypedParityPredicate ||
    missingFeatures.length > 0
  )
    throw new LeadershipCapabilityError(
      "The deployed Leadership runtime does not expose the required publication capabilities.",
      "UNSUPPORTED_VERSION_PAIR",
      false,
    );
  if (
    candidate.contracts.content.version !==
      requiredContentContractIdentity.version ||
    candidate.contracts.content.packageSha256 !==
      requiredContentContractIdentity.packageSha256 ||
    candidate.contracts.content.validationPolicyHash !==
      requiredContentContractIdentity.validationPolicyHash ||
    candidate.contracts.publicationCompiler.digest !==
      requiredPublicationCompilerIdentity.digest ||
    candidate.contracts.situation.version !==
      requiredSituationContractIdentity.version ||
    candidate.contracts.situation.packageSha256 !==
      requiredSituationContractIdentity.packageSha256
  )
    throw new LeadershipCapabilityError(
      "The deployed Leadership contract packages do not match Situation Studio.",
      "UNSUPPORTED_CONTRACT_IDENTITY",
      false,
    );
  return candidate;
}

export async function runtimeCapabilitiesFromHealth(
  capabilitiesUrl: string,
): Promise<LeadershipRuntimeCapabilities> {
  let response: Response;
  try {
    response = await fetch(capabilitiesUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new LeadershipCapabilityError(
      "Leadership runtime capabilities are temporarily unavailable.",
      "RUNTIME_CAPABILITY_UNAVAILABLE",
      true,
    );
  }
  if (!response.ok)
    throw new LeadershipCapabilityError(
      "Leadership runtime capabilities are temporarily unavailable.",
      "RUNTIME_CAPABILITY_UNAVAILABLE",
      true,
    );
  const parsed = leadershipRuntimeCapabilitiesSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success)
    throw new LeadershipCapabilityError(
      "The deployed Leadership runtime does not publish a supported capability contract.",
      "UNSUPPORTED_VERSION_PAIR",
      false,
    );
  return assertLeadershipRuntimeCompatible(parsed.data);
}
