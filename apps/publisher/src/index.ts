import { Client, type PoolClient, type QueryResultRow } from "pg";
import {
  Prisma,
  type ArtifactKind,
  type DatabaseClient,
  type PublicationEventKind,
} from "@situation-studio/db";
import {
  physicalPracticeId,
  snapshotManifestSchema as leadershipSnapshotManifestSchema,
  validateCanonicalSnapshot,
  validationPolicyHash as leadershipValidationPolicyHash,
} from "@leadership-field-guide/content-contracts";
import {
  LeadershipCapabilityError,
  assertLeadershipRuntimeCompatible,
  leadershipTypedParityPredicate,
  readOfficialLeadershipRelease,
  requiredContentContractIdentity,
  type LeadershipRuntimeCapabilities,
} from "@situation-studio/leadership-bridge";
import {
  assertSafeManagedMdx,
  bundleHash,
  canonicalJson,
  canonicalText,
  publicationConflictDecision,
  publicationFailureDetailSchema,
  scopedPracticeSchema,
  scopedSourceSchema,
  sha256,
  situationBundleSchema,
  validateSituationBundle,
  type PublicationFailureDetail,
  type SituationBundle,
} from "@situation-studio/domain";
import { z } from "zod";

type ManifestArtifact = {
  logicalId: string;
  type: string;
  path: string;
  contentHash: string;
  byteLength: number;
  encoding: "UTF8" | "BINARY";
  mediaType: string;
};

type ManifestEdge = {
  source: string;
  target: string;
  type: string;
  evidence: string;
};

type ReleaseManifest = {
  schemaVersion: string;
  validationPolicyHash: string;
  source: Record<string, string>;
  artifacts: ManifestArtifact[];
  edges: ManifestEdge[];
};

type ChangedArtifact = ManifestArtifact & {
  body: string;
  visibility: "GLOBAL" | "SITUATION_SCOPED" | "INTERNAL";
  ownerSituationSlug: string | null;
  forkedFromLogicalId: string | null;
  forkedFromContentHash: string | null;
};

export type CandidateSnapshot = {
  publicationId: string;
  releaseId: string;
  parentReleaseId: string;
  expectedGeneration: bigint;
  manifest: ReleaseManifest;
  manifestBody: string;
  manifestHash: string;
  artifactCount: number;
  edgeCount: number;
  totalByteLength: bigint;
  targetSlug: string;
  targetSituationId: string;
  targetBody: string;
  targetBundle: SituationBundle;
  sourceKind: string;
  changedArtifacts: ChangedArtifact[];
};

export type RuntimeIdentity = {
  releaseId: string;
  manifestHash: string;
};

export type RuntimeRouteExpectation = {
  releaseId: string;
  manifestHash: string;
  situationSlug: string;
  situationBodyHash: string;
  visibility: "PUBLIC" | "RETIRED";
  practice: {
    authoredId: string;
    resolvedLogicalId: string;
    contentHash: string;
  } | null;
};

export type RuntimeRouteProof = {
  code: "AFFECTED_ROUTE_VERIFIED" | "AFFECTED_ROUTE_RETIRED";
  httpStatus: number;
  observedReleaseId: string | null;
  observedManifestHash: string | null;
  observedSituationBodyHash: string | null;
  observedPracticeLogicalId: string | null;
  observedPracticeContentHash: string | null;
};

export class PublisherVerificationError extends Error {
  constructor(
    message: string,
    readonly code:
      "AFFECTED_ROUTE_VERIFICATION_FAILED" | "TYPED_PROJECTION_INVALID",
  ) {
    super(message);
    this.name = "PublisherVerificationError";
  }
}

export class PublisherRuntimeHealthError extends Error {
  constructor(
    readonly reason: "HTTP_STATUS" | "UNAVAILABLE" | "INVALID_RESPONSE",
    readonly httpStatus: number | null = null,
  ) {
    super(
      reason === "HTTP_STATUS"
        ? "Leadership content health returned a non-success status."
        : reason === "INVALID_RESPONSE"
          ? "Leadership content health returned an invalid response."
          : "Leadership content health was unavailable.",
    );
    this.name = "PublisherRuntimeHealthError";
  }
}

export class PublisherRuntimeConvergenceError extends Error {
  readonly code:
    | "RUNTIME_HEALTH_UNAVAILABLE"
    | "RUNTIME_HEALTH_INVALID_RESPONSE"
    | "RUNTIME_IDENTITY_MISMATCH";

  constructor(readonly failureDetail: PublicationFailureDetail) {
    super(
      failureDetail.reason === "IDENTITY_MISMATCH"
        ? "Leadership did not converge on the expected runtime identity."
        : failureDetail.reason === "INVALID_RESPONSE"
          ? "Leadership content health did not return a valid identity."
          : "Leadership content health remained unavailable.",
    );
    this.name = "PublisherRuntimeConvergenceError";
    this.code =
      failureDetail.reason === "IDENTITY_MISMATCH"
        ? "RUNTIME_IDENTITY_MISMATCH"
        : failureDetail.reason === "INVALID_RESPONSE"
          ? "RUNTIME_HEALTH_INVALID_RESPONSE"
          : "RUNTIME_HEALTH_UNAVAILABLE";
  }
}

export class PublisherCandidateContractError extends Error {
  readonly code:
    | "CANONICAL_SNAPSHOT_INVALID"
    | "PRACTICE_EMBED_MISMATCH"
    | "PREPARED_ACTION_MISMATCH";

  constructor(cause: unknown) {
    super(
      "The assembled Leadership snapshot does not satisfy the canonical content contract.",
      { cause },
    );
    this.name = "PublisherCandidateContractError";
    const detail = cause instanceof Error ? cause.message : "";
    this.code = /PracticeEmbed does not match frontmatter/iu.test(detail)
      ? "PRACTICE_EMBED_MISMATCH"
      : /PreparedAction does not match frontmatter/iu.test(detail)
        ? "PREPARED_ACTION_MISMATCH"
        : "CANONICAL_SNAPSHOT_INVALID";
  }
}

class PublisherNeedsRefreshError extends Error {
  constructor(
    readonly detail: {
      observedReleaseId: string;
      observedBundleHash: string | null;
      baseBundleHash: string | null;
      expectedPointerGeneration: bigint;
    },
  ) {
    super("The Leadership target changed after this draft was based.");
    this.name = "PublisherNeedsRefreshError";
  }
}

export type PublisherBoundary =
  | "CANDIDATE_PERSISTED"
  | "LEADERSHIP_PROMOTION_READY"
  | "LEADERSHIP_PROMOTION_COMMIT_READY"
  | "LEADERSHIP_PROMOTION_COMMITTED"
  | "LEADERSHIP_PROMOTED"
  | "RUNTIME_VERIFIED"
  | "STUDIO_SUCCESS_FINALIZING"
  | "STUDIO_SUCCESS_COMMITTED";

export class PublisherCrashInjectionError extends Error {
  constructor(readonly boundary: PublisherBoundary) {
    super(`Simulated publisher crash after ${boundary}.`);
    this.name = "PublisherCrashInjectionError";
  }
}

type PublisherDependencies = {
  studio: DatabaseClient;
  leadershipPublisherUrl: string;
  runtimeIdentity: (options?: {
    signal?: AbortSignal;
  }) => Promise<RuntimeIdentity>;
  runtimeCapabilities?: () => Promise<LeadershipRuntimeCapabilities>;
  runtimeRouteProof?: (
    expected: RuntimeRouteExpectation,
  ) => Promise<RuntimeRouteProof>;
  producerCommit: string;
  runtimeVerification?: {
    attempts?: number;
    intervalMs?: number;
    deadlineMs?: number;
    requestTimeoutMs?: number;
  };
  publicationLeaseHeartbeatMs?: number;
  onRuntimeIdentityProbe?: () => Promise<void> | void;
  afterBoundary?: (boundary: PublisherBoundary) => Promise<void>;
  onFailure?: (error: unknown) => void;
};

type ClaimedJob = Awaited<ReturnType<typeof loadJob>>;

function identityMatches(identity: RuntimeIdentity, expected: RuntimeIdentity) {
  return (
    identity.releaseId === expected.releaseId &&
    identity.manifestHash === expected.manifestHash
  );
}

async function convergedRuntimeIdentity(
  dependencies: Pick<
    PublisherDependencies,
    "runtimeIdentity" | "runtimeVerification" | "onRuntimeIdentityProbe"
  >,
  expected: RuntimeIdentity,
  beforeProbe?: () => Promise<void>,
) {
  const attempts = Math.max(
    1,
    // Leadership refreshes its official-content cache every five seconds.
    // Cover more than two complete refresh windows in production.
    Math.min(
      100,
      Math.floor(dependencies.runtimeVerification?.attempts ?? 100),
    ),
  );
  const intervalMs = Math.max(
    0,
    Math.min(
      5_000,
      Math.floor(dependencies.runtimeVerification?.intervalMs ?? 500),
    ),
  );
  const deadlineMs = Math.max(
    1,
    Math.min(
      120_000,
      Math.floor(dependencies.runtimeVerification?.deadlineMs ?? 45_000),
    ),
  );
  const requestTimeoutMs = Math.max(
    1,
    Math.min(
      10_000,
      Math.floor(dependencies.runtimeVerification?.requestTimeoutMs ?? 5_000),
    ),
  );
  const startedAt = Date.now();
  const deadlineAt = startedAt + deadlineMs;
  let lastIdentity: RuntimeIdentity | undefined;
  let lastReason: PublicationFailureDetail["reason"] = "UNAVAILABLE";
  let lastHttpStatus: number | null = null;
  let completedAttempts = 0;

  const failure = () => {
    const observedRelease = z.uuid().safeParse(lastIdentity?.releaseId);
    const observedManifest = z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .safeParse(lastIdentity?.manifestHash);
    return new PublisherRuntimeConvergenceError(
      publicationFailureDetailSchema.parse({
        schemaVersion: "publication-failure-detail-v1",
        phase: "RUNTIME_IDENTITY",
        source: "LEADERSHIP_CONTENT_HEALTH",
        reason: lastReason,
        attempts: Math.max(1, completedAttempts),
        elapsedMs: Math.min(
          600_000,
          Math.max(0, Math.floor(Date.now() - startedAt)),
        ),
        lastHttpStatus,
        lastObservedReleaseId: observedRelease.success
          ? observedRelease.data
          : null,
        lastObservedManifestHash: observedManifest.success
          ? observedManifest.data
          : null,
      }),
    );
  };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw failure();
    await beforeProbe?.();
    await dependencies.onRuntimeIdentityProbe?.();
    completedAttempts = attempt + 1;
    if (deadlineAt - Date.now() <= 0) throw failure();
    const controller = new AbortController();
    const timeoutMs = Math.max(
      1,
      Math.min(requestTimeoutMs, deadlineAt - Date.now()),
    );
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      lastIdentity = await Promise.race([
        dependencies.runtimeIdentity({ signal: controller.signal }),
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new PublisherRuntimeHealthError("UNAVAILABLE", null)),
            { once: true },
          );
        }),
      ]);
      if (identityMatches(lastIdentity, expected)) return lastIdentity;
      lastReason = "IDENTITY_MISMATCH";
      lastHttpStatus = null;
    } catch (error) {
      if (error instanceof PublisherRuntimeHealthError) {
        const validHttpStatus =
          Number.isInteger(error.httpStatus) &&
          error.httpStatus !== null &&
          error.httpStatus >= 100 &&
          error.httpStatus <= 599;
        lastReason =
          error.reason === "HTTP_STATUS" && !validHttpStatus
            ? "UNAVAILABLE"
            : error.reason;
        lastHttpStatus = validHttpStatus ? error.httpStatus : null;
      } else {
        lastReason = "UNAVAILABLE";
        lastHttpStatus = null;
      }
    } finally {
      clearTimeout(timeout);
    }
    const afterProbeRemainingMs = deadlineAt - Date.now();
    if (attempt + 1 >= attempts || afterProbeRemainingMs <= 0) throw failure();
    if (intervalMs > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(intervalMs, afterProbeRemainingMs)),
      );
  }
  throw failure();
}

function routeExpectation(
  candidate: CandidateSnapshot,
): RuntimeRouteExpectation {
  const situationArtifact = candidate.changedArtifacts.find(
    (artifact) =>
      artifact.type === "SITUATION" &&
      artifact.logicalId === `situation:${candidate.targetSlug}`,
  );
  if (!situationArtifact)
    throw new PublisherVerificationError(
      "The affected situation artifact is missing from the candidate.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const scopedPractice = candidate.changedArtifacts.find(
    (artifact) =>
      artifact.type === "PRACTICE" &&
      artifact.visibility === "SITUATION_SCOPED" &&
      artifact.forkedFromLogicalId,
  );
  return {
    releaseId: candidate.releaseId,
    manifestHash: candidate.manifestHash,
    situationSlug: candidate.targetSlug,
    situationBodyHash: situationArtifact.contentHash,
    visibility:
      candidate.targetBundle.visibility === "RETIRED" ? "RETIRED" : "PUBLIC",
    practice: scopedPractice?.forkedFromLogicalId
      ? {
          authoredId: scopedPractice.forkedFromLogicalId.replace(
            /^practice:/u,
            "",
          ),
          resolvedLogicalId: scopedPractice.logicalId,
          contentHash: scopedPractice.contentHash,
        }
      : null,
  };
}

function decodeHtmlAttribute(value: string) {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function htmlAttribute(source: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`\\s${escaped}="([^"]*)"`, "u").exec(source);
  return match ? decodeHtmlAttribute(match[1] ?? "") : null;
}

export async function runtimeRouteProofFromSituationPage(
  healthUrl: string,
  expected: RuntimeRouteExpectation,
): Promise<RuntimeRouteProof> {
  const routeUrl = new URL(
    `/situations/${encodeURIComponent(expected.situationSlug)}`,
    healthUrl,
  );
  let response: Response;
  try {
    response = await fetch(routeUrl, {
      headers: {
        accept: "text/html",
        "cache-control": "no-cache",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PublisherVerificationError(
      "The affected Leadership route was unavailable.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  }
  if (expected.visibility === "RETIRED") {
    if (response.status !== 404)
      throw new PublisherVerificationError(
        "The retired Leadership route remained publicly renderable.",
        "AFFECTED_ROUTE_VERIFICATION_FAILED",
      );
    return {
      code: "AFFECTED_ROUTE_RETIRED",
      httpStatus: response.status,
      observedReleaseId: null,
      observedManifestHash: null,
      observedSituationBodyHash: null,
      observedPracticeLogicalId: null,
      observedPracticeContentHash: null,
    };
  }
  if (response.status !== 200)
    throw new PublisherVerificationError(
      `The affected Leadership route returned HTTP ${response.status}.`,
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > 2 * 1024 * 1024)
    throw new PublisherVerificationError(
      "The affected Leadership route exceeded the verification size limit.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const body = await response.text();
  if (new TextEncoder().encode(body).byteLength > 2 * 1024 * 1024)
    throw new PublisherVerificationError(
      "The affected Leadership route exceeded the verification size limit.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const matchingArticles = (body.match(/<article\b[^>]*>/gu) ?? []).filter(
    (tag) =>
      htmlAttribute(tag, "class")?.split(/\s+/u).includes("paperPage") ===
        true &&
      htmlAttribute(tag, "data-leadership-release-id") === expected.releaseId &&
      htmlAttribute(tag, "data-leadership-manifest-hash") ===
        expected.manifestHash &&
      htmlAttribute(tag, "data-leadership-situation-body-hash") ===
        expected.situationBodyHash,
  );
  if (matchingArticles.length !== 1)
    throw new PublisherVerificationError(
      "The affected Leadership route did not render the expected immutable release.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const articleTag = matchingArticles[0] ?? "";
  const renderProof = htmlAttribute(articleTag, "data-leadership-render-proof");
  if (
    !renderProof ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      renderProof,
    )
  )
    throw new PublisherVerificationError(
      "The affected Leadership route did not render a valid server proof.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const observedReleaseId = htmlAttribute(
    articleTag,
    "data-leadership-release-id",
  );
  const observedManifestHash = htmlAttribute(
    articleTag,
    "data-leadership-manifest-hash",
  );
  const observedSituationBodyHash = htmlAttribute(
    articleTag,
    "data-leadership-situation-body-hash",
  );

  let observedPracticeLogicalId: string | null = null;
  let observedPracticeContentHash: string | null = null;
  if (expected.practice) {
    const practiceTags = body.match(
      /<section\b[^>]*\sdata-leadership-practice-authored-id="[^"]*"[^>]*>/gu,
    );
    const matchingTag = practiceTags?.find(
      (tag) =>
        htmlAttribute(tag, "class")
          ?.split(/\s+/u)
          .includes("practiceEngine") === true &&
        htmlAttribute(tag, "data-leadership-practice-authored-id") ===
          expected.practice?.authoredId &&
        htmlAttribute(tag, "data-leadership-practice-logical-id") ===
          expected.practice?.resolvedLogicalId &&
        htmlAttribute(tag, "data-leadership-practice-content-hash") ===
          expected.practice?.contentHash &&
        htmlAttribute(tag, "data-leadership-render-proof") === renderProof,
    );
    if (!matchingTag)
      throw new PublisherVerificationError(
        "The affected Leadership route did not resolve the expected scoped practice.",
        "AFFECTED_ROUTE_VERIFICATION_FAILED",
      );
    observedPracticeLogicalId = htmlAttribute(
      matchingTag,
      "data-leadership-practice-logical-id",
    );
    observedPracticeContentHash = htmlAttribute(
      matchingTag,
      "data-leadership-practice-content-hash",
    );
  }
  return {
    code: "AFFECTED_ROUTE_VERIFIED",
    httpStatus: response.status,
    observedReleaseId,
    observedManifestHash,
    observedSituationBodyHash,
    observedPracticeLogicalId,
    observedPracticeContentHash,
  };
}

async function assertPublicationFence(
  studio: DatabaseClient,
  input: {
    jobId: string;
    situationId: string;
    checkoutId: string;
    checkoutFence: bigint;
    claimToken?: string;
  },
) {
  const [job, checkout, situation] = await Promise.all([
    studio.publicationJob.findUnique({
      where: { id: input.jobId },
      select: { state: true, checkoutFence: true, claimToken: true },
    }),
    studio.situationCheckout.findUnique({
      where: { id: input.checkoutId },
      select: { fence: true, releasedAt: true },
    }),
    studio.situation.findUnique({
      where: { id: input.situationId },
      select: { fence: true },
    }),
  ]);
  if (
    !job ||
    !["ASSEMBLING", "PROMOTING", "VERIFYING"].includes(job.state) ||
    job.checkoutFence !== input.checkoutFence ||
    job.claimToken !== (input.claimToken ?? null) ||
    !checkout ||
    checkout.releasedAt ||
    checkout.fence !== input.checkoutFence ||
    !situation ||
    situation.fence !== input.checkoutFence
  )
    throw new Error("Publication authority was fenced by a newer checkout.");
}

const manifestSchema = z.object({
  schemaVersion: z.string().min(1),
  validationPolicyHash: z.string().regex(/^[a-f0-9]{64}$/u),
  source: z.record(z.string(), z.string()),
  artifacts: z.array(
    z.object({
      logicalId: z.string().min(1),
      type: z.string().min(1),
      path: z.string().min(1),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      byteLength: z.number().int().nonnegative(),
      encoding: z.enum(["UTF8", "BINARY"]),
      mediaType: z.string().min(1),
    }),
  ),
  edges: z.array(
    z.object({
      source: z.string().min(1),
      target: z.string().min(1),
      type: z.string().min(1),
      evidence: z.string().min(1),
    }),
  ),
});

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function executeStatements(
  client: PoolClient | Client,
  sql: string,
  values: unknown[],
) {
  for (const statement of sql
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)) {
    const indexes = [
      ...new Set(
        [...statement.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])),
      ),
    ].sort((left, right) => left - right);
    const positions = new Map(
      indexes.map((original, index) => [original, index + 1]),
    );
    const text = statement.replace(
      /\$(\d+)/gu,
      (_match, rawIndex: string) =>
        `$${positions.get(Number(rawIndex)) ?? Number(rawIndex)}`,
    );
    await client.query(
      text,
      indexes.map((index) => values[index - 1]),
    );
  }
}

function artifactPath(
  slug: string,
  kind: string,
  logicalId: string,
  mediaType: string,
) {
  const safeIdentity = logicalId
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const extension = mediaType.startsWith("application/json") ? "json" : "mdx";
  return `content/scoped/${slug}/${kind.toLowerCase()}/${safeIdentity}.${extension}`;
}

function mediaType(kind: string) {
  return kind === "PRACTICE" || kind === "SOURCE"
    ? "application/json; charset=utf-8"
    : "text/mdx; charset=utf-8";
}

function visibilityForPublication(
  bundle: SituationBundle,
  sourceKind: string,
): "PUBLIC" | "RETIRED" {
  if (sourceKind === "RETIRE" || bundle.visibility === "RETIRED")
    return "RETIRED";
  return "PUBLIC";
}

function bundleForPublication(bundle: SituationBundle, sourceKind: string) {
  const visibility = visibilityForPublication(bundle, sourceKind);
  return situationBundleSchema.parse({
    ...bundle,
    visibility,
    promotion: visibility === "PUBLIC" ? bundle.promotion : {},
  });
}

function yamlScalar(value: unknown) {
  return JSON.stringify(value);
}

function situationFile(input: {
  bundle: SituationBundle;
  body: string;
  projection: {
    relatedSituationIds: string[];
    sourceReferences: string[];
    practiceId: string;
    practiceVariant: string;
    fieldNotePresent: boolean;
    safetyEscalationNotePresent: boolean;
    reviewStatus: string;
  };
}) {
  const metadata = input.bundle.metadata;
  const lines = [
    "---",
    `slug: ${yamlScalar(metadata.slug)}`,
    `title: ${yamlScalar(metadata.title)}`,
    `description: ${yamlScalar(metadata.description)}`,
    `stakes: ${yamlScalar(metadata.stakes)}`,
    `primarySkill: ${yamlScalar(metadata.primarySkill)}`,
    `tags: ${yamlScalar(metadata.tags)}`,
    `audience: ${yamlScalar(metadata.audience)}`,
    `preparationTime: ${yamlScalar(metadata.preparationTime)}`,
    `emotionalLoad: ${yamlScalar(metadata.emotionalLoad)}`,
    `pattern: ${yamlScalar(metadata.pattern)}`,
    `scope: ${yamlScalar(metadata.scope)}`,
    `support: ${yamlScalar(metadata.support)}`,
    `published: ${yamlScalar(metadata.published)}`,
    `lastReviewed: ${yamlScalar(metadata.lastReviewed)}`,
    `author: ${yamlScalar(metadata.author)}`,
    `reviewer: ${yamlScalar(metadata.reviewer)}`,
    `sourceReferences: ${yamlScalar(input.projection.sourceReferences)}`,
    `relatedSituationIds: ${yamlScalar(input.projection.relatedSituationIds)}`,
    `practiceId: ${yamlScalar(input.projection.practiceId)}`,
    `practiceVariant: ${yamlScalar(input.projection.practiceVariant)}`,
    `fieldNotePresent: ${input.projection.fieldNotePresent}`,
    `safetyEscalationNotePresent: ${input.projection.safetyEscalationNotePresent}`,
    `socialHook: ${yamlScalar(metadata.socialHook)}`,
    `campaignCluster: ${yamlScalar(metadata.campaignCluster)}`,
    `reviewStatus: ${yamlScalar(input.projection.reviewStatus)}`,
    "---",
    "",
    canonicalText(input.body).trimEnd(),
  ];
  return canonicalText(lines.join("\n"));
}

async function releaseBodies(client: Client, releaseId: string) {
  const result = await client.query<{
    content_hash: string;
    encoding: "UTF8" | "BINARY";
    text_body: string | null;
    binary_body: Uint8Array | null;
  }>(
    `
      SELECT membership.content_hash,
             version.encoding::text,
             version.text_body,
             version.binary_body
        FROM release_artifacts membership
        JOIN artifact_versions version
          ON version.id = membership.artifact_version_id
       WHERE membership.release_id = $1
    `,
    [releaseId],
  );
  const bodies = new Map<string, Uint8Array>();
  for (const row of result.rows) {
    if (row.encoding === "UTF8") {
      if (row.text_body === null)
        throw new PublisherCandidateContractError(
          new Error(`UTF-8 artifact ${row.content_hash} has no text body.`),
        );
      bodies.set(row.content_hash, new TextEncoder().encode(row.text_body));
      continue;
    }
    if (row.binary_body === null)
      throw new PublisherCandidateContractError(
        new Error(`Binary artifact ${row.content_hash} has no binary body.`),
      );
    bodies.set(row.content_hash, new Uint8Array(row.binary_body));
  }
  return bodies;
}

async function validateCanonicalCandidate(
  client: Client,
  candidate: CandidateSnapshot,
  baseReleaseId: string,
) {
  const bodies = await releaseBodies(client, baseReleaseId);
  for (const artifact of candidate.changedArtifacts)
    bodies.set(
      artifact.contentHash,
      new TextEncoder().encode(canonicalText(artifact.body)),
    );
  try {
    await validateCanonicalSnapshot(candidate.manifestBody, bodies);
  } catch (error) {
    if (error instanceof PublisherCandidateContractError) throw error;
    throw new PublisherCandidateContractError(error);
  }
}

type StudioTransaction = Parameters<
  Parameters<DatabaseClient["$transaction"]>[0]
>[0];

const PUBLICATION_COORDINATION_LOCK_KEY = 7_311_945_021;

async function lockPublicationCoordination(
  transaction: Pick<StudioTransaction, "$queryRaw">,
) {
  await transaction.$queryRaw<Array<{ locked: number }>>`
    SELECT 1::integer AS locked
      FROM pg_advisory_xact_lock(${PUBLICATION_COORDINATION_LOCK_KEY}::bigint)
  `;
}

async function appendPublicationEvent(
  transaction: Pick<StudioTransaction, "publicationEvent">,
  jobId: string,
  kind: PublicationEventKind,
  payload: Record<string, unknown>,
) {
  const aggregate = await transaction.publicationEvent.aggregate({
    where: { jobId },
    _max: { sequence: true },
  });
  await transaction.publicationEvent.create({
    data: {
      jobId,
      sequence: (aggregate._max.sequence ?? 0) + 1,
      kind,
      payload: jsonInput(payload),
    },
  });
}

async function event(
  studio: DatabaseClient,
  jobId: string,
  kind: PublicationEventKind,
  payload: Record<string, unknown>,
) {
  await studio.$transaction((transaction) =>
    appendPublicationEvent(transaction, jobId, kind, payload),
  );
}

export async function claimPublicationJob(studio: DatabaseClient) {
  return studio.$transaction(
    async (transaction) => {
      await lockPublicationCoordination(transaction);
      const recoveryFence = await transaction.publicationJob.count({
        where: { state: "RECOVERY_REQUIRED" },
      });
      const activeOwner = await transaction.publicationJob.count({
        where: {
          state: { in: ["ASSEMBLING", "PROMOTING", "VERIFYING"] },
          claimToken: { not: null },
          leaseExpiresAt: { gt: new Date() },
        },
      });
      if (recoveryFence || activeOwner) return null;
      const claimed = await transaction.$queryRaw<
        Array<{ id: string; claim_token: string }>
      >`
        WITH selected AS (
          SELECT "id"
            FROM "publication_jobs"
           WHERE (
             "state" = 'REQUESTED'
             OR (
               "state" IN ('ASSEMBLING', 'PROMOTING', 'VERIFYING')
               AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())
             )
           )
           ORDER BY "created_at", "id"
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        UPDATE "publication_jobs" job
           SET "state" = CASE
                 WHEN job."state" = 'REQUESTED' THEN 'ASSEMBLING'::"PublicationJobState"
                 ELSE job."state"
               END,
               "started_at" = COALESCE(job."started_at", now()),
               "claim_token" = gen_random_uuid(),
               "lease_expires_at" = now() + interval '3 minutes'
          FROM selected
         WHERE job."id" = selected."id"
        RETURNING job."id", job."claim_token"
      `;
      const row = claimed[0];
      return row ? { id: row.id, claimToken: row.claim_token } : null;
    },
    { isolationLevel: "Serializable" },
  );
}

async function renewPublicationLease(
  studio: DatabaseClient,
  jobId: string,
  claimToken?: string,
) {
  if (!claimToken) return;
  const renewed = await studio.publicationJob.updateMany({
    where: {
      id: jobId,
      claimToken,
      state: {
        in: ["ASSEMBLING", "PROMOTING", "VERIFYING", "RECOVERY_REQUIRED"],
      },
    },
    data: { leaseExpiresAt: new Date(Date.now() + 180_000) },
  });
  if (renewed.count !== 1)
    throw new Error("Publication lease was lost to another publisher.");
}

async function withPublicationLeaseHeartbeat<T>(
  studio: DatabaseClient,
  input: {
    jobId: string;
    situationId: string;
    checkoutId: string;
    checkoutFence: bigint;
    claimToken?: string;
    heartbeatMs?: number;
  },
  operation: (assertAuthority: () => Promise<void>) => Promise<T>,
) {
  const heartbeatMs = Math.max(
    1_000,
    Math.min(120_000, Math.floor(input.heartbeatMs ?? 30_000)),
  );
  let stopped = false;
  let leaseFailure: unknown;
  let renewal = Promise.resolve();
  const queueRenewal = () => {
    renewal = renewal.then(async () => {
      if (stopped || leaseFailure) return;
      try {
        await renewPublicationLease(studio, input.jobId, input.claimToken);
      } catch (error) {
        leaseFailure = error;
      }
    });
  };
  const monitor = setInterval(queueRenewal, heartbeatMs);
  monitor.unref();
  const assertAuthority = async () => {
    await renewal;
    if (leaseFailure) throw leaseFailure;
    await renewPublicationLease(studio, input.jobId, input.claimToken);
    await assertPublicationFence(studio, input);
  };
  try {
    await assertAuthority();
    const result = await operation(assertAuthority);
    await renewal;
    if (leaseFailure) throw leaseFailure;
    return result;
  } finally {
    stopped = true;
    clearInterval(monitor);
    await renewal.catch(() => undefined);
  }
}

async function loadJob(
  studio: Pick<DatabaseClient, "publicationJob">,
  jobId: string,
) {
  return studio.publicationJob.findUniqueOrThrow({
    where: { id: jobId },
    include: {
      situation: true,
      candidateSnapshot: true,
      receipt: true,
      targetRevision: {
        include: {
          artifacts: {
            include: { content: true },
            orderBy: { position: "asc" },
          },
        },
      },
      attempts: { orderBy: { attempt: "desc" }, take: 1 },
    },
  });
}

async function startPublicationAttempt(
  studio: DatabaseClient,
  jobId: string,
  claimToken?: string,
) {
  return studio.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT "id"
          FROM "publication_jobs"
         WHERE "id" = ${jobId}::uuid
         FOR UPDATE
      `;
      const job = await loadJob(transaction, jobId);
      if (job.claimToken !== (claimToken ?? null))
        throw new Error(
          "Publication authority was lost before the attempt could start.",
        );
      const nextAttempt = (job.attempts[0]?.attempt ?? 0) + 1;
      await transaction.publicationAttempt.updateMany({
        where: { jobId, finishedAt: null },
        data: {
          finishedAt: new Date(),
          failureCode: "PUBLISHER_PROCESS_INTERRUPTED",
          reconciledState: jsonInput({
            outcome: "INTERRUPTED_BEFORE_RETRY",
            supersededByAttempt: nextAttempt,
          }),
        },
      });
      const attempt = await transaction.publicationAttempt.create({
        data: { jobId, attempt: nextAttempt },
      });
      return { attempt, job };
    },
    { isolationLevel: "Serializable" },
  );
}

async function targetProjection(
  client: Client,
  releaseId: string,
  slug: string,
) {
  const result = await client.query<{
    practice_id: string;
    practice_variant: string;
    field_note_present: boolean;
    safety_escalation_note_present: boolean;
    review_status: string;
    related_situation_ids: string[];
    source_references: string[];
  }>(
    `
      SELECT
        situation.practice_id,
        situation.practice_variant,
        situation.field_note_present,
        situation.safety_escalation_note_present,
        situation.review_status,
        COALESCE((
          SELECT json_agg(target.slug ORDER BY relation.position)
            FROM situation_relations relation
            JOIN situations target ON target.id = relation.target_situation_id
           WHERE relation.source_situation_id = situation.id
        ), '[]'::json) AS related_situation_ids,
        COALESCE((
          SELECT json_agg(source.source_id ORDER BY reference.position)
            FROM situation_source_references reference
            JOIN sources source ON source.id = reference.source_id
           WHERE reference.situation_id = situation.id
        ), '[]'::json) AS source_references
        FROM situations situation
       WHERE situation.release_id = $1
         AND situation.slug = $2
    `,
    [releaseId, slug],
  );
  return (
    result.rows[0] ?? {
      practice_id: "listen-first",
      practice_variant: "default",
      field_note_present: true,
      safety_escalation_note_present: true,
      review_status: "human-approved",
      related_situation_ids: [],
      source_references: [],
    }
  );
}

function stableObservedBundle(
  item: Awaited<
    ReturnType<typeof readOfficialLeadershipRelease>
  >["situations"][number],
  situationId: string,
) {
  return bundleHash(
    situationBundleSchema.parse({
      ...item.bundle,
      situationId,
    }),
  );
}

async function buildCandidate(
  studio: DatabaseClient,
  leadershipUrl: string,
  job: ClaimedJob,
  claimToken?: string,
) {
  const bodyArtifact = job.targetRevision.artifacts.find(
    (artifact) => artifact.kind === "SITUATION",
  );
  const body = bodyArtifact?.content.textBody;
  if (!body) throw new Error("Target revision has no situation body.");
  const bundle = situationBundleSchema.parse(job.targetRevision.bundleManifest);
  const validation = validateSituationBundle(bundle, body);
  if (!validation.valid || validation.bundleHash !== job.targetBundleHash)
    throw new Error(
      validation.errors.join(" ") || "Target bundle hash validation failed.",
    );

  const observed = await readOfficialLeadershipRelease(leadershipUrl);
  const observedTarget = observed.situations.find(
    (item) => item.slug === job.situation.slug,
  );
  const observedBundleHash = observedTarget
    ? stableObservedBundle(observedTarget, job.situation.id)
    : null;
  const decision = publicationConflictDecision({
    draftBaseBundleHash: job.baseBundleHash,
    observedTargetBundleHash: observedBundleHash,
    baseReleaseId: job.situation.productionReleaseId,
    observedReleaseId: observed.identity.releaseId,
  });
  if (decision.kind === "NEEDS_REFRESH") {
    throw new PublisherNeedsRefreshError({
      observedReleaseId: observed.identity.releaseId,
      observedBundleHash,
      baseBundleHash: job.baseBundleHash,
      expectedPointerGeneration: BigInt(observed.identity.generation),
    });
  }

  await event(studio, job.id, "POINTER_OBSERVED", {
    releaseId: observed.identity.releaseId,
    manifestHash: observed.identity.manifestHash,
    generation: observed.identity.generation,
  });
  if (decision.rebase)
    await event(studio, job.id, "REBASED", {
      fromReleaseId: job.situation.productionReleaseId,
      toReleaseId: observed.identity.releaseId,
    });

  const client = new Client({
    connectionString: leadershipUrl,
    application_name: "situation-studio-publisher-assembler",
    statement_timeout: 60_000,
  });
  await client.connect();
  try {
    const projection = await targetProjection(
      client,
      observed.identity.releaseId,
      job.situation.slug,
    );
    const completeSituationBody = situationFile({
      bundle,
      body,
      projection: {
        practiceId: projection.practice_id,
        practiceVariant: projection.practice_variant,
        fieldNotePresent: projection.field_note_present,
        safetyEscalationNotePresent: projection.safety_escalation_note_present,
        reviewStatus: projection.review_status,
        relatedSituationIds: projection.related_situation_ids,
        sourceReferences: projection.source_references,
      },
    });
    const manifest = manifestSchema.parse(observed.identity.manifest);
    const releaseId =
      job.candidateSnapshot?.releaseId ??
      job.leadershipReleaseId ??
      crypto.randomUUID();
    const targetLogicalId = `situation:${job.situation.slug}`;
    const targetHash = sha256(completeSituationBody);
    const targetBytes = new TextEncoder().encode(
      completeSituationBody,
    ).byteLength;
    const existingTarget = manifest.artifacts.find(
      (artifact) => artifact.logicalId === targetLogicalId,
    );
    const targetArtifact: ChangedArtifact = {
      logicalId: targetLogicalId,
      type: "SITUATION",
      path:
        existingTarget?.path ?? `content/situations/${job.situation.slug}.mdx`,
      contentHash: targetHash,
      byteLength: targetBytes,
      encoding: "UTF8",
      mediaType: "text/mdx; charset=utf-8",
      body: completeSituationBody,
      // The immutable primary artifact identity remains global across release
      // versions. Public routing is controlled by the release-scoped typed
      // situation visibility, not by mutating the artifact identity.
      visibility: "GLOBAL",
      ownerSituationSlug: null,
      forkedFromLogicalId: null,
      forkedFromContentHash: null,
    };
    const variants = await studio.scopedArtifactVariant.findMany({
      where: {
        ownerSituationId: job.situationId,
        logicalId: {
          in: bundle.artifacts.map((artifact) => artifact.logicalId),
        },
      },
      include: { content: true },
    });
    const changedVariants: ChangedArtifact[] = variants.map((variant) => {
      if (!variant.content.textBody)
        throw new Error(`Scoped variant ${variant.logicalId} is not UTF-8.`);
      const selectedMediaType = mediaType(variant.kind);
      return {
        logicalId: variant.logicalId,
        type: variant.kind,
        path: artifactPath(
          job.situation.slug,
          variant.kind,
          variant.logicalId,
          selectedMediaType,
        ),
        contentHash: variant.contentHash,
        byteLength: variant.content.byteLength,
        encoding: "UTF8",
        mediaType: selectedMediaType,
        body: variant.content.textBody,
        visibility: variant.visibility,
        ownerSituationSlug: job.situation.slug,
        forkedFromLogicalId: variant.forkedFromLogicalId,
        forkedFromContentHash: variant.forkedFromContentHash,
      };
    });
    const changedArtifacts = [targetArtifact, ...changedVariants];
    const changedIds = new Set(
      changedArtifacts.map((artifact) => artifact.logicalId),
    );
    const artifacts = [
      ...manifest.artifacts.filter(
        (artifact) => !changedIds.has(artifact.logicalId),
      ),
      ...changedArtifacts.map(({ body: _body, ...artifact }) => {
        const {
          visibility: _visibility,
          ownerSituationSlug: _owner,
          forkedFromLogicalId: _fork,
          forkedFromContentHash: _base,
          ...manifestArtifact
        } = artifact;
        return manifestArtifact;
      }),
    ].sort((left, right) => left.path.localeCompare(right.path));
    const carriedEdges = manifest.edges.filter(
      (edge) => edge.source !== targetLogicalId,
    );
    const situationEvidence = `content/situations/${job.situation.slug}.mdx`;
    const additionalEdges = [
      {
        source: targetLogicalId,
        target: `practice:${projection.practice_id}`,
        type: "EMBEDS_PRACTICE",
        evidence: `${situationEvidence}:practiceId`,
      },
      ...projection.related_situation_ids.map((relatedSlug) => ({
        source: targetLogicalId,
        target: `situation:${relatedSlug}`,
        type: "LINKS_TO",
        evidence: `${situationEvidence}:relatedSituationIds`,
      })),
      {
        source: targetLogicalId,
        target: "source:catalog",
        type: "CITES_SOURCE",
        evidence: `${situationEvidence}:sourceReferences=${projection.source_references.join(",")}`,
      },
      {
        source: targetLogicalId,
        target: "author:catalog",
        type: "LINKS_TO",
        evidence: `${situationEvidence}:author,reviewer`,
      },
      ...(projection.source_references.includes("one-on-one-lesson")
        ? [
            {
              source: targetLogicalId,
              target: "lesson-plan:003-manager-tools-the-trinity-and-1on1s",
              type: "TAUGHT_BY_LESSON",
              evidence: "sourceReferences:one-on-one-lesson",
            },
          ]
        : []),
    ];
    const edges = [...carriedEdges, ...additionalEdges].sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.type.localeCompare(right.type) ||
        left.target.localeCompare(right.target) ||
        left.evidence.localeCompare(right.evidence),
    );
    const candidateManifest: ReleaseManifest = {
      ...manifest,
      // New releases are always written under the behavior-complete policy
      // identity. Leadership continues to read the allowlisted legacy policy
      // during the Leadership-first transition.
      validationPolicyHash: leadershipValidationPolicyHash,
      source: {
        ...manifest.source,
        releaseId,
      },
      artifacts,
      edges,
    };
    const manifestBody = canonicalJson(candidateManifest);
    const candidate: CandidateSnapshot = {
      publicationId: job.publicationId,
      releaseId,
      parentReleaseId: observed.identity.releaseId,
      expectedGeneration: BigInt(observed.identity.generation),
      manifest: candidateManifest,
      manifestBody,
      manifestHash: sha256(manifestBody),
      artifactCount: artifacts.length,
      edgeCount: edges.length,
      totalByteLength: artifacts.reduce(
        (total, artifact) => total + BigInt(artifact.byteLength),
        0n,
      ),
      targetSlug: job.situation.slug,
      targetSituationId: job.situation.id,
      targetBody: body,
      targetBundle: bundleForPublication(bundle, job.sourceKind),
      sourceKind: job.sourceKind,
      changedArtifacts,
    };
    validateCandidate(candidate);
    await renewPublicationLease(studio, job.id, claimToken);
    await studio.publicationCandidateSnapshot.upsert({
      where: { jobId: job.id },
      create: {
        jobId: job.id,
        releaseId: candidate.releaseId,
        parentReleaseId: candidate.parentReleaseId,
        expectedPointerGeneration: candidate.expectedGeneration,
        manifestHash: candidate.manifestHash,
        manifestBody: candidate.manifestBody,
        artifactCount: candidate.artifactCount,
        edgeCount: candidate.edgeCount,
        totalByteLength: candidate.totalByteLength,
        assembly: jsonInput({
          targetSlug: candidate.targetSlug,
          targetBundleHash: job.targetBundleHash,
          changedArtifacts: candidate.changedArtifacts.map((artifact) => ({
            logicalId: artifact.logicalId,
            contentHash: artifact.contentHash,
            visibility: artifact.visibility,
          })),
          edgeHash: sha256(canonicalJson(candidate.manifest.edges)),
        }),
      },
      update: {
        releaseId: candidate.releaseId,
        parentReleaseId: candidate.parentReleaseId,
        expectedPointerGeneration: candidate.expectedGeneration,
        manifestHash: candidate.manifestHash,
        manifestBody: candidate.manifestBody,
        artifactCount: candidate.artifactCount,
        edgeCount: candidate.edgeCount,
        totalByteLength: candidate.totalByteLength,
        assembly: jsonInput({
          targetSlug: candidate.targetSlug,
          targetBundleHash: job.targetBundleHash,
          changedArtifacts: candidate.changedArtifacts.map((artifact) => ({
            logicalId: artifact.logicalId,
            contentHash: artifact.contentHash,
            visibility: artifact.visibility,
          })),
          edgeHash: sha256(canonicalJson(candidate.manifest.edges)),
        }),
      },
    });
    await event(studio, job.id, "SNAPSHOT_BUILT", {
      releaseId: candidate.releaseId,
      manifestHash: candidate.manifestHash,
      artifactCount: candidate.artifactCount,
      edgeCount: candidate.edgeCount,
    });
    await validateCanonicalCandidate(
      client,
      candidate,
      observed.identity.releaseId,
    );
    await renewPublicationLease(studio, job.id, claimToken);
    const transitioned = await studio.publicationJob.updateMany({
      where: {
        id: job.id,
        claimToken: claimToken ?? null,
        state: { in: ["REQUESTED", "ASSEMBLING", "PROMOTING"] },
      },
      data: {
        observedReleaseId: candidate.parentReleaseId,
        expectedPointerGeneration: candidate.expectedGeneration,
        leadershipReleaseId: candidate.releaseId,
        leadershipManifestHash: candidate.manifestHash,
        previousReleaseId: candidate.parentReleaseId,
        state: "PROMOTING",
      },
    });
    if (transitioned.count !== 1)
      throw new Error(
        "Publication authority was lost before promotion could begin.",
      );
    await event(studio, job.id, "VALIDATED", {
      targetBundleHash: job.targetBundleHash,
      manifestHash: candidate.manifestHash,
    });
    return candidate;
  } finally {
    await client.end();
  }
}

export function validateCandidate(candidate: CandidateSnapshot) {
  assertSafeManagedMdx(
    candidate.targetBody,
    `content/situations/${candidate.targetSlug}.mdx`,
  );
  const manifest = manifestSchema.parse(candidate.manifest);
  const leadershipManifest = leadershipSnapshotManifestSchema.parse(
    candidate.manifest,
  );
  if (
    leadershipManifest.validationPolicyHash !== leadershipValidationPolicyHash
  )
    throw new Error(
      "Candidate validation policy differs from the Leadership runtime.",
    );
  if (canonicalJson(manifest) !== candidate.manifestBody)
    throw new Error("Candidate manifest is not canonical.");
  if (sha256(candidate.manifestBody) !== candidate.manifestHash)
    throw new Error("Candidate manifest hash is not exact.");
  if (
    manifest.artifacts.length !== candidate.artifactCount ||
    manifest.edges.length !== candidate.edgeCount
  )
    throw new Error("Candidate release count metadata differs.");
  const edgeKeys = manifest.edges.map(
    (edge) => `${edge.source}\0${edge.type}\0${edge.target}`,
  );
  const sortedEdgeKeys = [...edgeKeys].sort((left, right) =>
    left.localeCompare(right),
  );
  if (edgeKeys.some((key, index) => key !== sortedEdgeKeys[index]))
    throw new Error("Candidate edges are not sorted canonically.");
  const logicalIds = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (logicalIds.has(artifact.logicalId))
      throw new Error(`Duplicate release artifact ${artifact.logicalId}.`);
    logicalIds.add(artifact.logicalId);
  }
  for (const edge of manifest.edges)
    if (!logicalIds.has(edge.source) || !logicalIds.has(edge.target))
      throw new Error(
        `Release edge ${edge.source} -> ${edge.target} is broken.`,
      );
  for (const changed of candidate.changedArtifacts) {
    if (sha256(canonicalText(changed.body)) !== changed.contentHash)
      throw new Error(`Changed artifact ${changed.logicalId} hash differs.`);
    if (
      changed.visibility !== "GLOBAL" &&
      (!changed.ownerSituationSlug ||
        !changed.forkedFromLogicalId ||
        !changed.forkedFromContentHash)
    )
      throw new Error(
        `Changed artifact ${changed.logicalId} lacks provenance.`,
      );
  }
  const bundleValidation = validateSituationBundle(
    candidate.targetBundle,
    candidate.targetBody,
  );
  if (!bundleValidation.valid)
    throw new Error(bundleValidation.errors.join(" "));
}

async function insertChangedArtifacts(
  client: PoolClient | Client,
  candidate: CandidateSnapshot,
) {
  const versionIds = new Map<string, string>();
  for (const artifact of candidate.changedArtifacts) {
    const identity = await client.query<{ id: string }>(
      `
        SELECT id
          FROM content_artifacts
         WHERE logical_id = $1
      `,
      [artifact.logicalId],
    );
    let artifactId = identity.rows[0]?.id;
    if (!artifactId) {
      artifactId = crypto.randomUUID();
      await client.query(
        `
          INSERT INTO content_artifacts (
            id,
            logical_id,
            type,
            canonical_path,
            visibility,
            owner_situation_slug,
            forked_from_logical_id,
            forked_from_content_hash
          ) VALUES (
            $1,
            $2,
            $3::"ArtifactType",
            $4,
            $5::"ArtifactVisibility",
            $6,
            $7,
            $8
          )
        `,
        [
          artifactId,
          artifact.logicalId,
          artifact.type,
          artifact.path,
          artifact.visibility,
          artifact.ownerSituationSlug,
          artifact.forkedFromLogicalId,
          artifact.forkedFromContentHash,
        ],
      );
    }
    const existingVersion = await client.query<{ id: string }>(
      `
        SELECT id
          FROM artifact_versions
         WHERE artifact_id = $1
           AND content_hash = $2
      `,
      [artifactId, artifact.contentHash],
    );
    let versionId = existingVersion.rows[0]?.id;
    if (!versionId) {
      versionId = crypto.randomUUID();
      await client.query(
        `
          INSERT INTO artifact_versions (
            id,
            artifact_id,
            content_hash,
            encoding,
            media_type,
            byte_length,
            text_body,
            binary_body
          ) VALUES (
            $1,
            $2,
            $3,
            'UTF8',
            $4,
            $5,
            $6,
            NULL
          )
        `,
        [
          versionId,
          artifactId,
          artifact.contentHash,
          artifact.mediaType,
          artifact.byteLength,
          canonicalText(artifact.body),
        ],
      );
    }
    versionIds.set(artifact.logicalId, versionId);
  }
  return versionIds;
}

async function cloneTypedProjection(
  client: PoolClient | Client,
  candidate: CandidateSnapshot,
) {
  const metadata = candidate.targetBundle.metadata;
  const visibility = candidate.targetBundle.visibility;
  const scopedOriginals = candidate.changedArtifacts
    .filter((artifact) => artifact.visibility !== "GLOBAL")
    .flatMap((artifact) =>
      artifact.forkedFromLogicalId ? [artifact.forkedFromLogicalId] : [],
    );
  const scopedPractice = candidate.changedArtifacts.find(
    (artifact) =>
      artifact.type === "PRACTICE" &&
      artifact.visibility === "SITUATION_SCOPED" &&
      artifact.forkedFromLogicalId,
  );
  const scopedPracticeId = scopedPractice?.forkedFromLogicalId
    ? physicalPracticeId(
        scopedPractice.forkedFromLogicalId.replace(/^practice:/u, ""),
        scopedPractice.contentHash,
      )
    : null;
  await executeStatements(
    client,
    `
      CREATE TEMP TABLE studio_situation_map (
        old_id UUID PRIMARY KEY,
        new_id UUID NOT NULL UNIQUE
      ) ON COMMIT DROP;
      CREATE TEMP TABLE studio_guide_map (
        old_id UUID PRIMARY KEY,
        new_id UUID NOT NULL UNIQUE
      ) ON COMMIT DROP;
      CREATE TEMP TABLE studio_practice_map (
        old_id UUID PRIMARY KEY,
        new_id UUID NOT NULL UNIQUE
      ) ON COMMIT DROP;
      CREATE TEMP TABLE studio_round_map (
        old_id UUID PRIMARY KEY,
        new_id UUID NOT NULL UNIQUE
      ) ON COMMIT DROP;
      CREATE TEMP TABLE studio_tool_map (
        old_id UUID PRIMARY KEY,
        new_id UUID NOT NULL UNIQUE
      ) ON COMMIT DROP;
      CREATE TEMP TABLE studio_source_map (
        old_id UUID PRIMARY KEY,
        new_id UUID NOT NULL UNIQUE
      ) ON COMMIT DROP;
      CREATE TEMP TABLE studio_collection_map (
        old_id UUID PRIMARY KEY,
        new_id UUID NOT NULL UNIQUE
      ) ON COMMIT DROP;

      INSERT INTO studio_situation_map
      SELECT id, gen_random_uuid()
        FROM situations
       WHERE release_id = $1;
      INSERT INTO studio_guide_map
      SELECT id, gen_random_uuid()
        FROM guides
       WHERE release_id = $1
         AND owner_situation_slug IS DISTINCT FROM $2;
      INSERT INTO studio_practice_map
      SELECT id, gen_random_uuid()
        FROM practices
       WHERE release_id = $1
         AND owner_situation_slug IS DISTINCT FROM $2;
      INSERT INTO studio_round_map
      SELECT round.id, gen_random_uuid()
        FROM practice_rounds round
        JOIN practices practice ON practice.id = round.practice_version_id
       WHERE practice.release_id = $1
         AND practice.owner_situation_slug IS DISTINCT FROM $2;
      INSERT INTO studio_tool_map
      SELECT id, gen_random_uuid()
        FROM tools
       WHERE release_id = $1;
      INSERT INTO studio_source_map
      SELECT id, gen_random_uuid()
        FROM sources
       WHERE release_id = $1
         AND owner_situation_slug IS DISTINCT FROM $2;
      INSERT INTO studio_collection_map
      SELECT id, gen_random_uuid()
        FROM curated_collections
       WHERE release_id = $1;
    `,
    [candidate.parentReleaseId, candidate.targetSlug],
  );

  await executeStatements(
    client,
    `
      INSERT INTO authors (
        id, release_id, author_id, position, name, role, bio
      )
      SELECT gen_random_uuid(), $2, author_id, position, name, role, bio
        FROM authors
       WHERE release_id = $1;

      INSERT INTO sources (
        id, release_id, source_id, position, title, url, publisher, note,
        visibility, owner_situation_slug, forked_from_logical_id,
        forked_from_content_hash
      )
      SELECT map.new_id, $2, source.source_id, source.position, source.title,
             source.url, source.publisher, source.note, source.visibility,
             source.owner_situation_slug, source.forked_from_logical_id,
             source.forked_from_content_hash
        FROM sources source
        JOIN studio_source_map map ON map.old_id = source.id;

      INSERT INTO practices (
        id, release_id, practice_id, title, description, estimated_time,
        visibility, owner_situation_slug, forked_from_logical_id,
        forked_from_content_hash
      )
      SELECT map.new_id, $2, practice.practice_id, practice.title,
             practice.description, practice.estimated_time,
             practice.visibility, practice.owner_situation_slug,
             practice.forked_from_logical_id,
             practice.forked_from_content_hash
        FROM practices practice
        JOIN studio_practice_map map ON map.old_id = practice.id;

      INSERT INTO practice_rounds (
        id, practice_version_id, round_id, position, setup, prompt
      )
      SELECT round_map.new_id, practice_map.new_id, round.round_id,
             round.position, round.setup, round.prompt
        FROM practice_rounds round
        JOIN studio_round_map round_map ON round_map.old_id = round.id
        JOIN studio_practice_map practice_map
          ON practice_map.old_id = round.practice_version_id;

      INSERT INTO practice_choices (
        id, round_id, choice_id, position, label, consequence_id,
        consequence, explanation, signal
      )
      SELECT gen_random_uuid(), round_map.new_id, choice.choice_id,
             choice.position, choice.label, choice.consequence_id,
             choice.consequence, choice.explanation, choice.signal
        FROM practice_choices choice
        JOIN studio_round_map round_map ON round_map.old_id = choice.round_id;

      INSERT INTO tools (
        id, release_id, tool_id, title, description, time
      )
      SELECT map.new_id, $2, tool.tool_id, tool.title, tool.description,
             tool.time
        FROM tools tool
        JOIN studio_tool_map map ON map.old_id = tool.id;

      INSERT INTO tool_fields (
        id, tool_version_id, field_id, position, label, prompt, placeholder,
        rows, type
      )
      SELECT gen_random_uuid(), map.new_id, field.field_id, field.position,
             field.label, field.prompt, field.placeholder, field.rows,
             field.type
        FROM tool_fields field
        JOIN studio_tool_map map ON map.old_id = field.tool_version_id;
    `,
    [candidate.parentReleaseId, candidate.releaseId],
  );

  const targetExists = await client.query(
    `
      SELECT 1
        FROM situations
       WHERE release_id = $1
         AND slug = $2
    `,
    [candidate.parentReleaseId, candidate.targetSlug],
  );
  await executeStatements(
    client,
    `
      INSERT INTO situations (
        id, release_id, slug, title, description, stakes, primary_skill,
        preparation_time, emotional_load, pattern, scope, published,
        last_reviewed, author_id, reviewer_id, practice_id, practice_variant,
        field_note_present, safety_escalation_note_present, social_hook,
        campaign_cluster, review_status, body_mdx, visibility,
        studio_situation_id
      )
      SELECT
        map.new_id,
        $2,
        situation.slug,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'title' ELSE situation.title END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'description' ELSE situation.description END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'stakes' ELSE situation.stakes END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'primarySkill' ELSE situation.primary_skill END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'preparationTime' ELSE situation.preparation_time END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'emotionalLoad' ELSE situation.emotional_load END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'pattern' ELSE situation.pattern END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'scope' ELSE situation.scope END,
        CASE WHEN situation.slug = $3 THEN ($4::jsonb->>'published')::date ELSE situation.published END,
        CASE WHEN situation.slug = $3 THEN ($4::jsonb->>'lastReviewed')::date ELSE situation.last_reviewed END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'author' ELSE situation.author_id END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'reviewer' ELSE situation.reviewer_id END,
        CASE
          WHEN situation.slug = $3 AND $8::text IS NOT NULL THEN $8
          ELSE situation.practice_id
        END,
        CASE
          WHEN situation.slug = $3 AND $8::text IS NOT NULL
            THEN 'situation-scoped'
          ELSE situation.practice_variant
        END,
        situation.field_note_present,
        situation.safety_escalation_note_present,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'socialHook' ELSE situation.social_hook END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'campaignCluster' ELSE situation.campaign_cluster END,
        situation.review_status,
        CASE WHEN situation.slug = $3 THEN $5 ELSE situation.body_mdx END,
        CASE WHEN situation.slug = $3 THEN $6::"SituationVisibility" ELSE situation.visibility END,
        CASE WHEN situation.slug = $3 THEN $7::uuid ELSE situation.studio_situation_id END
        FROM situations situation
        JOIN studio_situation_map map ON map.old_id = situation.id;
    `,
    [
      candidate.parentReleaseId,
      candidate.releaseId,
      candidate.targetSlug,
      JSON.stringify(metadata),
      candidate.targetBody,
      visibility,
      candidate.targetSituationId,
      scopedPracticeId,
    ],
  );
  if (!targetExists.rowCount) {
    const defaultPractice =
      scopedPracticeId ??
      candidate.targetBundle.relationships
        .find((relationship) => relationship.kind === "PRACTICE")
        ?.logicalId.replace(/^practice:/u, "") ??
      "listen-first";
    await client.query(
      `
        INSERT INTO situations (
          id, release_id, slug, title, description, stakes, primary_skill,
          preparation_time, emotional_load, pattern, scope, published,
          last_reviewed, author_id, reviewer_id, practice_id, practice_variant,
          field_note_present, safety_escalation_note_present, social_hook,
          campaign_cluster, review_status, body_mdx, visibility,
          studio_situation_id
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11::date, $12::date, $13, $14, $15, 'default', true, true, $16,
          $17, 'human-approved', $18, $19::"SituationVisibility", $20::uuid
        )
      `,
      [
        candidate.releaseId,
        metadata.slug,
        metadata.title,
        metadata.description,
        metadata.stakes,
        metadata.primarySkill,
        metadata.preparationTime,
        metadata.emotionalLoad,
        metadata.pattern,
        metadata.scope,
        metadata.published,
        metadata.lastReviewed,
        metadata.author,
        metadata.reviewer,
        defaultPractice,
        metadata.socialHook,
        metadata.campaignCluster,
        candidate.targetBody,
        visibility,
        candidate.targetSituationId,
      ],
    );
  }

  await executeStatements(
    client,
    `
      INSERT INTO situation_tags (situation_id, position, value)
      SELECT map.new_id, tag.position, tag.value
        FROM situation_tags tag
        JOIN studio_situation_map map ON map.old_id = tag.situation_id
        JOIN situations original ON original.id = tag.situation_id
       WHERE original.slug <> $3;
      INSERT INTO situation_audiences (situation_id, position, value)
      SELECT map.new_id, audience.position, audience.value
        FROM situation_audiences audience
        JOIN studio_situation_map map ON map.old_id = audience.situation_id
        JOIN situations original ON original.id = audience.situation_id
       WHERE original.slug <> $3;
      INSERT INTO situation_support (situation_id, position, value)
      SELECT map.new_id, support.position, support.value
        FROM situation_support support
        JOIN studio_situation_map map ON map.old_id = support.situation_id
        JOIN situations original ON original.id = support.situation_id
       WHERE original.slug <> $3;

      INSERT INTO situation_tags (situation_id, position, value)
      SELECT target.id, item.ordinality - 1, item.value
        FROM situations target,
             jsonb_array_elements_text($4::jsonb->'tags')
               WITH ORDINALITY AS item(value, ordinality)
       WHERE target.release_id = $2 AND target.slug = $3;
      INSERT INTO situation_audiences (situation_id, position, value)
      SELECT target.id, item.ordinality - 1, item.value
        FROM situations target,
             jsonb_array_elements_text($4::jsonb->'audience')
               WITH ORDINALITY AS item(value, ordinality)
       WHERE target.release_id = $2 AND target.slug = $3;
      INSERT INTO situation_support (situation_id, position, value)
      SELECT target.id, item.ordinality - 1, item.value
        FROM situations target,
             jsonb_array_elements_text($4::jsonb->'support')
               WITH ORDINALITY AS item(value, ordinality)
       WHERE target.release_id = $2 AND target.slug = $3;

      INSERT INTO situation_relations (
        source_situation_id, target_situation_id, position
      )
      SELECT source_map.new_id, target_map.new_id, relation.position
        FROM situation_relations relation
        JOIN studio_situation_map source_map
          ON source_map.old_id = relation.source_situation_id
        JOIN studio_situation_map target_map
          ON target_map.old_id = relation.target_situation_id;

      INSERT INTO situation_source_references (
        situation_id, source_id, position
      )
      SELECT situation_map.new_id, source_map.new_id, reference.position
        FROM situation_source_references reference
        JOIN studio_situation_map situation_map
          ON situation_map.old_id = reference.situation_id
        JOIN studio_source_map source_map
          ON source_map.old_id = reference.source_id
        JOIN situations original_situation
          ON original_situation.id = reference.situation_id
        JOIN sources original_source
          ON original_source.id = reference.source_id
       WHERE NOT (
         original_situation.slug = $3
         AND ('source:' || original_source.source_id) = ANY($5::varchar[])
       );
    `,
    [
      candidate.parentReleaseId,
      candidate.releaseId,
      candidate.targetSlug,
      JSON.stringify(metadata),
      scopedOriginals,
    ],
  );

  await executeStatements(
    client,
    `
      INSERT INTO guides (
        id, release_id, slug, title, description, eyebrow, practice_id,
        published, last_reviewed, author_id, reviewer_id, review_status,
        body_mdx, visibility, owner_situation_slug, forked_from_logical_id,
        forked_from_content_hash
      )
      SELECT map.new_id, $2, guide.slug, guide.title, guide.description,
             guide.eyebrow, guide.practice_id, guide.published,
             guide.last_reviewed, guide.author_id, guide.reviewer_id,
             guide.review_status, guide.body_mdx, guide.visibility,
             guide.owner_situation_slug, guide.forked_from_logical_id,
             guide.forked_from_content_hash
        FROM guides guide
        JOIN studio_guide_map map ON map.old_id = guide.id;
      INSERT INTO guide_situations (guide_id, situation_id, position)
      SELECT guide_map.new_id, situation_map.new_id, membership.position
        FROM guide_situations membership
        JOIN studio_guide_map guide_map ON guide_map.old_id = membership.guide_id
        JOIN studio_situation_map situation_map
          ON situation_map.old_id = membership.situation_id
        JOIN guides original_guide ON original_guide.id = membership.guide_id
        JOIN situations original_situation
          ON original_situation.id = membership.situation_id
       WHERE NOT (
         original_situation.slug = $3
         AND ('guide:' || original_guide.slug) = ANY($4::varchar[])
       );

      INSERT INTO promotion_packets (
        id, release_id, slug, status, canonical, social_drafts,
        scenario_question, pull_quote_idea, utm, og_preview
      )
      SELECT gen_random_uuid(), $2, packet.slug, packet.status,
             packet.canonical, packet.social_drafts, packet.scenario_question,
             packet.pull_quote_idea, packet.utm, packet.og_preview
        FROM promotion_packets packet
       WHERE packet.release_id = $1
         AND packet.slug <> $3;

      INSERT INTO curated_collections (
        id, release_id, collection_id, title
      )
      SELECT map.new_id, $2, collection.collection_id, collection.title
        FROM curated_collections collection
        JOIN studio_collection_map map ON map.old_id = collection.id;
      INSERT INTO curated_collection_items (
        id, collection_id, item_key, position, label, title, note, href,
        tone, metadata
      )
      SELECT gen_random_uuid(), map.new_id, item.item_key, item.position,
             item.label, item.title, item.note, item.href, item.tone,
             item.metadata
        FROM curated_collection_items item
        JOIN studio_collection_map map ON map.old_id = item.collection_id;

      INSERT INTO situation_artifact_bindings (
        id, release_id, situation_slug, artifact_type, original_logical_id,
        resolved_logical_id, visibility, position
      )
      SELECT gen_random_uuid(), $2, binding.situation_slug,
             binding.artifact_type, binding.original_logical_id,
             binding.resolved_logical_id, binding.visibility, binding.position
        FROM situation_artifact_bindings binding
       WHERE binding.release_id = $1
         AND binding.situation_slug <> $3;
    `,
    [
      candidate.parentReleaseId,
      candidate.releaseId,
      candidate.targetSlug,
      scopedOriginals,
    ],
  );

  const promotion =
    Object.keys(candidate.targetBundle.promotion).length > 0
      ? candidate.targetBundle.promotion
      : {
          status: "human-review-required",
          canonical: `/situations/${candidate.targetSlug}`,
          socialDrafts: [metadata.socialHook],
          scenarioQuestion: `What would you do next in ${metadata.title}?`,
          pullQuoteIdea: metadata.socialHook,
          utm: {
            campaign: metadata.campaignCluster,
            content: candidate.targetSlug.replaceAll("-", "_"),
          },
          ogPreview: `/situations/${candidate.targetSlug}/opengraph-image`,
        };
  if (visibility === "PUBLIC")
    await client.query(
      `
        INSERT INTO promotion_packets (
          id, release_id, slug, status, canonical, social_drafts,
          scenario_question, pull_quote_idea, utm, og_preview
        ) VALUES (
          gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9
        )
      `,
      [
        candidate.releaseId,
        candidate.targetSlug,
        String(promotion.status ?? "human-review-required"),
        String(promotion.canonical ?? `/situations/${candidate.targetSlug}`),
        JSON.stringify(promotion.socialDrafts ?? [metadata.socialHook]),
        String(
          promotion.scenarioQuestion ??
            `What would you do next in ${metadata.title}?`,
        ),
        String(promotion.pullQuoteIdea ?? metadata.socialHook),
        JSON.stringify(
          promotion.utm ?? {
            campaign: metadata.campaignCluster,
            content: candidate.targetSlug.replaceAll("-", "_"),
          },
        ),
        String(
          promotion.ogPreview ??
            `/situations/${candidate.targetSlug}/opengraph-image`,
        ),
      ],
    );

  await insertScopedProjection(client, candidate);
}

async function insertScopedProjection(
  client: PoolClient | Client,
  candidate: CandidateSnapshot,
) {
  const target = await client.query<{ id: string }>(
    `
      SELECT id
        FROM situations
       WHERE release_id = $1
         AND slug = $2
    `,
    [candidate.releaseId, candidate.targetSlug],
  );
  const targetId = target.rows[0]?.id;
  if (!targetId) throw new Error("Candidate target projection is absent.");
  let bindingPosition = 0;
  for (const variant of candidate.changedArtifacts.filter(
    (artifact) => artifact.visibility !== "GLOBAL",
  )) {
    if (
      !variant.forkedFromLogicalId ||
      !variant.forkedFromContentHash ||
      !variant.ownerSituationSlug
    )
      throw new Error(
        `Scoped projection ${variant.logicalId} lacks provenance.`,
      );
    await client.query(
      `
        INSERT INTO situation_artifact_bindings (
          id, release_id, situation_slug, artifact_type, original_logical_id,
          resolved_logical_id, visibility, position
        ) VALUES (
          gen_random_uuid(), $1, $2, $3::"ArtifactType", $4, $5,
          $6::"ArtifactVisibility", $7
        )
      `,
      [
        candidate.releaseId,
        candidate.targetSlug,
        variant.type,
        variant.forkedFromLogicalId,
        variant.logicalId,
        variant.visibility,
        bindingPosition++,
      ],
    );
    if (variant.type === "PRACTICE") {
      const practice = scopedPracticeSchema.parse(JSON.parse(variant.body));
      const practiceId = crypto.randomUUID();
      const projectedPracticeId = physicalPracticeId(
        variant.forkedFromLogicalId.replace(/^practice:/u, ""),
        variant.contentHash,
      );
      await client.query(
        `
          INSERT INTO practices (
            id, release_id, practice_id, title, description, estimated_time,
            visibility, owner_situation_slug, forked_from_logical_id,
            forked_from_content_hash
          ) VALUES (
            $1, $2, $3, $4, $5, $6, 'SITUATION_SCOPED', $7, $8, $9
          )
        `,
        [
          practiceId,
          candidate.releaseId,
          projectedPracticeId,
          practice.title,
          practice.description,
          practice.estimatedTime,
          candidate.targetSlug,
          variant.forkedFromLogicalId,
          variant.forkedFromContentHash,
        ],
      );
      for (const [roundPosition, round] of practice.rounds.entries()) {
        const roundId = crypto.randomUUID();
        await client.query(
          `
            INSERT INTO practice_rounds (
              id, practice_version_id, round_id, position, setup, prompt
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            roundId,
            practiceId,
            round.id,
            roundPosition,
            round.setup,
            round.prompt,
          ],
        );
        for (const [choicePosition, choice] of round.choices.entries())
          await client.query(
            `
              INSERT INTO practice_choices (
                id, round_id, choice_id, position, label, consequence_id,
                consequence, explanation, signal
              ) VALUES (
                gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7,
                $8::"PracticeSignal"
              )
            `,
            [
              roundId,
              choice.id,
              choicePosition,
              choice.label,
              choice.consequenceId,
              choice.consequence,
              choice.explanation,
              choice.signal,
            ],
          );
      }
    } else if (variant.type === "SOURCE") {
      const parsed = JSON.parse(variant.body) as unknown;
      const source = scopedSourceSchema.parse(
        Array.isArray(parsed) ? parsed[0] : parsed,
      );
      const position = await client.query<{ position: number }>(
        `
          SELECT COALESCE(max(position), -1) + 1 AS position
            FROM sources
           WHERE release_id = $1
        `,
        [candidate.releaseId],
      );
      const sourceId = crypto.randomUUID();
      const projectedSourceId = `${variant.forkedFromLogicalId.replace(/^source:/u, "").slice(0, 138)}--${variant.contentHash.slice(0, 12)}`;
      await client.query(
        `
          INSERT INTO sources (
            id, release_id, source_id, position, title, url, publisher, note,
            visibility, owner_situation_slug, forked_from_logical_id,
            forked_from_content_hash
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, 'SITUATION_SCOPED', $9, $10, $11
          )
        `,
        [
          sourceId,
          candidate.releaseId,
          projectedSourceId,
          position.rows[0]?.position ?? 0,
          source.title,
          source.url,
          source.publisher,
          source.note,
          candidate.targetSlug,
          variant.forkedFromLogicalId,
          variant.forkedFromContentHash,
        ],
      );
      const referencePosition = await client.query<{ position: number }>(
        `
          SELECT COALESCE(max(position), -1) + 1 AS position
            FROM situation_source_references
           WHERE situation_id = $1
        `,
        [targetId],
      );
      await client.query(
        `
          INSERT INTO situation_source_references (
            situation_id, source_id, position
          ) VALUES ($1, $2, $3)
        `,
        [targetId, sourceId, referencePosition.rows[0]?.position ?? 0],
      );
    } else if (variant.type === "GUIDE") {
      const originalSlug = variant.forkedFromLogicalId.replace(/^guide:/u, "");
      const original = await client.query<{
        title: string;
        description: string;
        eyebrow: string;
        practice_id: string;
        published: Date;
        last_reviewed: Date;
        author_id: string;
        reviewer_id: string;
        review_status: string;
      }>(
        `
          SELECT title, description, eyebrow, practice_id, published,
                 last_reviewed, author_id, reviewer_id, review_status
            FROM guides
           WHERE release_id = $1
             AND slug = $2
             AND visibility = 'GLOBAL'
        `,
        [candidate.releaseId, originalSlug],
      );
      const base = original.rows[0];
      if (!base) throw new Error(`Original guide ${originalSlug} is absent.`);
      const guideId = crypto.randomUUID();
      const scopedSlug = `${originalSlug}-for-${candidate.targetSlug}-${variant.contentHash.slice(0, 8)}`;
      await client.query(
        `
          INSERT INTO guides (
            id, release_id, slug, title, description, eyebrow, practice_id,
            published, last_reviewed, author_id, reviewer_id, review_status,
            body_mdx, visibility, owner_situation_slug,
            forked_from_logical_id, forked_from_content_hash
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            'SITUATION_SCOPED', $14, $15, $16
          )
        `,
        [
          guideId,
          candidate.releaseId,
          scopedSlug,
          base.title,
          base.description,
          base.eyebrow,
          base.practice_id,
          base.published,
          base.last_reviewed,
          base.author_id,
          base.reviewer_id,
          base.review_status,
          variant.body,
          candidate.targetSlug,
          variant.forkedFromLogicalId,
          variant.forkedFromContentHash,
        ],
      );
      const guidePosition = await client.query<{ position: number }>(
        `
          SELECT COALESCE(max(position), -1) + 1 AS position
            FROM guide_situations
           WHERE situation_id = $1
        `,
        [targetId],
      );
      await client.query(
        `
          INSERT INTO guide_situations (guide_id, situation_id, position)
          VALUES ($1, $2, $3)
        `,
        [guideId, targetId, guidePosition.rows[0]?.position ?? 0],
      );
    }
  }
}

async function insertAndPromote(
  client: Client,
  candidate: CandidateSnapshot,
  authority: {
    beforePromotion: () => Promise<void>;
    beforeCommit: () => Promise<void>;
  },
) {
  await client.query("BEGIN");
  try {
    const existing = await client.query<{
      id: string;
      manifest_hash: string;
      state: string;
    }>(
      `
        SELECT id, manifest_hash, state::text
          FROM content_releases
         WHERE studio_publication_id = $1
      `,
      [candidate.publicationId],
    );
    const existingRelease = existing.rows[0];
    if (existingRelease) {
      if (
        existingRelease.id !== candidate.releaseId ||
        existingRelease.manifest_hash !== candidate.manifestHash
      )
        throw new Error("Publication id maps to a different release.");
      const pointer = await client.query<{
        release_id: string;
        generation: string;
      }>(
        `
          SELECT release_id, generation::text
            FROM current_release
           WHERE id = 'official'
        `,
      );
      const current = pointer.rows[0];
      if (current?.release_id === candidate.releaseId) {
        await client.query("COMMIT");
        return { inserted: false };
      }
      if (
        existingRelease.state !== "VALIDATED" ||
        !current ||
        current.release_id !== candidate.parentReleaseId ||
        BigInt(current.generation) !== candidate.expectedGeneration
      ) {
        await client.query("ROLLBACK");
        return { inserted: false, pointerChanged: true };
      }
      await authority.beforePromotion();
      await client.query(
        `
          SELECT *
            FROM leadership_studio_promote_release(
              $1, $2, $3, $4::char(64), $5::varchar(240)
            )
        `,
        [
          candidate.releaseId,
          candidate.publicationId,
          candidate.expectedGeneration.toString(),
          candidate.manifestHash,
          `Situation Studio publication retry ${candidate.publicationId}`,
        ],
      );
      await authority.beforeCommit();
      await client.query("COMMIT");
      return { inserted: false };
    }
    const pointer = await client.query<{
      release_id: string;
      generation: string;
    }>(
      `
        SELECT release_id, generation::text
          FROM current_release
         WHERE id = 'official'
      `,
    );
    const current = pointer.rows[0];
    if (
      !current ||
      current.release_id !== candidate.parentReleaseId ||
      BigInt(current.generation) !== candidate.expectedGeneration
    ) {
      await client.query("ROLLBACK");
      return { inserted: false, pointerChanged: true };
    }
    await client.query(
      `
        INSERT INTO content_releases (
          id, parent_release_id, state, schema_version,
          validation_policy_hash, manifest, manifest_hash, source_kind,
          legacy_source_id, artifact_count, edge_count, total_byte_length,
          studio_publication_id, studio_provenance
        ) VALUES (
          $1, $2, 'STAGED', $3, $4, $5, $6, 'SITUATION_STUDIO', NULL,
          $7, $8, $9, $10, $11::jsonb
        )
      `,
      [
        candidate.releaseId,
        candidate.parentReleaseId,
        candidate.manifest.schemaVersion,
        candidate.manifest.validationPolicyHash,
        candidate.manifestBody,
        candidate.manifestHash,
        candidate.artifactCount,
        candidate.edgeCount,
        candidate.totalByteLength.toString(),
        candidate.publicationId,
        JSON.stringify({
          publicationId: candidate.publicationId,
          situationId: candidate.targetSituationId,
          situationSlug: candidate.targetSlug,
          bundleHash: bundleHash(candidate.targetBundle),
          sourceKind: candidate.sourceKind,
          contractVersion: candidate.targetBundle.contractVersion,
          validationPolicyVersion:
            candidate.targetBundle.validationPolicyVersion,
        }),
      ],
    );
    const versionIds = await insertChangedArtifacts(client, candidate);
    const changedIds = new Set(
      candidate.changedArtifacts.map((item) => item.logicalId),
    );
    const existingMemberships = await client.query<{
      artifact_version_id: string;
      logical_id: string;
      canonical_path: string;
      type: string;
      content_hash: string;
      byte_length: number;
      sort_order: number;
    }>(
      `
        SELECT artifact_version_id, logical_id, canonical_path, type::text,
               content_hash, byte_length, sort_order
          FROM release_artifacts
         WHERE release_id = $1
         ORDER BY sort_order
      `,
      [candidate.parentReleaseId],
    );
    const memberships = [
      ...existingMemberships.rows.filter(
        (membership) => !changedIds.has(membership.logical_id),
      ),
      ...candidate.changedArtifacts.map((artifact) => ({
        artifact_version_id: versionIds.get(artifact.logicalId) ?? "",
        logical_id: artifact.logicalId,
        canonical_path: artifact.path,
        type: artifact.type,
        content_hash: artifact.contentHash,
        byte_length: artifact.byteLength,
        sort_order: 0,
      })),
    ].sort((left, right) =>
      left.canonical_path.localeCompare(right.canonical_path),
    );
    for (const [sortOrder, membership] of memberships.entries())
      await client.query(
        `
          INSERT INTO release_artifacts (
            release_id, artifact_version_id, logical_id, canonical_path, type,
            content_hash, byte_length, sort_order
          ) VALUES ($1, $2, $3, $4, $5::"ArtifactType", $6, $7, $8)
        `,
        [
          candidate.releaseId,
          membership.artifact_version_id,
          membership.logical_id,
          membership.canonical_path,
          membership.type,
          membership.content_hash,
          membership.byte_length,
          sortOrder,
        ],
      );
    for (const edge of candidate.manifest.edges)
      await client.query(
        `
          INSERT INTO content_edges (
            id, release_id, source_logical_id, target_logical_id, type, evidence
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4::"ContentEdgeType", $5
          )
        `,
        [
          candidate.releaseId,
          edge.source,
          edge.target,
          edge.type,
          edge.evidence,
        ],
      );
    await cloneTypedProjection(client, candidate);
    await client.query(
      `
        SELECT *
          FROM leadership_studio_validate_release($1, $2, $3::char(64))
      `,
      [candidate.releaseId, candidate.publicationId, candidate.manifestHash],
    );
    await authority.beforePromotion();
    await client.query(
      `
        SELECT *
          FROM leadership_studio_promote_release(
            $1, $2, $3, $4::char(64), $5::varchar(240)
          )
      `,
      [
        candidate.releaseId,
        candidate.publicationId,
        candidate.expectedGeneration.toString(),
        candidate.manifestHash,
        `Situation Studio publication ${candidate.publicationId}`,
      ],
    );
    await authority.beforeCommit();
    await client.query("COMMIT");
    return { inserted: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function databaseIdentity(client: Client) {
  const result = await client.query<{
    release_id: string;
    manifest_hash: string;
    generation: string;
  }>(`
    SELECT pointer.release_id,
           release.manifest_hash,
           pointer.generation::text
      FROM current_release pointer
      JOIN content_releases release ON release.id = pointer.release_id
     WHERE pointer.id = 'official'
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Leadership official pointer is absent.");
  return {
    releaseId: row.release_id,
    manifestHash: row.manifest_hash,
    generation: BigInt(row.generation),
  };
}

export async function reconcilePublicationRecovery(
  dependencies: PublisherDependencies,
) {
  const recoveries = await dependencies.studio.publicationJob.findMany({
    where: { state: "RECOVERY_REQUIRED" },
    orderBy: { createdAt: "asc" },
    include: {
      candidateSnapshot: true,
      targetRevision: { select: { actorId: true } },
    },
  });
  if (!recoveries.length) return 0;
  const leadership = new Client({
    connectionString: dependencies.leadershipPublisherUrl,
    application_name: "situation-studio-publisher-recovery-reconciler",
    statement_timeout: 30_000,
  });
  try {
    await leadership.connect();
  } catch {
    return 0;
  }
  let reconciled = 0;
  try {
    for (const recovery of recoveries) {
      const snapshot = recovery.candidateSnapshot;
      if (!snapshot) continue;
      const restored = await databaseIdentity(leadership);
      if (restored.releaseId !== snapshot.parentReleaseId) continue;
      let runtime: RuntimeIdentity;
      try {
        runtime = await convergedRuntimeIdentity(dependencies, {
          releaseId: restored.releaseId,
          manifestHash: restored.manifestHash,
        });
      } catch {
        continue;
      }
      if (
        !identityMatches(runtime, {
          releaseId: restored.releaseId,
          manifestHash: restored.manifestHash,
        })
      )
        continue;
      const reconciledAt = new Date();
      const changed = await dependencies.studio.$transaction(
        async (transaction) => {
          await lockPublicationCoordination(transaction);
          const updated = await transaction.publicationJob.updateMany({
            where: { id: recovery.id, state: "RECOVERY_REQUIRED" },
            data: {
              state: "RESTORED",
              finishedAt: reconciledAt,
              failureCode: "VERIFICATION_FAILED_RESTORED",
              claimToken: null,
              leaseExpiresAt: null,
            },
          });
          if (updated.count !== 1) return false;
          await transaction.publicationAttempt.updateMany({
            where: { jobId: recovery.id, finishedAt: null },
            data: {
              finishedAt: reconciledAt,
              failureCode: "PUBLICATION_RECOVERY_RECONCILED",
              reconciledState: jsonInput({
                outcome: "RESTORED",
                reconciledAfterRuntimeConvergence: true,
              }),
            },
          });
          const aggregate = await transaction.publicationEvent.aggregate({
            where: { jobId: recovery.id },
            _max: { sequence: true },
          });
          await transaction.publicationEvent.create({
            data: {
              jobId: recovery.id,
              sequence: (aggregate._max.sequence ?? 0) + 1,
              kind: "RESTORED",
              payload: jsonInput({
                releaseId: restored.releaseId,
                manifestHash: restored.manifestHash,
                generation: restored.generation.toString(),
                reconciledAfterRuntimeConvergence: true,
              }),
            },
          });
          await transaction.auditEvent.create({
            data: {
              actorId: recovery.targetRevision.actorId,
              action: "PUBLICATION_RECOVERY_RECONCILED",
              subjectType: "PUBLICATION_JOB",
              subjectId: recovery.id,
              payload: {
                releaseId: restored.releaseId,
                manifestHash: restored.manifestHash,
                pointerGeneration: restored.generation.toString(),
              },
            },
          });
          return true;
        },
        { isolationLevel: "Serializable" },
      );
      if (changed) reconciled += 1;
    }
  } finally {
    await leadership.end();
  }
  return reconciled;
}

async function restorePrevious(
  client: Client,
  candidate: CandidateSnapshot,
  promotedGeneration: bigint,
) {
  await client.query(
    `
      SELECT *
        FROM leadership_studio_restore_release(
          $1, $2, $3, $4, $5::varchar(240)
        )
    `,
    [
      candidate.releaseId,
      candidate.parentReleaseId,
      candidate.publicationId,
      promotedGeneration.toString(),
      `Automatic restoration after verification failure ${candidate.publicationId}`,
    ],
  );
}

async function finalizeSuccess(
  studio: DatabaseClient,
  job: ClaimedJob,
  attemptId: string,
  claimToken: string | undefined,
  candidate: CandidateSnapshot,
  identity: { releaseId: string; manifestHash: string; generation: bigint },
  runtime: RuntimeIdentity,
  capabilities: LeadershipRuntimeCapabilities,
  routeProof: RuntimeRouteProof,
  producerCommit: string,
  beforeCommit?: () => Promise<void>,
) {
  const productionBundleHash = bundleHash(candidate.targetBundle);
  await studio.$transaction(
    async (transaction) => {
      await lockPublicationCoordination(transaction);
      const currentJob = await transaction.publicationJob.findUniqueOrThrow({
        where: { id: job.id },
      });
      const [checkout, situation] = await Promise.all([
        transaction.situationCheckout.findUnique({
          where: { id: job.checkoutId },
          select: { fence: true, releasedAt: true },
        }),
        transaction.situation.findUnique({
          where: { id: job.situationId },
          select: { fence: true },
        }),
      ]);
      if (
        currentJob.checkoutFence !== job.checkoutFence ||
        currentJob.state !== "VERIFYING" ||
        currentJob.claimToken !== (claimToken ?? null) ||
        !checkout ||
        checkout.releasedAt ||
        checkout.fence !== job.checkoutFence ||
        !situation ||
        situation.fence !== job.checkoutFence
      )
        throw new Error("Late publisher result was fenced.");
      const observation =
        (await transaction.leadershipReleaseObservation.findUnique({
          where: { releaseId: candidate.releaseId },
        })) ??
        (await transaction.leadershipReleaseObservation.create({
          data: {
            releaseId: candidate.releaseId,
            manifestHash: candidate.manifestHash,
            pointerGeneration: identity.generation,
            state: "OFFICIAL",
            sourceKind: "SITUATION_STUDIO",
            manifest: jsonInput(candidate.manifest),
            publishedAt: new Date(),
          },
        }));
      const version = await transaction.productionSituationVersion.create({
        data: {
          situationId: job.situationId,
          observationId: observation.id,
          bundleHash: productionBundleHash,
          bundleManifest: jsonInput(candidate.targetBundle),
          contractVersion: candidate.targetBundle.contractVersion,
          validationPolicy: candidate.targetBundle.validationPolicyVersion,
          sourceKind: job.sourceKind,
          actorId: job.targetRevision.actorId,
          productionAt: new Date(),
          changeSummary: `${job.sourceKind.replaceAll("_", " ")} publication from Situation Studio`,
          restorationParentId: job.restorationParentId,
          artifacts: {
            create: [
              {
                logicalId: `situation:${candidate.targetSlug}`,
                kind: "SITUATION",
                visibility: "GLOBAL",
                contentHash: candidate.targetBundle.bodyHash,
                position: 0,
                metadata: { role: "primary-body" },
              },
              ...candidate.targetBundle.relationships.map(
                (relationship, index) => ({
                  logicalId: relationship.logicalId,
                  kind: relationship.kind as ArtifactKind,
                  visibility: relationship.visibility,
                  contentHash: relationship.contentHash,
                  position: index + 1,
                  metadata: {
                    role: "connected-context",
                    relationshipPosition: relationship.position,
                    forkedFromLogicalId:
                      candidate.changedArtifacts.find(
                        (artifact) =>
                          artifact.logicalId === relationship.logicalId,
                      )?.forkedFromLogicalId ?? null,
                    forkedFromContentHash:
                      candidate.changedArtifacts.find(
                        (artifact) =>
                          artifact.logicalId === relationship.logicalId,
                      )?.forkedFromContentHash ?? null,
                  },
                }),
              ),
            ],
          },
        },
      });
      await transaction.situation.update({
        where: { id: job.situationId },
        data: {
          title: candidate.targetBundle.metadata.title,
          visibility: candidate.targetBundle.visibility,
          productionBundleHash: version.bundleHash,
          productionReleaseId: candidate.releaseId,
          productionAt: version.productionAt,
        },
      });
      await transaction.verificationReceipt.create({
        data: {
          jobId: job.id,
          expectedReleaseId: candidate.releaseId,
          expectedManifestHash: candidate.manifestHash,
          observedDatabaseReleaseId: identity.releaseId,
          observedDatabaseHash: identity.manifestHash,
          observedRuntimeReleaseId: runtime.releaseId,
          observedRuntimeHash: runtime.manifestHash,
          pointerGeneration: identity.generation,
          producerCommit,
          producerContractDigest: requiredContentContractIdentity.packageSha256,
          consumerCommit: capabilities.deployment.commit,
          capabilityDigest: capabilities.capabilityDigest,
          affectedSituationSlug: candidate.targetSlug,
          typedParityCode: leadershipTypedParityPredicate,
          routeProbeCode: routeProof.code,
          routeHttpStatus: routeProof.httpStatus,
          observedRouteReleaseId: routeProof.observedReleaseId,
          observedRouteManifestHash: routeProof.observedManifestHash,
          observedSituationBodyHash: routeProof.observedSituationBodyHash,
          observedPracticeLogicalId: routeProof.observedPracticeLogicalId,
          observedPracticeContentHash: routeProof.observedPracticeContentHash,
        },
      });
      const released = await transaction.situationCheckout.updateMany({
        where: {
          id: job.checkoutId,
          fence: job.checkoutFence,
          releasedAt: null,
        },
        data: { releasedAt: new Date(), releaseReason: "PUBLISHED" },
      });
      if (released.count !== 1)
        throw new Error("Publication checkout release was fenced.");
      await transaction.draft.update({
        where: { id: job.targetRevision.draftId },
        data: { state: "ARCHIVED", archivedAt: new Date() },
      });
      const completedJob = await transaction.publicationJob.updateMany({
        where: {
          id: job.id,
          state: "VERIFYING",
          claimToken: claimToken ?? null,
        },
        data: {
          state: "SUCCEEDED",
          finishedAt: new Date(),
          failureCode: null,
          claimToken: null,
          leaseExpiresAt: null,
        },
      });
      if (completedJob.count !== 1)
        throw new Error("Publication authority was lost during finalization.");
      await transaction.backupReceipt.create({
        data: {
          publicationJobId: job.id,
          destinationId: "configured-encrypted-backup",
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: job.targetRevision.actorId,
          action: "PUBLICATION_SUCCEEDED",
          subjectType: "PUBLICATION_JOB",
          subjectId: job.id,
          payload: {
            releaseId: candidate.releaseId,
            manifestHash: candidate.manifestHash,
            pointerGeneration: identity.generation.toString(),
            capabilityDigest: capabilities.capabilityDigest,
            typedParityCode: leadershipTypedParityPredicate,
            routeProbeCode: routeProof.code,
          },
        },
      });
      await beforeCommit?.();
      await appendPublicationEvent(transaction, job.id, "VERIFIED", {
        releaseId: identity.releaseId,
        manifestHash: identity.manifestHash,
        runtimeReleaseId: runtime.releaseId,
        runtimeManifestHash: runtime.manifestHash,
        capabilityDigest: capabilities.capabilityDigest,
        typedParityCode: leadershipTypedParityPredicate,
        routeProbeCode: routeProof.code,
        routeHttpStatus: routeProof.httpStatus,
      });
      await appendPublicationEvent(transaction, job.id, "SUCCEEDED", {
        releaseId: candidate.releaseId,
      });
      await transaction.publicationAttempt.update({
        where: { id: attemptId },
        data: {
          finishedAt: new Date(),
          failureCode: null,
          reconciledState: jsonInput({
            outcome: "SUCCEEDED",
            releaseId: candidate.releaseId,
            manifestHash: candidate.manifestHash,
          }),
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
}

async function candidateFromPersisted(
  studio: DatabaseClient,
  leadershipUrl: string,
  job: ClaimedJob,
  options: { validate?: boolean } = {},
) {
  const snapshot = job.candidateSnapshot;
  if (!snapshot) return buildCandidate(studio, leadershipUrl, job);
  const body = job.targetRevision.artifacts.find(
    (artifact) => artifact.kind === "SITUATION",
  )?.content.textBody;
  if (!body) throw new Error("Persisted publication lost its Studio body.");
  const bundle = bundleForPublication(
    situationBundleSchema.parse(job.targetRevision.bundleManifest),
    job.sourceKind,
  );
  const leadership = new Client({
    connectionString: leadershipUrl,
    application_name: "situation-studio-publisher-reconciler",
    statement_timeout: 30_000,
  });
  await leadership.connect();
  try {
    const rows = await leadership.query<{
      logical_id: string;
      type: string;
      canonical_path: string;
      content_hash: string;
      byte_length: number;
      encoding: "UTF8" | "BINARY";
      media_type: string;
      text_body: string | null;
      visibility: "GLOBAL" | "SITUATION_SCOPED" | "INTERNAL";
      owner_situation_slug: string | null;
      forked_from_logical_id: string | null;
      forked_from_content_hash: string | null;
    }>(
      `
        SELECT membership.logical_id,
               membership.type::text,
               membership.canonical_path,
               membership.content_hash,
               membership.byte_length,
               version.encoding::text,
               version.media_type,
               version.text_body,
               artifact.visibility::text,
               artifact.owner_situation_slug,
               artifact.forked_from_logical_id,
               artifact.forked_from_content_hash
          FROM release_artifacts membership
          JOIN artifact_versions version
            ON version.id = membership.artifact_version_id
          JOIN content_artifacts artifact
            ON artifact.id = version.artifact_id
         WHERE membership.release_id = $1
           AND (
             membership.logical_id = $2
             OR membership.logical_id = ANY($3::varchar[])
           )
      `,
      [
        snapshot.releaseId,
        `situation:${job.situation.slug}`,
        bundle.artifacts.map((artifact) => artifact.logicalId),
      ],
    );
    if (!rows.rowCount) {
      if (options.validate === false)
        throw new Error("Persisted candidate release artifacts are absent.");
      return buildCandidate(studio, leadershipUrl, job);
    }
    const changedArtifacts: ChangedArtifact[] = rows.rows.map((row) => {
      if (row.encoding !== "UTF8" || row.text_body === null)
        throw new Error(`Publication artifact ${row.logical_id} is not UTF-8.`);
      return {
        logicalId: row.logical_id,
        type: row.type,
        path: row.canonical_path,
        contentHash: row.content_hash,
        byteLength: row.byte_length,
        encoding: row.encoding,
        mediaType: row.media_type,
        body: row.text_body,
        visibility: row.visibility,
        ownerSituationSlug: row.owner_situation_slug,
        forkedFromLogicalId: row.forked_from_logical_id,
        forkedFromContentHash: row.forked_from_content_hash,
      };
    });
    const manifest = manifestSchema.parse(JSON.parse(snapshot.manifestBody));
    const candidate: CandidateSnapshot = {
      publicationId: job.publicationId,
      releaseId: snapshot.releaseId,
      parentReleaseId: snapshot.parentReleaseId,
      expectedGeneration: snapshot.expectedPointerGeneration,
      manifest,
      manifestBody: snapshot.manifestBody,
      manifestHash: snapshot.manifestHash,
      artifactCount: snapshot.artifactCount,
      edgeCount: snapshot.edgeCount,
      totalByteLength: snapshot.totalByteLength,
      targetSlug: job.situation.slug,
      targetSituationId: job.situationId,
      targetBody: body,
      targetBundle: bundle,
      sourceKind: job.sourceKind,
      changedArtifacts,
    };
    if (options.validate !== false) {
      validateCandidate(candidate);
      await validateCanonicalCandidate(
        leadership,
        candidate,
        snapshot.releaseId,
      );
    }
    return candidate;
  } finally {
    await leadership.end();
  }
}

function safePublicationFailureDetail(error: unknown) {
  if (!(error instanceof PublisherRuntimeConvergenceError)) return null;
  const parsed = publicationFailureDetailSchema.safeParse(error.failureDetail);
  return parsed.success ? parsed.data : null;
}

function publicationFailureCode(error: unknown) {
  if (error instanceof LeadershipCapabilityError) return error.code;
  if (error instanceof PublisherCandidateContractError) return error.code;
  if (error instanceof PublisherRuntimeConvergenceError) return error.code;
  if (error instanceof PublisherVerificationError) return error.code;
  if (
    error instanceof Error &&
    /TYPED_PROJECTION_INVALID/iu.test(error.message)
  )
    return "TYPED_PROJECTION_INVALID";
  if (error instanceof Error && /fenced|lease|checkout/iu.test(error.message))
    return "PUBLICATION_AUTHORITY_LOST";
  return "PUBLICATION_FAILED";
}

function restoredPublicationFailureCode(failureCode: string) {
  if (failureCode === "AFFECTED_ROUTE_VERIFICATION_FAILED")
    return "AFFECTED_ROUTE_VERIFICATION_FAILED_RESTORED";
  if (
    failureCode === "RUNTIME_HEALTH_UNAVAILABLE" ||
    failureCode === "RUNTIME_HEALTH_INVALID_RESPONSE" ||
    failureCode === "RUNTIME_IDENTITY_MISMATCH"
  )
    return `${failureCode}_RESTORED`;
  if (
    failureCode === "RUNTIME_CAPABILITY_UNAVAILABLE" ||
    failureCode === "UNSUPPORTED_VERSION_PAIR" ||
    failureCode === "UNSUPPORTED_CONTRACT_IDENTITY"
  )
    return `${failureCode}_RESTORED`;
  return "VERIFICATION_FAILED_RESTORED";
}

async function terminalizePublicationOutcome(
  studio: DatabaseClient,
  input: {
    jobId: string;
    attemptId: string;
    state: "NEEDS_REFRESH" | "RESTORED" | "RECOVERY_REQUIRED" | "FAILED";
    jobFailureCode: string;
    finishJob: boolean;
    eventKind: PublicationEventKind;
    eventPayload: Record<string, unknown>;
    attemptFailureCode: string | null;
    reconciledState: Record<string, unknown>;
    observedReleaseId?: string;
    expectedPointerGeneration?: bigint;
    claimToken?: string;
    expectedStates: Array<
      | "REQUESTED"
      | "ASSEMBLING"
      | "PROMOTING"
      | "VERIFYING"
      | "RECOVERY_REQUIRED"
    >;
  },
) {
  const finishedAt = new Date();
  await studio.$transaction(
    async (transaction) => {
      await lockPublicationCoordination(transaction);
      const updated = await transaction.publicationJob.updateMany({
        where: {
          id: input.jobId,
          claimToken: input.claimToken ?? null,
          state: { in: input.expectedStates },
        },
        data: {
          state: input.state,
          finishedAt: input.finishJob ? finishedAt : undefined,
          failureCode: input.jobFailureCode,
          claimToken: null,
          leaseExpiresAt: null,
          observedReleaseId: input.observedReleaseId,
          expectedPointerGeneration: input.expectedPointerGeneration,
        },
      });
      if (updated.count !== 1)
        throw new Error(
          "Publication authority was lost before terminal state could be recorded.",
        );
      await appendPublicationEvent(
        transaction,
        input.jobId,
        input.eventKind,
        input.eventPayload,
      );
      await transaction.publicationAttempt.update({
        where: { id: input.attemptId },
        data: {
          finishedAt,
          failureCode: input.attemptFailureCode,
          reconciledState: jsonInput(input.reconciledState),
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
}

async function beginAutomaticRestoration(
  studio: DatabaseClient,
  input: {
    jobId: string;
    previousReleaseId: string | null;
    reason: string;
    failureDetail: PublicationFailureDetail | null;
    claimToken?: string;
  },
) {
  await studio.$transaction(
    async (transaction) => {
      await lockPublicationCoordination(transaction);
      const updated = await transaction.publicationJob.updateMany({
        where: {
          id: input.jobId,
          claimToken: input.claimToken ?? null,
          state: { in: ["PROMOTING", "VERIFYING"] },
        },
        data: {
          state: "RECOVERY_REQUIRED",
          failureCode: "AUTOMATIC_RESTORATION_IN_PROGRESS",
        },
      });
      if (updated.count !== 1)
        throw new Error(
          "Publication authority was lost before restoration could begin.",
        );
      await appendPublicationEvent(
        transaction,
        input.jobId,
        "RESTORE_STARTED",
        {
          previousReleaseId: input.previousReleaseId,
          reason: input.reason,
          ...(input.failureDetail
            ? { failureDetail: input.failureDetail }
            : {}),
        },
      );
    },
    { isolationLevel: "Serializable" },
  );
}

export async function processPublicationJob(
  dependencies: PublisherDependencies,
  jobId: string,
  claimToken?: string,
) {
  const { studio, leadershipPublisherUrl } = dependencies;
  await renewPublicationLease(studio, jobId, claimToken);
  const started = await startPublicationAttempt(studio, jobId, claimToken);
  let job = started.job;
  const { attempt } = started;
  const leadership = new Client({
    connectionString: leadershipPublisherUrl,
    application_name: "situation-studio-publisher",
    statement_timeout: 120_000,
  });
  let promoted = false;
  let promotionAttempted = false;
  let activeCandidate: CandidateSnapshot | null = null;
  let activeCapabilities: LeadershipRuntimeCapabilities | null = null;
  try {
    await leadership.connect();
    const external = await leadership.query<{
      id: string;
      manifest_hash: string;
      state: string;
    }>(
      `
        SELECT id, manifest_hash, state::text
          FROM content_releases
         WHERE studio_publication_id = $1
      `,
      [job.publicationId],
    );
    const existing = external.rows[0];
    let candidate: CandidateSnapshot | null = null;
    if (existing && job.candidateSnapshot) {
      if (
        existing.id !== job.candidateSnapshot.releaseId ||
        existing.manifest_hash !== job.candidateSnapshot.manifestHash
      )
        throw new Error("Reconciled publication release differs from Studio.");
      const observed = await databaseIdentity(leadership);
      promoted =
        observed.releaseId === job.candidateSnapshot.releaseId &&
        observed.manifestHash === job.candidateSnapshot.manifestHash;
      candidate = await candidateFromPersisted(
        studio,
        leadershipPublisherUrl,
        job,
      );
      if (
        existing.id !== candidate?.releaseId ||
        existing.manifest_hash !== candidate?.manifestHash
      )
        throw new Error("Reconciled publication release differs from Studio.");
      activeCandidate = candidate;
    }
    if (!/^[a-f0-9]{40}$/u.test(dependencies.producerCommit))
      throw new Error(
        "The publisher deployment commit is not an immutable Git identity.",
      );
    if (!dependencies.runtimeCapabilities)
      throw new LeadershipCapabilityError(
        "Leadership runtime capabilities are not configured.",
        "RUNTIME_CAPABILITY_UNAVAILABLE",
        true,
      );
    activeCapabilities = assertLeadershipRuntimeCompatible(
      await dependencies.runtimeCapabilities(),
    );
    if (!candidate)
      candidate = await buildCandidate(
        studio,
        leadershipPublisherUrl,
        job,
        claimToken,
      );
    activeCandidate = candidate;
    await dependencies.afterBoundary?.("CANDIDATE_PERSISTED");
    await renewPublicationLease(studio, jobId, claimToken);
    await assertPublicationFence(studio, {
      jobId,
      situationId: job.situationId,
      checkoutId: job.checkoutId,
      checkoutFence: job.checkoutFence,
      claimToken,
    });

    const before = await databaseIdentity(leadership);
    if (before.releaseId !== candidate.releaseId) {
      promotionAttempted = true;
      const insertion = await withPublicationLeaseHeartbeat(
        studio,
        {
          jobId,
          situationId: job.situationId,
          checkoutId: job.checkoutId,
          checkoutFence: job.checkoutFence,
          claimToken,
          heartbeatMs: dependencies.publicationLeaseHeartbeatMs,
        },
        (assertAuthority) =>
          insertAndPromote(leadership, candidate, {
            beforePromotion: async () => {
              await dependencies.afterBoundary?.("LEADERSHIP_PROMOTION_READY");
              await assertAuthority();
            },
            beforeCommit: async () => {
              await dependencies.afterBoundary?.(
                "LEADERSHIP_PROMOTION_COMMIT_READY",
              );
              await assertAuthority();
            },
          }),
      );
      if (insertion.pointerChanged) {
        // No candidate rows committed. Re-observe and automatically rebase on
        // the next durable attempt.
        await studio.$transaction(
          async (transaction) => {
            await lockPublicationCoordination(transaction);
            await transaction.publicationCandidateSnapshot.delete({
              where: { jobId },
            });
            const rebased = await transaction.publicationJob.updateMany({
              where: {
                id: jobId,
                state: "PROMOTING",
                claimToken: claimToken ?? null,
              },
              data: {
                state: "ASSEMBLING",
                leadershipReleaseId: null,
                leadershipManifestHash: null,
                expectedPointerGeneration: null,
                observedReleaseId: null,
                claimToken: null,
                leaseExpiresAt: null,
              },
            });
            if (rebased.count !== 1)
              throw new Error(
                "Publication authority was lost before pointer rebase.",
              );
            await transaction.publicationAttempt.update({
              where: { id: attempt.id },
              data: {
                finishedAt: new Date(),
                reconciledState: jsonInput({
                  outcome: "POINTER_REBASE_RETRY",
                }),
              },
            });
          },
          { isolationLevel: "Serializable" },
        );
        return;
      }
      await dependencies.afterBoundary?.("LEADERSHIP_PROMOTION_COMMITTED");
      await event(studio, jobId, "RELEASE_INSERTED", {
        releaseId: candidate.releaseId,
        manifestHash: candidate.manifestHash,
        inserted: insertion.inserted,
      });
    }
    const promotedIdentity = await databaseIdentity(leadership);
    promoted =
      promotedIdentity.releaseId === candidate.releaseId &&
      promotedIdentity.manifestHash === candidate.manifestHash;
    if (!promoted)
      throw new Error("Leadership promotion did not select the candidate.");
    await dependencies.afterBoundary?.("LEADERSHIP_PROMOTED");
    await renewPublicationLease(studio, jobId, claimToken);
    const verifying = await studio.publicationJob.updateMany({
      where: {
        id: jobId,
        state: { in: ["PROMOTING", "VERIFYING"] },
        claimToken: claimToken ?? null,
      },
      data: {
        state: "VERIFYING",
        leaseExpiresAt: new Date(Date.now() + 180_000),
      },
    });
    if (verifying.count !== 1)
      throw new Error(
        "Publication authority was lost before verification could begin.",
      );
    await event(studio, jobId, "POINTER_ADVANCED", {
      releaseId: promotedIdentity.releaseId,
      manifestHash: promotedIdentity.manifestHash,
      generation: promotedIdentity.generation.toString(),
    });
    const runtime = await convergedRuntimeIdentity(
      dependencies,
      {
        releaseId: candidate.releaseId,
        manifestHash: candidate.manifestHash,
      },
      () => renewPublicationLease(studio, jobId, claimToken),
    );
    if (!dependencies.runtimeRouteProof)
      throw new PublisherVerificationError(
        "Affected-route verification is not configured.",
        "AFFECTED_ROUTE_VERIFICATION_FAILED",
      );
    const routeCapabilitiesBefore = assertLeadershipRuntimeCompatible(
      await dependencies.runtimeCapabilities(),
    );
    const routeProof = await dependencies.runtimeRouteProof(
      routeExpectation(candidate),
    );
    const routeCapabilitiesAfter = assertLeadershipRuntimeCompatible(
      await dependencies.runtimeCapabilities(),
    );
    if (
      routeCapabilitiesBefore.deployment.commit !==
        routeCapabilitiesAfter.deployment.commit ||
      routeCapabilitiesBefore.capabilityDigest !==
        routeCapabilitiesAfter.capabilityDigest
    )
      throw new LeadershipCapabilityError(
        "Leadership runtime capabilities changed during affected-route verification.",
        "RUNTIME_CAPABILITY_UNAVAILABLE",
        true,
      );
    activeCapabilities = routeCapabilitiesAfter;
    await dependencies.afterBoundary?.("RUNTIME_VERIFIED");
    await renewPublicationLease(studio, jobId, claimToken);
    job = await loadJob(studio, jobId);
    await finalizeSuccess(
      studio,
      job,
      attempt.id,
      claimToken,
      candidate,
      promotedIdentity,
      runtime,
      activeCapabilities,
      routeProof,
      dependencies.producerCommit,
      async () => {
        await dependencies.afterBoundary?.("STUDIO_SUCCESS_FINALIZING");
      },
    );
    await dependencies.afterBoundary?.("STUDIO_SUCCESS_COMMITTED");
  } catch (error) {
    if (error instanceof PublisherCrashInjectionError) throw error;
    if (error instanceof PublisherNeedsRefreshError) {
      await terminalizePublicationOutcome(studio, {
        jobId,
        attemptId: attempt.id,
        state: "NEEDS_REFRESH",
        jobFailureCode: "TARGET_CHANGED",
        finishJob: true,
        eventKind: "CONFLICTED",
        eventPayload: {
          observedReleaseId: error.detail.observedReleaseId,
          observedBundleHash: error.detail.observedBundleHash,
          baseBundleHash: error.detail.baseBundleHash,
        },
        attemptFailureCode: null,
        reconciledState: { outcome: "NEEDS_REFRESH" },
        observedReleaseId: error.detail.observedReleaseId,
        expectedPointerGeneration: error.detail.expectedPointerGeneration,
        claimToken,
        expectedStates: ["REQUESTED", "ASSEMBLING", "PROMOTING"],
      });
      return;
    }
    const failureCode = publicationFailureCode(error);
    if (failureCode === "PUBLICATION_AUTHORITY_LOST") {
      dependencies.onFailure?.(error);
      throw error;
    }
    const failureDetail = safePublicationFailureDetail(error);
    let recoveryFailureDetail: PublicationFailureDetail | null = null;
    let authoritativeJobReloaded = false;
    if (!(error instanceof PublisherCandidateContractError)) {
      try {
        job = await loadJob(studio, jobId);
        authoritativeJobReloaded = true;
      } catch {
        // A failed authoritative reload cannot make a possibly committed
        // Leadership promotion safe to classify as a normal failure.
      }
    }
    if (promoted && !authoritativeJobReloaded) {
      dependencies.onFailure?.(error);
      throw error;
    }
    const committedCandidate = activeCandidate ?? job.candidateSnapshot;
    const studioSuccessCommitted =
      promoted &&
      job.state === "SUCCEEDED" &&
      Boolean(committedCandidate) &&
      job.receipt?.expectedReleaseId === committedCandidate?.releaseId &&
      job.receipt?.expectedManifestHash === committedCandidate?.manifestHash;
    if (studioSuccessCommitted) return;
    if (promoted && job.state === "SUCCEEDED") {
      dependencies.onFailure?.(error);
      throw new Error(
        "Studio reports publication success without matching verification evidence.",
        { cause: error },
      );
    }
    dependencies.onFailure?.(error);
    const promotionStateUnverified =
      !promoted &&
      !(error instanceof PublisherCandidateContractError) &&
      (promotionAttempted ||
        (Boolean(job.candidateSnapshot) &&
          (job.state === "PROMOTING" || job.state === "VERIFYING")) ||
        (!authoritativeJobReloaded && Boolean(activeCandidate)));
    if (promoted) {
      const snapshot = job.candidateSnapshot;
      if (!snapshot)
        throw new Error("Promoted job has no candidate snapshot.", {
          cause: error,
        });
      await beginAutomaticRestoration(studio, {
        jobId,
        previousReleaseId: job.previousReleaseId,
        reason: failureCode,
        failureDetail,
        claimToken,
      });
      let restored: Awaited<ReturnType<typeof databaseIdentity>>;
      try {
        const current = await databaseIdentity(leadership);
        const candidate =
          activeCandidate ??
          (await candidateFromPersisted(studio, leadershipPublisherUrl, job, {
            validate: false,
          }));
        if (!candidate)
          throw new Error("Candidate disappeared during recovery.");
        await restorePrevious(leadership, candidate, current.generation);
        restored = await databaseIdentity(leadership);
        const runtime = await convergedRuntimeIdentity(
          dependencies,
          {
            releaseId: restored.releaseId,
            manifestHash: restored.manifestHash,
          },
          () => renewPublicationLease(studio, jobId, claimToken),
        );
        if (
          restored.releaseId !== candidate.parentReleaseId ||
          runtime.releaseId !== candidate.parentReleaseId ||
          restored.manifestHash !== runtime.manifestHash
        )
          throw new Error("Prior official release could not be verified.");
      } catch (restorationError) {
        recoveryFailureDetail = safePublicationFailureDetail(restorationError);
        await terminalizePublicationOutcome(studio, {
          jobId,
          attemptId: attempt.id,
          state: "RECOVERY_REQUIRED",
          jobFailureCode: "AUTOMATIC_RESTORATION_FAILED",
          finishJob: false,
          eventKind: "RECOVERY_REQUIRED",
          eventPayload: {
            failureCode: "AUTOMATIC_RESTORATION_FAILED",
            ...(failureDetail ? { failureDetail } : {}),
            ...(recoveryFailureDetail ? { recoveryFailureDetail } : {}),
          },
          attemptFailureCode: "POST_PROMOTION_VERIFICATION",
          reconciledState: {
            failureCode,
            promoted,
            promotionAttempted,
            authoritativeJobReloaded,
            promotionStateUnverified,
            ...(failureDetail ? { failureDetail } : {}),
            ...(recoveryFailureDetail ? { recoveryFailureDetail } : {}),
          },
          claimToken,
          expectedStates: ["RECOVERY_REQUIRED"],
        });
        return;
      }
      await terminalizePublicationOutcome(studio, {
        jobId,
        attemptId: attempt.id,
        state: "RESTORED",
        jobFailureCode: restoredPublicationFailureCode(failureCode),
        finishJob: true,
        eventKind: "RESTORED",
        eventPayload: {
          releaseId: restored.releaseId,
          manifestHash: restored.manifestHash,
          generation: restored.generation.toString(),
        },
        attemptFailureCode: "POST_PROMOTION_VERIFICATION",
        reconciledState: {
          failureCode,
          promoted,
          promotionAttempted,
          authoritativeJobReloaded,
          promotionStateUnverified,
          ...(failureDetail ? { failureDetail } : {}),
        },
        claimToken,
        expectedStates: ["RECOVERY_REQUIRED"],
      });
    } else if (promotionStateUnverified) {
      await terminalizePublicationOutcome(studio, {
        jobId,
        attemptId: attempt.id,
        state: "RECOVERY_REQUIRED",
        jobFailureCode: "PROMOTION_STATE_UNVERIFIED",
        finishJob: false,
        eventKind: "RECOVERY_REQUIRED",
        eventPayload: {
          failureCode: "PROMOTION_STATE_UNVERIFIED",
          ...(failureDetail ? { failureDetail } : {}),
        },
        attemptFailureCode: "PROMOTION_STATE_UNVERIFIED",
        reconciledState: {
          failureCode,
          promoted,
          promotionAttempted,
          authoritativeJobReloaded,
          promotionStateUnverified,
          ...(failureDetail ? { failureDetail } : {}),
        },
        claimToken,
        expectedStates: ["REQUESTED", "ASSEMBLING", "PROMOTING", "VERIFYING"],
      });
    } else {
      await terminalizePublicationOutcome(studio, {
        jobId,
        attemptId: attempt.id,
        state: "FAILED",
        jobFailureCode: failureCode,
        finishJob: true,
        eventKind: "FAILED",
        eventPayload: {
          failureCode,
          ...(failureDetail ? { failureDetail } : {}),
        },
        attemptFailureCode: failureCode,
        reconciledState: {
          failureCode,
          promoted,
          promotionAttempted,
          authoritativeJobReloaded,
          promotionStateUnverified,
          ...(failureDetail ? { failureDetail } : {}),
        },
        claimToken,
        expectedStates: ["REQUESTED", "ASSEMBLING", "PROMOTING", "VERIFYING"],
      });
    }
  } finally {
    await leadership.end().catch(() => undefined);
  }
}

export async function runtimeIdentityFromHealth(
  healthUrl: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RuntimeIdentity> {
  const requestTimeoutMs = Math.max(
    1,
    Math.min(10_000, Math.floor(options.timeoutMs ?? 5_000)),
  );
  const requestSignal = AbortSignal.timeout(requestTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, requestSignal])
    : requestSignal;
  let response: Response;
  try {
    response = await fetch(healthUrl, {
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal,
    });
  } catch {
    throw new PublisherRuntimeHealthError("UNAVAILABLE", null);
  }
  if (!response.ok)
    throw new PublisherRuntimeHealthError("HTTP_STATUS", response.status);
  const parsed = z
    .object({
      officialSnapshotId: z.uuid(),
      officialSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .safeParse(await response.json().catch(() => null));
  if (!parsed.success)
    throw new PublisherRuntimeHealthError("INVALID_RESPONSE", null);
  return {
    releaseId: parsed.data.officialSnapshotId,
    manifestHash: parsed.data.officialSnapshotHash,
  };
}
