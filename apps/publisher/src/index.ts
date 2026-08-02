import { Client, type PoolClient, type QueryResultRow } from "pg";
import {
  Prisma,
  type ArtifactKind,
  type DatabaseClient,
  type PublicationEventKind,
} from "@situation-studio/db";
import {
  PUBLICATION_COMPILER_DIGEST,
  PUBLICATION_COMPILER_IDENTITY,
  physicalPracticeId,
  publishableManagedComponentsSchema,
  publishablePromotionSchema,
  publishableSituationFrontmatterSchema,
  publishableSituationRelationshipSchema,
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
  compilePublishableSituationSnapshot,
  publicationConflictDecision,
  publicationFailureDetailSchema,
  publishableSituationBundleSchema,
  scopedPracticeSchema,
  scopedSourceSchema,
  sha256,
  situationBundleSchema,
  toPublishableSituationSnapshot,
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

type ExactCandidateArtifact = ManifestArtifact & {
  bytes: Uint8Array;
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
  allArtifacts?: ExactCandidateArtifact[];
  candidateHash?: string;
  compilerDigest?: string;
  compiledProjection?: PersistedCompiledProjection;
  affectedRoutes?: RuntimeRouteExpectation[];
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
  pointerGeneration?: string;
  routePath?: string;
  verificationPath?: string;
  expectedRouteStatus?: 200 | 404;
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
    readonly retryable = false,
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
    | "PREPARED_ACTION_MISMATCH"
    | "PREFLIGHT_REQUIRED";

  constructor(cause: unknown) {
    super(
      "The assembled Leadership snapshot does not satisfy the canonical content contract.",
      { cause },
    );
    this.name = "PublisherCandidateContractError";
    const detail = cause instanceof Error ? cause.message : "";
    this.code = /PREFLIGHT_REQUIRED/iu.test(detail)
      ? "PREFLIGHT_REQUIRED"
      : /PracticeEmbed does not match frontmatter/iu.test(detail)
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
  /** Test-only fault boundary for a lost response after Leadership COMMIT. */
  afterPromotionCommit?: () => Promise<void>;
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

async function convergedRuntimeCapabilities(
  dependencies: Pick<
    PublisherDependencies,
    "runtimeCapabilities" | "runtimeVerification"
  >,
  beforeProbe?: () => Promise<void>,
) {
  if (!dependencies.runtimeCapabilities)
    throw new LeadershipCapabilityError(
      "Leadership runtime capabilities are not configured.",
      "RUNTIME_CAPABILITY_UNAVAILABLE",
      true,
    );
  const attempts = Math.max(
    1,
    Math.floor(dependencies.runtimeVerification?.attempts ?? 24),
  );
  const intervalMs = Math.max(
    0,
    Math.floor(dependencies.runtimeVerification?.intervalMs ?? 500),
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await beforeProbe?.();
      return assertLeadershipRuntimeCompatible(
        await dependencies.runtimeCapabilities(),
      );
    } catch (error) {
      lastError = error;
      if (error instanceof LeadershipCapabilityError && !error.retryable)
        throw error;
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw (
    lastError ??
    new LeadershipCapabilityError(
      "Leadership runtime capabilities remained unavailable.",
      "RUNTIME_CAPABILITY_UNAVAILABLE",
      true,
    )
  );
}

async function convergedRuntimeRouteProof(
  dependencies: Pick<
    PublisherDependencies,
    "runtimeRouteProof" | "runtimeVerification"
  >,
  expected: RuntimeRouteExpectation,
  beforeProbe?: () => Promise<void>,
) {
  if (!dependencies.runtimeRouteProof)
    throw new PublisherVerificationError(
      "Affected-route verification is not configured.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const attempts = Math.max(
    1,
    Math.floor(dependencies.runtimeVerification?.attempts ?? 24),
  );
  const intervalMs = Math.max(
    0,
    Math.floor(dependencies.runtimeVerification?.intervalMs ?? 500),
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await beforeProbe?.();
      return await dependencies.runtimeRouteProof(expected);
    } catch (error) {
      lastError = error;
      if (error instanceof PublisherVerificationError && !error.retryable)
        throw error;
    }
    if (attempt + 1 < attempts)
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw (
    lastError ??
    new PublisherVerificationError(
      "The affected Leadership verification endpoint remained unavailable.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
      true,
    )
  );
}

function routeExpectation(
  candidate: CandidateSnapshot,
): RuntimeRouteExpectation {
  const compiled = candidate.affectedRoutes?.find(
    (route) => route.situationSlug === candidate.targetSlug,
  );
  if (compiled) return compiled;
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

/**
 * Legacy HTML proof reader retained for historic receipts. New publications
 * verify the typed, no-store JSON contract below.
 */
export async function runtimeRouteProofFromVerificationEndpoint(
  healthUrl: string,
  expected: RuntimeRouteExpectation,
): Promise<RuntimeRouteProof> {
  const verificationUrl = new URL(
    expected.verificationPath ??
      `/api/v1/verification/${encodeURIComponent(expected.situationSlug)}`,
    healthUrl,
  );
  let response: Response;
  try {
    response = await fetch(verificationUrl, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new PublisherVerificationError(
      "The affected Leadership verification endpoint was unavailable.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
      true,
    );
  }
  if (!response.ok)
    throw new PublisherVerificationError(
      `The affected Leadership verification endpoint returned HTTP ${response.status}.`,
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
      response.status === 404 || response.status >= 500,
    );
  if (
    !response.headers.get("cache-control")?.toLowerCase().includes("no-store")
  )
    throw new PublisherVerificationError(
      "The affected Leadership verification endpoint was cacheable.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new PublisherVerificationError(
      "The affected Leadership verification endpoint did not return JSON.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const parsed = affectedRouteProofSchema.safeParse(
    await response.json().catch(() => null),
  );
  if (!parsed.success)
    throw new PublisherVerificationError(
      "The affected Leadership verification endpoint returned an invalid typed proof.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const proof = parsed.data;
  const expectedGeneration = expected.pointerGeneration;
  const identityIsStale =
    proof.releaseId !== expected.releaseId ||
    proof.manifestHash !== expected.manifestHash ||
    (expectedGeneration !== undefined &&
      proof.pointerGeneration !== expectedGeneration);
  if (identityIsStale)
    throw new PublisherVerificationError(
      "The affected Leadership verification endpoint has not converged to the expected immutable release.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
      true,
    );
  if (
    proof.slug !== expected.situationSlug ||
    proof.visibility !== expected.visibility ||
    proof.situationBodyHash !== expected.situationBodyHash ||
    canonicalJson(proof.practice) !== canonicalJson(expected.practice)
  )
    throw new PublisherVerificationError(
      "The affected Leadership typed route proof differs from the preflight expectation.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  const expectedHeader = response.headers.get("x-content-release");
  if (expectedHeader !== expected.manifestHash)
    throw new PublisherVerificationError(
      "The affected Leadership proof header differs from its typed body.",
      "AFFECTED_ROUTE_VERIFICATION_FAILED",
    );
  return {
    code:
      expected.visibility === "RETIRED"
        ? "AFFECTED_ROUTE_RETIRED"
        : "AFFECTED_ROUTE_VERIFIED",
    httpStatus:
      expected.expectedRouteStatus ??
      (expected.visibility === "RETIRED" ? 404 : 200),
    observedReleaseId: proof.releaseId,
    observedManifestHash: proof.manifestHash,
    observedSituationBodyHash: proof.situationBodyHash,
    observedPracticeLogicalId: proof.practice?.resolvedLogicalId ?? null,
    observedPracticeContentHash: proof.practice?.contentHash ?? null,
  };
}

async function assertPublicationFence(
  studio: DatabaseClient,
  input: {
    jobId: string;
    claimToken: string;
    situationId: string;
    checkoutId: string;
    checkoutFence: bigint;
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
    job.claimToken !== input.claimToken ||
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

const compiledProjectionSchema = z
  .object({
    schemaVersion: z.literal("publishable-situation-projection-v1"),
    situationId: z.uuid(),
    releaseId: z.uuid(),
    publicationId: z.uuid(),
    visibility: z.enum(["PUBLIC", "RETIRED"]),
    frontmatter: publishableSituationFrontmatterSchema,
    bodyMdx: z.string().min(1),
    bodyMdxHash: z.string().regex(/^[a-f0-9]{64}$/u),
    situationArtifactHash: z.string().regex(/^[a-f0-9]{64}$/u),
    managedComponents: publishableManagedComponentsSchema,
    relationships: z.array(publishableSituationRelationshipSchema),
    scopedArtifacts: z.array(
      z
        .object({
          logicalId: z.string().min(1).max(240),
          type: z.enum([
            "PRACTICE",
            "GUIDE",
            "SOURCE",
            "LESSON_PLAN",
            "PREPARATION_PROMPT",
          ]),
          path: z.string().min(1).max(1_000),
          visibility: z.enum(["SITUATION_SCOPED", "INTERNAL"]),
          ownerSituationSlug: z.string().min(1),
          forkedFromLogicalId: z.string().min(1),
          forkedFromContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
          contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
          byteLength: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    promotion: publishablePromotionSchema.nullable(),
    persistence: z
      .object({
        situation: publishableSituationFrontmatterSchema.safeExtend({
          studioSituationId: z.uuid(),
          visibility: z.enum(["PUBLIC", "RETIRED"]),
          bodyMdx: z.string().min(1),
          // Scoped practices persist their collision-proof physical identity,
          // not the authored slug constrained by frontmatter.
          practiceId: z.string().min(1).max(240),
          practiceVariant: z.string().min(1).max(160),
        }),
        practice: z
          .object({
            authoredId: z.string().min(1),
            resolvedLogicalId: z.string().min(1),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
            projectedId: z.string().min(1),
            projectedVariant: z.string().min(1),
          })
          .strict(),
        artifactBindings: z.array(
          z
            .object({
              artifactType: z.enum([
                "PRACTICE",
                "GUIDE",
                "SOURCE",
                "LESSON_PLAN",
                "PREPARATION_PROMPT",
              ]),
              originalLogicalId: z.string().min(1),
              resolvedLogicalId: z.string().min(1),
              visibility: z.enum(["SITUATION_SCOPED", "INTERNAL"]),
              position: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

type PersistedCompiledProjection = z.infer<typeof compiledProjectionSchema>;

const affectedRouteProofSchema = z
  .object({
    schemaVersion: z.literal("affected-route-proof-json-v1"),
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    releaseId: z.uuid(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    pointerGeneration: z.string().regex(/^[1-9][0-9]*$/u),
    visibility: z.enum(["PUBLIC", "RETIRED"]),
    situationBodyHash: z.string().regex(/^[a-f0-9]{64}$/u),
    practice: z
      .object({
        authoredId: z.string().min(1),
        resolvedLogicalId: z.string().min(1).max(240),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .nullable(),
  })
  .strict();

const affectedRouteExpectationSchema = affectedRouteProofSchema.extend({
  routePath: z.string().startsWith("/"),
  verificationPath: z.string().startsWith("/"),
  expectedRouteStatus: z.union([z.literal(200), z.literal(404)]),
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
  if (bundle.schemaVersion === "situation-bundle-v2")
    return publishableSituationBundleSchema.parse({
      ...bundle,
      visibility,
      promotion: visibility === "PUBLIC" ? bundle.promotion : null,
    });
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

function requiredClaimToken(claimToken: string) {
  if (!claimToken) throw new Error("A publication claim token is required.");
  return claimToken;
}

async function appendPublicationEvent(
  transaction: Prisma.TransactionClient,
  jobId: string,
  kind: PublicationEventKind,
  payload: Record<string, unknown>,
) {
  const duplicates = await transaction.publicationEvent.findMany({
    where: { jobId, kind },
    select: { payload: true },
  });
  if (
    duplicates.some(
      (existing) => canonicalJson(existing.payload) === canonicalJson(payload),
    )
  )
    return;
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

const appendEvent = appendPublicationEvent;

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

async function claimedEvent(
  studio: DatabaseClient,
  jobId: string,
  claimToken: string,
  kind: PublicationEventKind,
  payload: Record<string, unknown>,
) {
  await studio.$transaction(async (transaction) => {
    const owned = await transaction.publicationJob.updateMany({
      where: {
        id: jobId,
        claimToken,
        state: { in: ["ASSEMBLING", "PROMOTING", "VERIFYING"] },
      },
      data: { leaseExpiresAt: new Date(Date.now() + 180_000) },
    });
    if (owned.count !== 1)
      throw new Error("Publication lease was lost to another publisher.");
    await appendEvent(transaction, jobId, kind, payload);
  });
}

async function claimedJobUpdate(
  studio: DatabaseClient,
  jobId: string,
  claimToken: string,
  data: Prisma.PublicationJobUpdateManyMutationInput,
  states: Array<"ASSEMBLING" | "PROMOTING" | "VERIFYING"> = [
    "ASSEMBLING",
    "PROMOTING",
    "VERIFYING",
  ],
) {
  const updated = await studio.publicationJob.updateMany({
    where: { id: jobId, claimToken, state: { in: states } },
    data,
  });
  if (updated.count !== 1)
    throw new Error("Publication lease was lost to another publisher.");
}

async function claimedTransitionWithEvent(
  studio: DatabaseClient,
  input: {
    jobId: string;
    claimToken: string;
    states?: Array<"ASSEMBLING" | "PROMOTING" | "VERIFYING">;
    data: Prisma.PublicationJobUpdateManyMutationInput;
    eventKind: PublicationEventKind;
    eventPayload: Record<string, unknown>;
  },
) {
  await studio.$transaction(async (transaction) => {
    const updated = await transaction.publicationJob.updateMany({
      where: {
        id: input.jobId,
        claimToken: input.claimToken,
        state: {
          in: input.states ?? ["ASSEMBLING", "PROMOTING", "VERIFYING"],
        },
      },
      data: input.data,
    });
    if (updated.count !== 1)
      throw new Error("Publication lease was lost to another publisher.");
    await appendEvent(
      transaction,
      input.jobId,
      input.eventKind,
      input.eventPayload,
    );
  });
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
  claimToken: string,
) {
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
    claimToken: string;
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
      preflightReceipt: {
        include: { artifacts: { orderBy: { position: "asc" } } },
      },
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

function utf8ArtifactBody(artifact: ExactCandidateArtifact) {
  if (artifact.encoding !== "UTF8")
    throw new PublisherCandidateContractError(
      new Error(`Publication artifact ${artifact.logicalId} is not UTF-8.`),
    );
  return new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes);
}

function exactBytesMatch(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

async function immutableLeadershipCompilationBase(
  leadershipUrl: string,
  releaseId: string,
  expectedManifestHash: string,
) {
  const leadership = new Client({
    connectionString: leadershipUrl,
    application_name: "situation-studio-publisher-preflight-verifier",
    statement_timeout: 30_000,
  });
  await leadership.connect();
  try {
    await leadership.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const release = await leadership.query<{
      manifest_body: string;
      manifest_hash: string;
    }>(
      `
        SELECT manifest::text AS manifest_body, manifest_hash
          FROM content_releases
         WHERE id = $1
      `,
      [releaseId],
    );
    const row = release.rows[0];
    if (!row)
      throw new Error(`Immutable Leadership base ${releaseId} is absent.`);
    const manifestBody = canonicalJson(JSON.parse(row.manifest_body));
    if (
      row.manifest_hash !== expectedManifestHash ||
      sha256(manifestBody) !== expectedManifestHash
    )
      throw new Error(
        `Immutable Leadership base ${releaseId} differs from the preflight fence.`,
      );
    const artifacts = await leadership.query<{
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
         ORDER BY membership.sort_order
      `,
      [releaseId],
    );
    const bodies = new Map<string, Uint8Array>();
    for (const artifact of artifacts.rows) {
      const bytes =
        artifact.encoding === "UTF8"
          ? artifact.text_body === null
            ? null
            : new TextEncoder().encode(artifact.text_body)
          : artifact.binary_body === null
            ? null
            : Uint8Array.from(artifact.binary_body);
      if (!bytes)
        throw new Error(
          `Immutable Leadership base artifact ${artifact.content_hash} has no exact bytes.`,
        );
      if (sha256(bytes) !== artifact.content_hash)
        throw new Error(
          `Immutable Leadership base artifact ${artifact.content_hash} failed its content hash.`,
        );
      bodies.set(artifact.content_hash, bytes);
    }
    await validateCanonicalSnapshot(manifestBody, bodies);
    await leadership.query("COMMIT");
    return { releaseId, manifestBody, bodies };
  } catch (error) {
    await leadership.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await leadership.end();
  }
}

async function candidateFromPreflight(leadershipUrl: string, job: ClaimedJob) {
  const receipt = job.preflightReceipt;
  if (!receipt)
    throw new Error(
      "PREFLIGHT_REQUIRED: Publication has no immutable preflight receipt.",
    );
  if (
    job.preflightReceiptId !== receipt.id ||
    job.publicationId !== receipt.publicationId ||
    job.situationId !== receipt.situationId ||
    job.targetRevisionId !== receipt.revisionId ||
    job.checkoutId !== receipt.checkoutId ||
    job.checkoutFence !== receipt.checkoutFence ||
    job.targetBundleHash !== receipt.revisionBundleHash ||
    job.candidateHash !== receipt.candidateHash ||
    job.sourceKind !== receipt.sourceKind ||
    job.legacyPreflightExempt ||
    receipt.validationResult !== "PASSED" ||
    receipt.sealedAt === null
  )
    throw new PublisherCandidateContractError(
      new Error("Publication job identity differs from its preflight receipt."),
    );
  if (
    receipt.contractDigest !== PUBLICATION_COMPILER_DIGEST ||
    canonicalJson(receipt.contractIdentity) !==
      canonicalJson(PUBLICATION_COMPILER_IDENTITY)
  )
    throw new PublisherCandidateContractError(
      new Error(
        "Publication compiler identity differs from the pinned contract.",
      ),
    );
  const manifest = manifestSchema.parse(JSON.parse(receipt.manifestBody));
  if (
    canonicalJson(manifest) !== receipt.manifestBody ||
    sha256(receipt.manifestBody) !== receipt.manifestHash ||
    manifest.source.releaseId !== receipt.releaseId ||
    manifest.artifacts.length !== receipt.artifactCount ||
    manifest.edges.length !== receipt.edgeCount
  )
    throw new PublisherCandidateContractError(
      new Error("Preflight manifest evidence is not exact."),
    );
  const allArtifacts: ExactCandidateArtifact[] = receipt.artifacts.map(
    (artifact) => ({
      logicalId: artifact.logicalId,
      type: artifact.artifactType,
      path: artifact.path,
      contentHash: artifact.contentHash,
      byteLength: artifact.byteLength,
      encoding: artifact.encoding,
      mediaType: artifact.mediaType,
      bytes: Uint8Array.from(artifact.bytes),
    }),
  );
  const byLogicalId = new Map(
    allArtifacts.map((artifact) => [artifact.logicalId, artifact]),
  );
  if (
    allArtifacts.length !== receipt.artifactCount ||
    allArtifacts.reduce(
      (total, artifact) => total + BigInt(artifact.byteLength),
      0n,
    ) !== receipt.totalByteLength
  )
    throw new PublisherCandidateContractError(
      new Error("Preflight artifact count or byte total differs."),
    );
  for (const manifestArtifact of manifest.artifacts) {
    const artifact = byLogicalId.get(manifestArtifact.logicalId);
    if (
      !artifact ||
      canonicalJson({ ...artifact, bytes: undefined }) !==
        canonicalJson({ ...manifestArtifact, bytes: undefined }) ||
      artifact.bytes.byteLength !== artifact.byteLength ||
      sha256(artifact.bytes) !== artifact.contentHash
    )
      throw new PublisherCandidateContractError(
        new Error(
          `Preflight artifact ${manifestArtifact.logicalId} differs from the manifest or hash.`,
        ),
      );
  }
  if (byLogicalId.size !== manifest.artifacts.length)
    throw new PublisherCandidateContractError(
      new Error("Preflight artifact identities are not one-to-one."),
    );
  const rawBundleResult = publishableSituationBundleSchema.safeParse(
    job.targetRevision.bundleManifest,
  );
  const targetBody = job.targetRevision.artifacts.find(
    (artifact) => artifact.kind === "SITUATION",
  )?.content.textBody;
  if (
    !rawBundleResult.success ||
    targetBody === null ||
    targetBody === undefined ||
    (rawBundleResult.success &&
      (rawBundleResult.data.situationId !== receipt.situationId ||
        rawBundleResult.data.metadata.slug !== job.situation.slug ||
        bundleHash(rawBundleResult.data) !== receipt.revisionBundleHash))
  )
    throw new PublisherCandidateContractError(
      new Error(
        "Preflight receipt no longer matches its immutable Studio revision.",
      ),
    );
  const rawBundle = rawBundleResult.data;
  if (
    (receipt.sourceKind === "RETIRE" && rawBundle.visibility !== "RETIRED") ||
    ((receipt.sourceKind === "CREATE" ||
      receipt.sourceKind === "MANUAL" ||
      receipt.sourceKind === "AGENT_ASSISTED") &&
      rawBundle.visibility !== "PUBLIC")
  )
    throw new PublisherCandidateContractError(
      new Error(
        "Publication source kind differs from the sealed revision visibility intent.",
      ),
    );
  const targetBundle = rawBundle;
  const scopedBodies = new Map<string, string>();
  for (const scoped of targetBundle.artifacts) {
    const persisted = byLogicalId.get(scoped.logicalId);
    if (
      !persisted ||
      persisted.type !== scoped.kind ||
      persisted.path !== scoped.path ||
      persisted.contentHash !== scoped.contentHash ||
      persisted.byteLength !== scoped.byteLength ||
      persisted.encoding !== scoped.encoding ||
      persisted.mediaType !== scoped.mediaType
    )
      throw new PublisherCandidateContractError(
        new Error(
          `Exact Studio scoped artifact ${scoped.logicalId} differs from the preflight bytes.`,
        ),
      );
    scopedBodies.set(scoped.logicalId, utf8ArtifactBody(persisted));
  }
  let snapshot;
  try {
    snapshot = toPublishableSituationSnapshot({
      bundle: targetBundle,
      body: targetBody,
      scopedArtifactBodies: scopedBodies,
    });
  } catch (error) {
    throw new PublisherCandidateContractError(error);
  }
  let base;
  try {
    base = await immutableLeadershipCompilationBase(
      leadershipUrl,
      receipt.baseReleaseId,
      receipt.baseManifestHash,
    );
  } catch (error) {
    const connectionCode =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : null;
    if (
      connectionCode &&
      /^(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|ENOTFOUND|ETIMEDOUT|EAI_AGAIN)$/u.test(
        connectionCode,
      )
    )
      throw error;
    throw new PublisherCandidateContractError(error);
  }
  const compiled = await compilePublishableSituationSnapshot({
    snapshot,
    base,
    publication: {
      releaseId: receipt.releaseId,
      publicationId: receipt.publicationId,
      parentReleaseId: receipt.baseReleaseId,
      expectedBaseGeneration: receipt.expectedPointerGeneration,
      sourceKind: receipt.sourceKind,
    },
  });
  if (!compiled.ok)
    throw new PublisherCandidateContractError(
      new Error(
        `Publisher recompilation rejected the exact Studio revision: ${compiled.diagnostics
          .map(
            (diagnostic) =>
              `${diagnostic.path.join(".") || "snapshot"}: ${diagnostic.message}`,
          )
          .join(" ")}`,
      ),
    );
  const projection = compiledProjectionSchema.parse(receipt.compiledProjection);
  const independentlyCompiledProjection = compiledProjectionSchema.parse(
    compiled.typedProjection,
  );
  if (
    projection.releaseId !== receipt.releaseId ||
    projection.publicationId !== receipt.publicationId ||
    projection.situationId !== receipt.situationId ||
    projection.frontmatter.slug !== job.situation.slug ||
    sha256(canonicalText(projection.bodyMdx)) !== projection.bodyMdxHash ||
    canonicalJson(projection) !== canonicalJson(independentlyCompiledProjection)
  )
    throw new PublisherCandidateContractError(
      new Error(
        "Preflight typed projection differs from an independent compilation of the exact Studio revision.",
      ),
    );
  if (
    compiled.compiler.digest !== receipt.contractDigest ||
    canonicalJson(compiled.compiler.identity) !==
      canonicalJson(receipt.contractIdentity) ||
    compiled.candidate.completeCandidateHash !== receipt.candidateHash ||
    compiled.candidate.manifestHash !== receipt.manifestHash ||
    compiled.candidate.manifestBody !== receipt.manifestBody ||
    canonicalJson(compiled.candidate.manifest) !== canonicalJson(manifest) ||
    compiled.candidate.artifactCount !== receipt.artifactCount ||
    compiled.candidate.edgeCount !== receipt.edgeCount ||
    BigInt(compiled.candidate.totalByteLength) !== receipt.totalByteLength
  )
    throw new PublisherCandidateContractError(
      new Error(
        "Preflight candidate identity differs from an independent compilation of the exact Studio revision.",
      ),
    );
  if (compiled.candidate.artifacts.length !== allArtifacts.length)
    throw new PublisherCandidateContractError(
      new Error("The independently compiled artifact set is incomplete."),
    );
  for (const [
    position,
    compiledArtifact,
  ] of compiled.candidate.artifacts.entries()) {
    const persisted = allArtifacts[position];
    if (
      !persisted ||
      canonicalJson({ ...persisted, bytes: undefined }) !==
        canonicalJson({ ...compiledArtifact, bytes: undefined }) ||
      !exactBytesMatch(persisted.bytes, compiledArtifact.bytes)
    )
      throw new PublisherCandidateContractError(
        new Error(
          `Preflight artifact ${compiledArtifact.logicalId} differs from independent compiler output.`,
        ),
      );
  }
  const changedArtifacts: ChangedArtifact[] =
    compiled.candidate.changedArtifacts.map((compiledArtifact) => {
      const persisted = byLogicalId.get(compiledArtifact.logicalId);
      if (
        !persisted ||
        !exactBytesMatch(persisted.bytes, compiledArtifact.bytes)
      )
        throw new PublisherCandidateContractError(
          new Error(
            `Changed artifact ${compiledArtifact.logicalId} differs from the persisted candidate.`,
          ),
        );
      return {
        ...persisted,
        body: utf8ArtifactBody(persisted),
        visibility: compiledArtifact.visibility,
        ownerSituationSlug: compiledArtifact.ownerSituationSlug,
        forkedFromLogicalId: compiledArtifact.forkedFromLogicalId,
        forkedFromContentHash: compiledArtifact.forkedFromContentHash,
      };
    });
  const rawRoutes = z
    .array(affectedRouteExpectationSchema)
    .length(1)
    .parse(receipt.routeExpectations);
  const independentlyCompiledRoutes = z
    .array(affectedRouteExpectationSchema)
    .length(1)
    .parse(compiled.affectedRoutes);
  if (canonicalJson(rawRoutes) !== canonicalJson(independentlyCompiledRoutes))
    throw new PublisherCandidateContractError(
      new Error(
        "Preflight route expectations differ from independent compiler output.",
      ),
    );
  const affectedRoutes: RuntimeRouteExpectation[] = rawRoutes.map((route) => ({
    releaseId: route.releaseId,
    manifestHash: route.manifestHash,
    situationSlug: route.slug,
    situationBodyHash: route.situationBodyHash,
    visibility: route.visibility,
    pointerGeneration: route.pointerGeneration,
    routePath: route.routePath,
    verificationPath: route.verificationPath,
    expectedRouteStatus: route.expectedRouteStatus,
    practice: route.practice,
  }));
  const route = affectedRoutes[0];
  if (
    !route ||
    route.releaseId !== receipt.releaseId ||
    route.manifestHash !== receipt.manifestHash ||
    route.pointerGeneration !==
      (receipt.expectedPointerGeneration + 1n).toString() ||
    route.situationBodyHash !== projection.situationArtifactHash
  )
    throw new PublisherCandidateContractError(
      new Error("Preflight route expectation differs from the candidate."),
    );
  const candidate: CandidateSnapshot = {
    publicationId: receipt.publicationId,
    releaseId: receipt.releaseId,
    parentReleaseId: receipt.baseReleaseId,
    expectedGeneration: receipt.expectedPointerGeneration,
    manifest,
    manifestBody: receipt.manifestBody,
    manifestHash: receipt.manifestHash,
    artifactCount: receipt.artifactCount,
    edgeCount: receipt.edgeCount,
    totalByteLength: receipt.totalByteLength,
    targetSlug: job.situation.slug,
    targetSituationId: job.situationId,
    targetBody: canonicalText(targetBody),
    targetBundle,
    sourceKind: receipt.sourceKind,
    changedArtifacts,
    allArtifacts,
    candidateHash: compiled.candidate.completeCandidateHash,
    compilerDigest: compiled.compiler.digest,
    compiledProjection: independentlyCompiledProjection,
    affectedRoutes,
  };
  validateCandidate(candidate);
  await validateCanonicalSnapshot(
    candidate.manifestBody,
    new Map(
      allArtifacts.map((artifact) => [
        artifact.contentHash,
        artifact.bytes.slice(),
      ]),
    ),
  ).catch((error) => {
    throw new PublisherCandidateContractError(error);
  });
  return candidate;
}

async function persistReceiptBackedCandidateSnapshot(
  studio: DatabaseClient,
  job: ClaimedJob,
  claimToken: string,
  candidate: CandidateSnapshot,
) {
  if (!job.preflightReceiptId) return;
  if (
    !candidate.candidateHash ||
    !candidate.compilerDigest ||
    !candidate.compiledProjection ||
    !candidate.allArtifacts
  )
    throw new PublisherCandidateContractError(
      new Error(
        "The receipt-backed publisher candidate lacks exact snapshot evidence.",
      ),
    );
  const assembly = {
    schemaVersion: "sealed-preflight-candidate-snapshot-v1",
    preflightReceiptId: job.preflightReceiptId,
    candidateHash: candidate.candidateHash,
    compilerDigest: candidate.compilerDigest,
    targetSlug: candidate.targetSlug,
    targetRevisionId: job.targetRevisionId,
    targetBundleHash: job.targetBundleHash,
    bodyMdxHash: candidate.compiledProjection.bodyMdxHash,
    situationArtifactHash: candidate.compiledProjection.situationArtifactHash,
    artifactIdentities: candidate.allArtifacts.map((artifact, position) => ({
      logicalId: artifact.logicalId,
      position,
      contentHash: artifact.contentHash,
      byteLength: artifact.byteLength,
    })),
    edgeHash: sha256(canonicalJson(candidate.manifest.edges)),
  };
  await studio.$transaction(async (transaction) => {
    const fenced = await transaction.publicationJob.updateMany({
      where: {
        id: job.id,
        claimToken,
        state: { in: ["ASSEMBLING", "PROMOTING", "VERIFYING"] },
      },
      data: { leaseExpiresAt: new Date(Date.now() + 180_000) },
    });
    if (fenced.count !== 1)
      throw new Error("Publication lease was lost to another publisher.");
    const existing = await transaction.publicationCandidateSnapshot.findUnique({
      where: { jobId: job.id },
    });
    if (existing) {
      if (
        existing.releaseId !== candidate.releaseId ||
        existing.parentReleaseId !== candidate.parentReleaseId ||
        existing.expectedPointerGeneration !== candidate.expectedGeneration ||
        existing.manifestHash !== candidate.manifestHash ||
        existing.manifestBody !== candidate.manifestBody ||
        existing.artifactCount !== candidate.artifactCount ||
        existing.edgeCount !== candidate.edgeCount ||
        existing.totalByteLength !== candidate.totalByteLength ||
        canonicalJson(existing.assembly) !== canonicalJson(assembly)
      )
        throw new PublisherCandidateContractError(
          new Error(
            "Persisted publisher snapshot differs from the sealed preflight candidate.",
          ),
        );
      return;
    }
    await transaction.publicationCandidateSnapshot.create({
      data: {
        jobId: job.id,
        releaseId: candidate.releaseId,
        parentReleaseId: candidate.parentReleaseId,
        expectedPointerGeneration: candidate.expectedGeneration,
        manifestHash: candidate.manifestHash,
        manifestBody: candidate.manifestBody,
        artifactCount: candidate.artifactCount,
        edgeCount: candidate.edgeCount,
        totalByteLength: candidate.totalByteLength,
        assembly: jsonInput(assembly),
      },
    });
  });
}

async function buildCandidate(
  studio: DatabaseClient,
  leadershipUrl: string,
  job: ClaimedJob,
  claimToken: string,
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
    await claimedTransitionWithEvent(studio, {
      jobId: job.id,
      claimToken,
      data: {
        state: "NEEDS_REFRESH",
        failureCode: "TARGET_CHANGED",
        observedReleaseId: observed.identity.releaseId,
        expectedPointerGeneration: BigInt(observed.identity.generation),
        finishedAt: new Date(),
        claimToken: null,
        leaseExpiresAt: null,
      },
      eventKind: "CONFLICTED",
      eventPayload: {
        observedReleaseId: observed.identity.releaseId,
        observedBundleHash,
        baseBundleHash: job.baseBundleHash,
      },
    });
    return null;
  }

  await claimedEvent(studio, job.id, claimToken, "POINTER_OBSERVED", {
    releaseId: observed.identity.releaseId,
    manifestHash: observed.identity.manifestHash,
    generation: observed.identity.generation,
  });
  if (decision.rebase)
    await claimedEvent(studio, job.id, claimToken, "REBASED", {
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
    await renewPublicationLease(studio, job.id, claimToken);
    await claimedEvent(studio, job.id, claimToken, "SNAPSHOT_BUILT", {
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
    await claimedJobUpdate(studio, job.id, claimToken, {
      observedReleaseId: candidate.parentReleaseId,
      expectedPointerGeneration: candidate.expectedGeneration,
      leadershipReleaseId: candidate.releaseId,
      leadershipManifestHash: candidate.manifestHash,
      previousReleaseId: candidate.parentReleaseId,
      state: "PROMOTING",
    });
    await claimedEvent(studio, job.id, claimToken, "VALIDATED", {
      targetBundleHash: job.targetBundleHash,
      manifestHash: candidate.manifestHash,
    });
    return candidate;
  } finally {
    await client.end();
  }
}

export function validateCandidate(candidate: CandidateSnapshot) {
  if (
    candidate.candidateHash !== undefined &&
    (!candidate.compiledProjection || !candidate.affectedRoutes?.length)
  )
    throw new Error(
      "A preflight candidate requires its exact typed projection and route expectations.",
    );
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
  if (candidate.allArtifacts) {
    if (
      (candidate.candidateHash !== undefined &&
        candidate.compilerDigest !== PUBLICATION_COMPILER_DIGEST) ||
      candidate.allArtifacts.length !== candidate.artifactCount ||
      candidate.allArtifacts.reduce(
        (total, artifact) => total + BigInt(artifact.byteLength),
        0n,
      ) !== candidate.totalByteLength
    )
      throw new Error(
        "Persisted candidate compiler or artifact totals differ.",
      );
    const exactById = new Map(
      candidate.allArtifacts.map((artifact) => [artifact.logicalId, artifact]),
    );
    for (const artifact of manifest.artifacts) {
      const exact = exactById.get(artifact.logicalId);
      if (
        !exact ||
        sha256(exact.bytes) !== exact.contentHash ||
        exact.bytes.byteLength !== exact.byteLength
      )
        throw new Error(
          `Persisted artifact ${artifact.logicalId} is not exact.`,
        );
    }
  }
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
    if (sha256(new TextEncoder().encode(changed.body)) !== changed.contentHash)
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

async function insertCandidateArtifacts(
  client: PoolClient | Client,
  candidate: CandidateSnapshot,
) {
  const versionIds = new Map<string, string>();
  const exactArtifacts =
    candidate.allArtifacts ??
    candidate.changedArtifacts.map((artifact) => ({
      ...artifact,
      bytes: new TextEncoder().encode(artifact.body),
    }));
  const changedById = new Map(
    candidate.changedArtifacts.map((artifact) => [
      artifact.logicalId,
      artifact,
    ]),
  );
  for (const artifact of exactArtifacts) {
    const changed = changedById.get(artifact.logicalId);
    const identity = await client.query<{
      id: string;
      type: string;
      canonical_path: string;
      visibility: "GLOBAL" | "SITUATION_SCOPED" | "INTERNAL";
      owner_situation_slug: string | null;
      forked_from_logical_id: string | null;
      forked_from_content_hash: string | null;
    }>(
      `
        SELECT id,
               type::text,
               canonical_path,
               visibility::text,
               owner_situation_slug,
               forked_from_logical_id,
               forked_from_content_hash
          FROM content_artifacts
         WHERE logical_id = $1
      `,
      [artifact.logicalId],
    );
    let artifactId = identity.rows[0]?.id;
    const existingIdentity = identity.rows[0];
    if (
      existingIdentity &&
      (existingIdentity.type !== artifact.type ||
        existingIdentity.canonical_path !== artifact.path)
    )
      throw new PublisherCandidateContractError(
        new Error(
          `Artifact identity ${artifact.logicalId} differs from its persisted type or path.`,
        ),
      );
    if (
      existingIdentity &&
      changed &&
      (existingIdentity.visibility !== changed.visibility ||
        existingIdentity.owner_situation_slug !== changed.ownerSituationSlug ||
        existingIdentity.forked_from_logical_id !==
          changed.forkedFromLogicalId ||
        existingIdentity.forked_from_content_hash !==
          changed.forkedFromContentHash)
    )
      throw new PublisherCandidateContractError(
        new Error(
          `Artifact identity ${artifact.logicalId} differs from its persisted visibility or provenance.`,
        ),
      );
    if (!artifactId) {
      if (!changed)
        throw new PublisherCandidateContractError(
          new Error(
            `Carried artifact identity ${artifact.logicalId} is absent from Leadership.`,
          ),
        );
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
          changed.visibility,
          changed.ownerSituationSlug,
          changed.forkedFromLogicalId,
          changed.forkedFromContentHash,
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
            $4::"ContentEncoding",
            $5,
            $6,
            $7,
            $8
          )
        `,
        [
          versionId,
          artifactId,
          artifact.contentHash,
          artifact.encoding,
          artifact.mediaType,
          artifact.byteLength,
          artifact.encoding === "UTF8"
            ? new TextDecoder("utf-8", { fatal: true }).decode(artifact.bytes)
            : null,
          artifact.encoding === "BINARY" ? artifact.bytes : null,
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
  const projectedPracticeId =
    candidate.compiledProjection?.persistence.practice.projectedId ??
    scopedPracticeId ??
    ("practiceId" in metadata ? metadata.practiceId : "listen-first");
  const projectedPracticeVariant =
    candidate.compiledProjection?.persistence.practice.projectedVariant ??
    ("practiceVariant" in metadata ? metadata.practiceVariant : "default");
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
        CASE WHEN situation.slug = $3 THEN $8 ELSE situation.practice_id END,
        CASE WHEN situation.slug = $3 THEN $9 ELSE situation.practice_variant END,
        CASE WHEN situation.slug = $3 THEN ($4::jsonb->>'fieldNotePresent')::boolean ELSE situation.field_note_present END,
        CASE WHEN situation.slug = $3 THEN ($4::jsonb->>'safetyEscalationNotePresent')::boolean ELSE situation.safety_escalation_note_present END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'socialHook' ELSE situation.social_hook END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'campaignCluster' ELSE situation.campaign_cluster END,
        CASE WHEN situation.slug = $3 THEN $4::jsonb->>'reviewStatus' ELSE situation.review_status END,
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
      projectedPracticeId,
      projectedPracticeVariant,
    ],
  );
  if (!targetExists.rowCount) {
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
          gen_random_uuid(), $1, $2,
          $3::jsonb->>'title', $3::jsonb->>'description',
          $3::jsonb->>'stakes', $3::jsonb->>'primarySkill',
          $3::jsonb->>'preparationTime', $3::jsonb->>'emotionalLoad',
          $3::jsonb->>'pattern', $3::jsonb->>'scope',
          ($3::jsonb->>'published')::date,
          ($3::jsonb->>'lastReviewed')::date,
          $3::jsonb->>'author', $3::jsonb->>'reviewer', $4, $5,
          ($3::jsonb->>'fieldNotePresent')::boolean,
          ($3::jsonb->>'safetyEscalationNotePresent')::boolean,
          $3::jsonb->>'socialHook', $3::jsonb->>'campaignCluster',
          $3::jsonb->>'reviewStatus', $6, $7::"SituationVisibility", $8::uuid
        )
      `,
      [
        candidate.releaseId,
        metadata.slug,
        JSON.stringify(metadata),
        projectedPracticeId,
        projectedPracticeVariant,
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
          ON target_map.old_id = relation.target_situation_id
        JOIN situations original_source
          ON original_source.id = relation.source_situation_id
       WHERE original_source.slug <> $3;

      INSERT INTO situation_relations (
        source_situation_id, target_situation_id, position
      )
      SELECT source.id, target.id, related.ordinality - 1
        FROM situations source
        CROSS JOIN LATERAL
             jsonb_array_elements_text($4::jsonb->'relatedSituationIds')
               WITH ORDINALITY AS related(slug, ordinality)
        JOIN situations target
          ON target.release_id = $2 AND target.slug = related.slug
       WHERE source.release_id = $2 AND source.slug = $3;

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
       WHERE original_situation.slug <> $3;

      INSERT INTO situation_source_references (
        situation_id, source_id, position
      )
      SELECT target.id, source.id, reference.ordinality - 1
        FROM situations target
        CROSS JOIN LATERAL
             jsonb_array_elements_text($4::jsonb->'sourceReferences')
               WITH ORDINALITY AS reference(source_id, ordinality)
        JOIN sources source
          ON source.release_id = $2
         AND source.source_id = reference.source_id
         AND source.visibility = 'GLOBAL'
       WHERE target.release_id = $2 AND target.slug = $3;
    `,
    [
      candidate.parentReleaseId,
      candidate.releaseId,
      candidate.targetSlug,
      JSON.stringify(metadata),
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

  const promotion = candidate.targetBundle.promotion;
  if (visibility === "PUBLIC") {
    if (!promotion)
      throw new PublisherCandidateContractError(
        new Error("A public candidate has no exact promotion packet."),
      );
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
        promotion.status,
        promotion.canonical,
        JSON.stringify(promotion.socialDrafts),
        promotion.scenarioQuestion,
        promotion.pullQuoteIdea,
        JSON.stringify(promotion.utm),
        promotion.ogPreview,
      ],
    );
  }

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
    const exactBinding =
      candidate.compiledProjection?.persistence.artifactBindings.find(
        (binding) => binding.resolvedLogicalId === variant.logicalId,
      );
    const exactBindingPosition = exactBinding?.position ?? bindingPosition;
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
        exactBindingPosition,
      ],
    );
    bindingPosition = Math.max(bindingPosition + 1, exactBindingPosition + 1);
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

async function assertLeadershipReleaseMatchesCandidate(
  client: Client,
  candidate: CandidateSnapshot,
) {
  if (!candidate.allArtifacts)
    throw new PublisherCandidateContractError(
      new Error(
        "Exact persisted candidate bytes are required for release reconciliation.",
      ),
    );
  const release = await client.query<{
    manifest_body: string;
    manifest_hash: string;
    studio_publication_id: string | null;
    artifact_count: number;
    edge_count: number;
    total_byte_length: string;
  }>(
    `
      SELECT manifest::text AS manifest_body,
             manifest_hash,
             studio_publication_id,
             artifact_count,
             edge_count,
             total_byte_length::text
        FROM content_releases
       WHERE id = $1
    `,
    [candidate.releaseId],
  );
  const persistedRelease = release.rows[0];
  if (
    !persistedRelease ||
    canonicalJson(JSON.parse(persistedRelease.manifest_body)) !==
      candidate.manifestBody ||
    persistedRelease.manifest_hash !== candidate.manifestHash ||
    persistedRelease.studio_publication_id !== candidate.publicationId ||
    persistedRelease.artifact_count !== candidate.artifactCount ||
    persistedRelease.edge_count !== candidate.edgeCount ||
    BigInt(persistedRelease.total_byte_length) !== candidate.totalByteLength
  )
    throw new PublisherCandidateContractError(
      new Error(
        "The persisted Leadership release identity differs from preflight.",
      ),
    );
  const artifacts = await client.query<{
    logical_id: string;
    type: string;
    canonical_path: string;
    content_hash: string;
    byte_length: number;
    encoding: "UTF8" | "BINARY";
    media_type: string;
    text_body: string | null;
    binary_body: Uint8Array | null;
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
             version.binary_body,
             identity.visibility::text,
             identity.owner_situation_slug,
             identity.forked_from_logical_id,
             identity.forked_from_content_hash
        FROM release_artifacts membership
        JOIN artifact_versions version
          ON version.id = membership.artifact_version_id
        JOIN content_artifacts identity
          ON identity.id = version.artifact_id
       WHERE membership.release_id = $1
       ORDER BY membership.sort_order
    `,
    [candidate.releaseId],
  );
  if (artifacts.rows.length !== candidate.allArtifacts.length)
    throw new PublisherCandidateContractError(
      new Error("The persisted Leadership artifact set is incomplete."),
    );
  for (const [position, expected] of candidate.allArtifacts.entries()) {
    const persisted = artifacts.rows[position];
    const changed = candidate.changedArtifacts.find(
      (artifact) => artifact.logicalId === expected.logicalId,
    );
    const bytes =
      persisted?.encoding === "UTF8"
        ? persisted.text_body === null
          ? null
          : new TextEncoder().encode(persisted.text_body)
        : persisted?.binary_body === null ||
            persisted?.binary_body === undefined
          ? null
          : Uint8Array.from(persisted.binary_body);
    if (
      !persisted ||
      persisted.logical_id !== expected.logicalId ||
      persisted.type !== expected.type ||
      persisted.canonical_path !== expected.path ||
      persisted.content_hash !== expected.contentHash ||
      persisted.byte_length !== expected.byteLength ||
      persisted.encoding !== expected.encoding ||
      persisted.media_type !== expected.mediaType ||
      (changed !== undefined &&
        (persisted.visibility !== changed.visibility ||
          persisted.owner_situation_slug !== changed.ownerSituationSlug ||
          persisted.forked_from_logical_id !== changed.forkedFromLogicalId ||
          persisted.forked_from_content_hash !==
            changed.forkedFromContentHash)) ||
      !bytes ||
      !exactBytesMatch(bytes, expected.bytes)
    )
      throw new PublisherCandidateContractError(
        new Error(
          `Persisted Leadership artifact ${expected.logicalId} differs from the immutable preflight bytes.`,
        ),
      );
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
      await assertLeadershipReleaseMatchesCandidate(client, candidate);
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
    const versionIds = await insertCandidateArtifacts(client, candidate);
    const memberships = candidate.manifest.artifacts.map((artifact) => ({
      artifact_version_id: versionIds.get(artifact.logicalId) ?? "",
      logical_id: artifact.logicalId,
      canonical_path: artifact.path,
      type: artifact.type,
      content_hash: artifact.contentHash,
      byte_length: artifact.byteLength,
    }));
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
    await assertLeadershipReleaseMatchesCandidate(client, candidate);
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

async function reconcileAmbiguousPromotion(
  leadershipUrl: string,
  candidate: CandidateSnapshot,
) {
  const client = new Client({
    connectionString: leadershipUrl,
    application_name: "situation-studio-publisher-commit-reconciler",
    statement_timeout: 30_000,
  });
  await client.connect();
  try {
    const release = await client.query<{ id: string; manifest_hash: string }>(
      `
        SELECT id, manifest_hash
          FROM content_releases
         WHERE studio_publication_id = $1
      `,
      [candidate.publicationId],
    );
    const pointer = await databaseIdentity(client);
    const observedRelease = release.rows[0];
    if (
      observedRelease &&
      (observedRelease.id !== candidate.releaseId ||
        observedRelease.manifest_hash !== candidate.manifestHash)
    )
      throw new PublisherCandidateContractError(
        new Error("Publication id maps to different Leadership release bytes."),
      );
    return {
      releaseExists: Boolean(observedRelease),
      promoted:
        observedRelease?.id === candidate.releaseId &&
        pointer.releaseId === candidate.releaseId &&
        pointer.manifestHash === candidate.manifestHash,
      pointer,
    };
  } finally {
    await client.end();
  }
}

export async function reconcilePublicationRecovery(
  dependencies: PublisherDependencies,
) {
  const recoveries = await dependencies.studio.publicationJob.findMany({
    where: { state: "RECOVERY_REQUIRED" },
    orderBy: { createdAt: "asc" },
    include: {
      candidateSnapshot: true,
      preflightReceipt: true,
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
      const parentReleaseId =
        recovery.preflightReceipt?.baseReleaseId ?? snapshot?.parentReleaseId;
      if (!parentReleaseId) continue;
      const restored = await databaseIdentity(leadership);
      if (restored.releaseId !== parentReleaseId) continue;
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
      const recoveryToken = crypto.randomUUID();
      const claimed = await dependencies.studio.publicationJob.updateMany({
        where: {
          id: recovery.id,
          state: "RECOVERY_REQUIRED",
          OR: [
            { claimToken: null },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: new Date() } },
          ],
        },
        data: {
          claimToken: recoveryToken,
          leaseExpiresAt: new Date(Date.now() + 180_000),
        },
      });
      if (claimed.count !== 1) continue;
      const changed = await dependencies.studio.$transaction(
        async (transaction) => {
          await lockPublicationCoordination(transaction);
          const updated = await transaction.publicationJob.updateMany({
            where: {
              id: recovery.id,
              state: "RECOVERY_REQUIRED",
              claimToken: recoveryToken,
            },
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
          await appendEvent(transaction, recovery.id, "RESTORED", {
            releaseId: restored.releaseId,
            manifestHash: restored.manifestHash,
            generation: restored.generation.toString(),
            reconciledAfterRuntimeConvergence: true,
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
  claimToken: string,
  attemptId: string,
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
        currentJob.claimToken !== claimToken ||
        !checkout ||
        checkout.releasedAt ||
        checkout.fence !== job.checkoutFence ||
        !situation ||
        situation.fence !== job.checkoutFence
      )
        throw new Error("Late publisher result was fenced.");
      let observation =
        await transaction.leadershipReleaseObservation.findUnique({
          where: { releaseId: candidate.releaseId },
        });
      if (
        observation &&
        (observation.manifestHash !== candidate.manifestHash ||
          observation.pointerGeneration !== identity.generation)
      )
        throw new Error(
          "Leadership observation differs from verified release.",
        );
      observation ??= await transaction.leadershipReleaseObservation.create({
        data: {
          releaseId: candidate.releaseId,
          manifestHash: candidate.manifestHash,
          pointerGeneration: identity.generation,
          state: "OFFICIAL",
          sourceKind: "SITUATION_STUDIO",
          manifest: jsonInput(candidate.manifest),
          publishedAt: new Date(),
        },
      });
      let version = await transaction.productionSituationVersion.findUnique({
        where: {
          situationId_observationId: {
            situationId: job.situationId,
            observationId: observation.id,
          },
        },
      });
      if (version && version.bundleHash !== productionBundleHash)
        throw new Error("Production version differs from verified candidate.");
      version ??= await transaction.productionSituationVersion.create({
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
      const updatedSituation = await transaction.situation.updateMany({
        where: { id: job.situationId, fence: job.checkoutFence },
        data: {
          title: candidate.targetBundle.metadata.title,
          visibility: candidate.targetBundle.visibility,
          productionBundleHash: version.bundleHash,
          productionReleaseId: candidate.releaseId,
          productionAt: version.productionAt,
        },
      });
      if (updatedSituation.count !== 1)
        throw new Error("Publication situation update was fenced.");
      const existingReceipt = await transaction.verificationReceipt.findUnique({
        where: { jobId: job.id },
      });
      if (
        existingReceipt &&
        (existingReceipt.expectedReleaseId !== candidate.releaseId ||
          existingReceipt.expectedManifestHash !== candidate.manifestHash)
      )
        throw new Error(
          "Verification receipt differs from verified candidate.",
        );
      if (!existingReceipt)
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
            producerContractDigest:
              candidate.compilerDigest ??
              requiredContentContractIdentity.packageSha256,
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
      await transaction.draft.updateMany({
        where: { id: job.targetRevision.draftId, state: "ACTIVE" },
        data: { state: "ARCHIVED", archivedAt: new Date() },
      });
      await appendEvent(transaction, job.id, "VERIFIED", {
        releaseId: identity.releaseId,
        manifestHash: identity.manifestHash,
        runtimeReleaseId: runtime.releaseId,
        runtimeManifestHash: runtime.manifestHash,
        capabilityDigest: capabilities.capabilityDigest,
        typedParityCode: leadershipTypedParityPredicate,
        routeProbeCode: routeProof.code,
        routeHttpStatus: routeProof.httpStatus,
      });
      await appendEvent(transaction, job.id, "SUCCEEDED", {
        releaseId: candidate.releaseId,
      });
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
      const completed = await transaction.publicationJob.updateMany({
        where: {
          id: job.id,
          claimToken,
          state: "VERIFYING",
          checkoutFence: job.checkoutFence,
        },
        data: {
          state: "SUCCEEDED",
          finishedAt: new Date(),
          failureCode: null,
          claimToken: null,
          leaseExpiresAt: null,
        },
      });
      if (completed.count !== 1)
        throw new Error("Late publisher finalization was fenced.");
      await beforeCommit?.();
    },
    { isolationLevel: "Serializable" },
  );
}

async function legacyRecoveryCandidateFromSnapshot(
  leadershipUrl: string,
  job: ClaimedJob,
) {
  const snapshot = job.candidateSnapshot;
  if (
    !job.legacyPreflightExempt ||
    (job.state !== "PROMOTING" && job.state !== "VERIFYING") ||
    !snapshot
  )
    throw new PublisherCandidateContractError(
      new Error(
        "PREFLIGHT_REQUIRED: Nonterminal legacy publication jobs are quarantined and cannot assemble or rebase a candidate.",
      ),
    );
  const body = job.targetRevision.artifacts.find(
    (artifact) => artifact.kind === "SITUATION",
  )?.content.textBody;
  if (!body)
    throw new PublisherCandidateContractError(
      new Error(
        "Historical candidate recovery lost its immutable Studio body.",
      ),
    );
  const bundle = situationBundleSchema.parse(job.targetRevision.bundleManifest);
  const validation = validateSituationBundle(bundle, body);
  if (!validation.valid || validation.bundleHash !== job.targetBundleHash)
    throw new PublisherCandidateContractError(
      new Error(
        validation.errors.join(" ") ||
          "Historical candidate Studio revision hash differs.",
      ),
    );
  const manifest = manifestSchema.parse(JSON.parse(snapshot.manifestBody));
  if (
    canonicalJson(manifest) !== snapshot.manifestBody ||
    sha256(snapshot.manifestBody) !== snapshot.manifestHash ||
    manifest.source.releaseId !== snapshot.releaseId ||
    manifest.artifacts.length !== snapshot.artifactCount ||
    manifest.edges.length !== snapshot.edgeCount
  )
    throw new PublisherCandidateContractError(
      new Error("Historical persisted candidate manifest is not exact."),
    );
  const leadership = new Client({
    connectionString: leadershipUrl,
    application_name: "situation-studio-publisher-legacy-recovery",
    statement_timeout: 30_000,
  });
  await leadership.connect();
  try {
    const release = await leadership.query<{
      id: string;
      parent_release_id: string;
      manifest_body: string;
      manifest_hash: string;
      studio_publication_id: string | null;
      artifact_count: number;
      edge_count: number;
      total_byte_length: string;
    }>(
      `
        SELECT id,
               parent_release_id,
               manifest::text AS manifest_body,
               manifest_hash,
               studio_publication_id,
               artifact_count,
               edge_count,
               total_byte_length::text
          FROM content_releases
         WHERE id = $1
      `,
      [snapshot.releaseId],
    );
    const persistedRelease = release.rows[0];
    if (
      !persistedRelease ||
      persistedRelease.parent_release_id !== snapshot.parentReleaseId ||
      persistedRelease.studio_publication_id !== job.publicationId ||
      canonicalJson(JSON.parse(persistedRelease.manifest_body)) !==
        snapshot.manifestBody ||
      persistedRelease.manifest_hash !== snapshot.manifestHash ||
      persistedRelease.artifact_count !== snapshot.artifactCount ||
      persistedRelease.edge_count !== snapshot.edgeCount ||
      BigInt(persistedRelease.total_byte_length) !== snapshot.totalByteLength
    )
      throw new PublisherCandidateContractError(
        new Error(
          "Historical candidate release is absent or differs from its persisted snapshot.",
        ),
      );
    const rows = await leadership.query<{
      logical_id: string;
      type: string;
      canonical_path: string;
      content_hash: string;
      byte_length: number;
      encoding: "UTF8" | "BINARY";
      media_type: string;
      text_body: string | null;
      binary_body: Uint8Array | null;
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
               version.binary_body,
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
         ORDER BY membership.sort_order
      `,
      [snapshot.releaseId],
    );
    if (rows.rows.length !== snapshot.artifactCount)
      throw new PublisherCandidateContractError(
        new Error("Historical candidate artifact set is incomplete."),
      );
    const allArtifacts: ExactCandidateArtifact[] = rows.rows.map(
      (artifact, position) => {
        const manifestArtifact = manifest.artifacts[position];
        const bytes =
          artifact.encoding === "UTF8"
            ? artifact.text_body === null
              ? null
              : new TextEncoder().encode(artifact.text_body)
            : artifact.binary_body === null
              ? null
              : Uint8Array.from(artifact.binary_body);
        if (
          !manifestArtifact ||
          !bytes ||
          artifact.logical_id !== manifestArtifact.logicalId ||
          artifact.type !== manifestArtifact.type ||
          artifact.canonical_path !== manifestArtifact.path ||
          artifact.content_hash !== manifestArtifact.contentHash ||
          artifact.byte_length !== manifestArtifact.byteLength ||
          artifact.encoding !== manifestArtifact.encoding ||
          artifact.media_type !== manifestArtifact.mediaType ||
          bytes.byteLength !== artifact.byte_length ||
          sha256(bytes) !== artifact.content_hash
        )
          throw new PublisherCandidateContractError(
            new Error(
              `Historical candidate artifact ${artifact.logical_id} is not exact.`,
            ),
          );
        return {
          logicalId: artifact.logical_id,
          type: artifact.type,
          path: artifact.canonical_path,
          contentHash: artifact.content_hash,
          byteLength: artifact.byte_length,
          encoding: artifact.encoding,
          mediaType: artifact.media_type,
          bytes,
        };
      },
    );
    const changedIds = new Set([
      `situation:${job.situation.slug}`,
      ...bundle.artifacts.map((artifact) => artifact.logicalId),
    ]);
    const changedArtifacts: ChangedArtifact[] = rows.rows
      .filter((artifact) => changedIds.has(artifact.logical_id))
      .map((artifact) => {
        if (artifact.encoding !== "UTF8" || artifact.text_body === null)
          throw new PublisherCandidateContractError(
            new Error(
              `Historical changed artifact ${artifact.logical_id} is not UTF-8.`,
            ),
          );
        return {
          logicalId: artifact.logical_id,
          type: artifact.type,
          path: artifact.canonical_path,
          contentHash: artifact.content_hash,
          byteLength: artifact.byte_length,
          encoding: artifact.encoding,
          mediaType: artifact.media_type,
          body: artifact.text_body,
          visibility: artifact.visibility,
          ownerSituationSlug: artifact.owner_situation_slug,
          forkedFromLogicalId: artifact.forked_from_logical_id,
          forkedFromContentHash: artifact.forked_from_content_hash,
        };
      });
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
      targetBundle: bundleForPublication(bundle, job.sourceKind),
      sourceKind: job.sourceKind,
      changedArtifacts,
      allArtifacts,
    };
    validateCandidate(candidate);
    await validateCanonicalSnapshot(
      candidate.manifestBody,
      new Map(
        allArtifacts.map((artifact) => [
          artifact.contentHash,
          artifact.bytes.slice(),
        ]),
      ),
    );
    return candidate;
  } catch (error) {
    if (error instanceof PublisherCandidateContractError) throw error;
    throw new PublisherCandidateContractError(error);
  } finally {
    await leadership.end();
  }
}

function safePublicationFailureDetail(error: unknown) {
  if (!(error instanceof PublisherRuntimeConvergenceError)) return null;
  const parsed = publicationFailureDetailSchema.safeParse(error.failureDetail);
  return parsed.success ? parsed.data : null;
}

async function candidateFromPersisted(leadershipUrl: string, job: ClaimedJob) {
  if (!job.preflightReceipt)
    return legacyRecoveryCandidateFromSnapshot(leadershipUrl, job);
  return candidateFromPreflight(leadershipUrl, job);
}

function publicationFailureCode(error: unknown) {
  if (error instanceof LeadershipCapabilityError) return error.code;
  if (error instanceof PublisherCandidateContractError) return error.code;
  if (error instanceof PublisherRuntimeConvergenceError) return error.code;
  if (error instanceof PublisherVerificationError) return error.code;
  if (error instanceof z.ZodError) return "CANONICAL_SNAPSHOT_INVALID";
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
  claimToken: string,
) {
  const token = requiredClaimToken(claimToken);
  const { studio, leadershipPublisherUrl } = dependencies;
  let leadership: Client | null = null;
  let job: ClaimedJob | null = null;
  let attempt: { id: string } | null = null;
  let promoted = false;
  let promotionAttempted = false;
  let promotionStateKnown = true;
  let runtimeVerified = false;
  let activeCandidate: CandidateSnapshot | null = null;
  try {
    await renewPublicationLease(studio, jobId, token);
    const started = await startPublicationAttempt(studio, jobId, token);
    job = started.job;
    attempt = started.attempt;
    if (job.claimToken !== token)
      throw new Error("Publication lease was lost to another publisher.");
    if (!/^[a-f0-9]{40}$/u.test(dependencies.producerCommit))
      throw new Error(
        "The publisher deployment commit is not an immutable Git identity.",
      );
    const candidate = await candidateFromPersisted(leadershipPublisherUrl, job);
    activeCandidate = candidate;
    await persistReceiptBackedCandidateSnapshot(studio, job, token, candidate);
    if (job.state === "PROMOTING" || job.state === "VERIFYING") {
      // A reclaimed job may be resuming after COMMIT reached Leadership but
      // before Studio recorded the boundary. Reconcile that durable fact
      // before any capability/health gate can fail and choose restoration.
      promotionAttempted = true;
      promotionStateKnown = false;
      const reconciled = await reconcileAmbiguousPromotion(
        leadershipPublisherUrl,
        candidate,
      );
      promotionStateKnown = true;
      promoted = reconciled.promoted;
    }
    await claimedEvent(studio, jobId, token, "SNAPSHOT_BUILT", {
      preflightReceiptId: job.preflightReceiptId,
      releaseId: candidate.releaseId,
      manifestHash: candidate.manifestHash,
      candidateHash: candidate.candidateHash,
      artifactCount: candidate.artifactCount,
      edgeCount: candidate.edgeCount,
      exactPersistedBytes: Boolean(candidate.allArtifacts),
    });
    await claimedEvent(studio, jobId, token, "VALIDATED", {
      targetRevisionId: job.targetRevisionId,
      targetBundleHash: job.targetBundleHash,
      manifestHash: candidate.manifestHash,
      candidateHash: candidate.candidateHash,
      compilerDigest: candidate.compilerDigest,
    });
    await dependencies.afterBoundary?.("CANDIDATE_PERSISTED");
    let activeCapabilities = await convergedRuntimeCapabilities(
      dependencies,
      () => renewPublicationLease(studio, jobId, token),
    );
    await renewPublicationLease(studio, jobId, token);
    await assertPublicationFence(studio, {
      jobId,
      claimToken: token,
      situationId: job.situationId,
      checkoutId: job.checkoutId,
      checkoutFence: job.checkoutFence,
    });

    leadership = new Client({
      connectionString: leadershipPublisherUrl,
      application_name: "situation-studio-publisher",
      statement_timeout: 120_000,
    });
    await leadership.connect();
    const before = await databaseIdentity(leadership);
    // A retry may begin after the prior worker committed promotion. Remember
    // that external fact before any subsequent candidate/runtime validation so
    // a definitive mismatch restores instead of leaving the bad pointer live.
    promoted = before.releaseId === candidate.releaseId;
    if (
      before.releaseId !== candidate.releaseId &&
      (before.releaseId !== candidate.parentReleaseId ||
        (job.preflightReceipt !== null &&
          before.manifestHash !== job.preflightReceipt.baseManifestHash) ||
        before.generation !== candidate.expectedGeneration)
    ) {
      await claimedTransitionWithEvent(studio, {
        jobId,
        claimToken: token,
        data: {
          state: "NEEDS_REFRESH",
          observedReleaseId: before.releaseId,
          failureCode: "PREFLIGHT_BASE_CHANGED",
          finishedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        },
        eventKind: "CONFLICTED",
        eventPayload: {
          expectedReleaseId: candidate.parentReleaseId,
          expectedManifestHash: job.preflightReceipt?.baseManifestHash,
          expectedGeneration: candidate.expectedGeneration.toString(),
          observedReleaseId: before.releaseId,
          observedManifestHash: before.manifestHash,
          observedGeneration: before.generation.toString(),
          candidateHash: candidate.candidateHash,
        },
      });
      await studio.publicationAttempt.update({
        where: { id: attempt.id },
        data: {
          finishedAt: new Date(),
          reconciledState: { outcome: "NEEDS_REFRESH" },
        },
      });
      return;
    }
    await claimedEvent(studio, jobId, token, "POINTER_OBSERVED", {
      releaseId: before.releaseId,
      manifestHash: before.manifestHash,
      generation: before.generation.toString(),
    });
    if (job.state !== "VERIFYING")
      await claimedJobUpdate(
        studio,
        jobId,
        token,
        {
          state: "PROMOTING",
          observedReleaseId: candidate.parentReleaseId,
          expectedPointerGeneration: candidate.expectedGeneration,
          leadershipReleaseId: candidate.releaseId,
          leadershipManifestHash: candidate.manifestHash,
          previousReleaseId: candidate.parentReleaseId,
        },
        ["ASSEMBLING", "PROMOTING"],
      );

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
    if (existing) {
      if (
        existing.id !== candidate.releaseId ||
        existing.manifest_hash !== candidate.manifestHash
      )
        throw new PublisherCandidateContractError(
          new Error("Reconciled publication release differs from preflight."),
        );
      await assertLeadershipReleaseMatchesCandidate(leadership, candidate);
    }
    if (before.releaseId !== candidate.releaseId) {
      promotionAttempted = true;
      promotionStateKnown = false;
      let insertion: Awaited<ReturnType<typeof insertAndPromote>>;
      try {
        insertion = await withPublicationLeaseHeartbeat(
          studio,
          {
            jobId,
            situationId: job.situationId,
            checkoutId: job.checkoutId,
            checkoutFence: job.checkoutFence,
            claimToken: token,
            heartbeatMs: dependencies.publicationLeaseHeartbeatMs,
          },
          (assertAuthority) =>
            insertAndPromote(leadership!, candidate, {
              beforePromotion: async () => {
                await dependencies.afterBoundary?.(
                  "LEADERSHIP_PROMOTION_READY",
                );
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
        if (!insertion.pointerChanged)
          await dependencies.afterPromotionCommit?.();
        promotionStateKnown = true;
      } catch (error) {
        const reconciled = await reconcileAmbiguousPromotion(
          leadershipPublisherUrl,
          candidate,
        );
        promotionStateKnown = true;
        if (!reconciled.promoted) throw error;
        promoted = true;
        insertion = { inserted: false };
        await leadership.end().catch(() => undefined);
        leadership = new Client({
          connectionString: leadershipPublisherUrl,
          application_name: "situation-studio-publisher-reconciled",
          statement_timeout: 120_000,
        });
        await leadership.connect();
      }
      if (insertion.pointerChanged) {
        const observed = await databaseIdentity(leadership);
        await claimedTransitionWithEvent(studio, {
          jobId,
          claimToken: token,
          data: {
            state: "NEEDS_REFRESH",
            observedReleaseId: observed.releaseId,
            failureCode: "PREFLIGHT_BASE_CHANGED",
            finishedAt: new Date(),
            claimToken: null,
            leaseExpiresAt: null,
          },
          eventKind: "CONFLICTED",
          eventPayload: {
            candidateHash: candidate.candidateHash,
            expectedReleaseId: candidate.parentReleaseId,
            observedReleaseId: observed.releaseId,
            observedManifestHash: observed.manifestHash,
            observedGeneration: observed.generation.toString(),
          },
        });
        await studio.publicationAttempt.update({
          where: { id: attempt.id },
          data: {
            finishedAt: new Date(),
            reconciledState: { outcome: "NEEDS_REFRESH" },
          },
        });
        return;
      }
      promoted = true;
      await dependencies.afterBoundary?.("LEADERSHIP_PROMOTION_COMMITTED");
      await claimedEvent(studio, jobId, token, "RELEASE_INSERTED", {
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
    await renewPublicationLease(studio, jobId, token);
    await claimedJobUpdate(studio, jobId, token, {
      state: "VERIFYING",
      leaseExpiresAt: new Date(Date.now() + 180_000),
    });
    await claimedEvent(studio, jobId, token, "POINTER_ADVANCED", {
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
      () => renewPublicationLease(studio, jobId, token),
    );
    if (
      runtime.releaseId !== candidate.releaseId ||
      runtime.manifestHash !== candidate.manifestHash
    )
      throw new Error("Running Leadership application identity differs.");
    const routeCapabilitiesBefore = await convergedRuntimeCapabilities(
      dependencies,
      () => renewPublicationLease(studio, jobId, token),
    );
    const routeProof = await convergedRuntimeRouteProof(
      dependencies,
      routeExpectation(candidate),
      () => renewPublicationLease(studio, jobId, token),
    );
    const routeCapabilitiesAfter = await convergedRuntimeCapabilities(
      dependencies,
      () => renewPublicationLease(studio, jobId, token),
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
    runtimeVerified = true;
    await dependencies.afterBoundary?.("RUNTIME_VERIFIED");
    await renewPublicationLease(studio, jobId, token);
    job = await loadJob(studio, jobId);
    await finalizeSuccess(
      studio,
      job,
      token,
      attempt.id,
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
    if (!job || !attempt) throw error;
    const failureCode = publicationFailureCode(error);
    const failureDetail = safePublicationFailureDetail(error);
    if (runtimeVerified) {
      const finalized = await studio.publicationJob.findUnique({
        where: { id: jobId },
        include: { receipt: true },
      });
      if (
        finalized?.state === "SUCCEEDED" &&
        finalized.receipt?.expectedReleaseId === activeCandidate?.releaseId &&
        finalized.receipt?.expectedManifestHash ===
          activeCandidate?.manifestHash
      )
        return;
      dependencies.onFailure?.(error);
      await claimedJobUpdate(
        studio,
        jobId,
        token,
        { claimToken: null, leaseExpiresAt: null },
        ["VERIFYING"],
      ).catch(() => undefined);
      await studio.publicationAttempt.update({
        where: { id: attempt.id },
        data: {
          finishedAt: new Date(),
          failureCode: "STUDIO_FINALIZATION_RETRY",
          reconciledState: {
            failureCode,
            promoted: true,
            runtimeVerified: true,
            restorationSuppressed: true,
          },
        },
      });
      return;
    }
    dependencies.onFailure?.(error);
    if (promotionAttempted && !promotionStateKnown && activeCandidate) {
      try {
        const reconciled = await reconcileAmbiguousPromotion(
          leadershipPublisherUrl,
          activeCandidate,
        );
        promoted = reconciled.promoted;
        promotionStateKnown = true;
      } catch {
        promotionStateKnown = false;
      }
    }
    const promotionStateUnverified =
      promotionAttempted && !promoted && !promotionStateKnown;
    if (promoted) {
      job = await loadJob(studio, jobId);
      await beginAutomaticRestoration(studio, {
        jobId,
        previousReleaseId: job.previousReleaseId,
        reason: failureCode,
        failureDetail,
        claimToken: token,
      });
      let restored: Awaited<ReturnType<typeof databaseIdentity>>;
      let recoveryLeadership: Client | null = null;
      try {
        recoveryLeadership = new Client({
          connectionString: leadershipPublisherUrl,
          application_name: "situation-studio-publisher-restorer",
          statement_timeout: 120_000,
        });
        await recoveryLeadership.connect();
        const current = await databaseIdentity(recoveryLeadership);
        const candidate =
          activeCandidate ??
          (await candidateFromPersisted(leadershipPublisherUrl, job));
        await restorePrevious(
          recoveryLeadership,
          candidate,
          current.generation,
        );
        restored = await databaseIdentity(recoveryLeadership);
        const runtime = await convergedRuntimeIdentity(
          dependencies,
          {
            releaseId: restored.releaseId,
            manifestHash: restored.manifestHash,
          },
          () => renewPublicationLease(studio, jobId, token),
        );
        if (
          restored.releaseId !== candidate.parentReleaseId ||
          runtime.releaseId !== candidate.parentReleaseId ||
          restored.manifestHash !== runtime.manifestHash
        )
          throw new Error("Prior official release could not be verified.");
      } catch (restorationError) {
        const recoveryFailureDetail =
          safePublicationFailureDetail(restorationError);
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
            promotionStateUnverified,
            ...(failureDetail ? { failureDetail } : {}),
            ...(recoveryFailureDetail ? { recoveryFailureDetail } : {}),
          },
          claimToken: token,
          expectedStates: ["RECOVERY_REQUIRED"],
        });
        return;
      } finally {
        await recoveryLeadership?.end().catch(() => undefined);
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
          promotionStateUnverified,
          ...(failureDetail ? { failureDetail } : {}),
        },
        claimToken: token,
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
          promotionStateUnverified,
          ...(failureDetail ? { failureDetail } : {}),
        },
        claimToken: token,
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
          promotionStateUnverified,
          ...(failureDetail ? { failureDetail } : {}),
        },
        claimToken: token,
        expectedStates: ["REQUESTED", "ASSEMBLING", "PROMOTING", "VERIFYING"],
      });
    }
  } finally {
    await leadership?.end().catch(() => undefined);
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
