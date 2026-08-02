import { Prisma, type DatabaseClient } from "@situation-studio/db";
import {
  PUBLISHABLE_CONTRACT_VERSION,
  PUBLISHABLE_VALIDATION_POLICY_VERSION,
  DeterministicChangeApplicationError,
  applyDeterministicSituationChange,
  assertSafeManagedMdx,
  bundleHash,
  compilePublishableSituationSnapshot,
  canonicalText,
  createScopedVariant,
  parseManagedSituationComponents,
  normalizeSituationSectionReplacement,
  proposalPreservesManagedMdxComponents as sharedProposalPreservesManagedMdxComponents,
  requiredSituationSections,
  reviewStages,
  serializeSituationSections,
  sha256,
  situationBundleSchema,
  publishableSituationBundleSchema,
  publishableBundleHash,
  publicationConflictDecision,
  PUBLICATION_COMPILER_DIGEST,
  PUBLICATION_COMPILER_IDENTITY,
  toPublishableSituationSnapshot,
  validatePublishableSituationSnapshot,
  validateScopedArtifactBody,
  validateSituationBundle,
  type SituationBundle,
  type SituationSections,
  type PublishableSituationBundle,
  type PublishableSituationSnapshot,
} from "@situation-studio/domain";
import { REVIEW_POLICY_VERSION } from "@situation-studio/review-policy";
import {
  LeadershipCapabilityError,
  readOfficialLeadershipCompilationBase,
  readOfficialLeadershipRelease,
} from "@situation-studio/leadership-bridge";
import { database } from "@/server/database";
import {
  PUBLICATION_BACKUP_NOT_READY_CODE,
  publicationBackupStatus,
  type PublicationBackupStatus,
} from "@/server/health/publication-backup-policy";
import { verifyExactScopedArtifactDescriptors } from "@/publication-preflight";
import { environment } from "@/server/environment";
import { requireCompatibleLeadershipRuntime } from "@/server/leadership-compatibility";
import { reconcileLeadershipRelease } from "@/server/leadership-sync";

type Transaction = Parameters<Parameters<DatabaseClient["$transaction"]>[0]>[0];

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = "WORKFLOW_CONFLICT",
    readonly details?: unknown,
  ) {
    super(message);
  }
}

const activePublicationStates = [
  "REQUESTED",
  "ASSEMBLING",
  "PROMOTING",
  "VERIFYING",
] as const;

async function assertNoPublicationRecovery(transaction: Transaction) {
  const recovery = await transaction.publicationJob.findFirst({
    where: { state: "RECOVERY_REQUIRED" },
    select: { id: true },
  });
  if (recovery)
    throw new WorkflowError(
      "Editorial changes are locked while publication recovery is required.",
      409,
      "PUBLICATION_RECOVERY_REQUIRED",
    );
}

async function publicationBackupStatusForTransaction(
  transaction: Transaction,
): Promise<PublicationBackupStatus> {
  const latestVerifiedBackup = await transaction.backupReceipt.findFirst({
    where: {
      state: "VERIFIED",
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      destinationId: true,
      encrypted: true,
      objectKey: true,
      checksum: true,
      byteLength: true,
      verifiedAt: true,
    },
  });
  const latestRestoreDrill = await transaction.backupReceipt.findFirst({
    where: {
      state: "VERIFIED",
      OR: [
        { restoreDrillAt: { not: null } },
        { restoreDrillResult: { not: null } },
      ],
    },
    orderBy: [
      { restoreDrillAt: { sort: "desc", nulls: "first" } },
      { createdAt: "desc" },
      { id: "desc" },
    ],
    select: {
      destinationId: true,
      encrypted: true,
      objectKey: true,
      checksum: true,
      byteLength: true,
      verifiedAt: true,
      createdAt: true,
      restoreDrillAt: true,
      restoreDrillResult: true,
    },
  });
  return publicationBackupStatus({
    latestVerifiedBackup,
    latestRestoreDrill,
  });
}

export async function publicationBackupReadiness() {
  return database().$transaction(
    (transaction) => publicationBackupStatusForTransaction(transaction),
    { isolationLevel: "Serializable" },
  );
}

function assertManagedSituationMdx(body: string) {
  try {
    assertSafeManagedMdx(body, "situation draft");
  } catch (error) {
    throw new WorkflowError(
      error instanceof Error
        ? error.message
        : "The situation contains unsafe managed MDX.",
      422,
      "UNSAFE_MANAGED_MDX",
    );
  }
}

async function assertNoActivePublication(
  transaction: Transaction,
  situationId: string,
) {
  await assertNoPublicationRecovery(transaction);
  const publication = await transaction.publicationJob.findFirst({
    where: { situationId, state: { in: [...activePublicationStates] } },
    select: { id: true },
  });
  if (publication)
    throw new WorkflowError(
      "The situation is read-only while publication is active.",
      409,
      "PUBLICATION_ACTIVE",
    );
}

async function assertNoActiveReview(
  transaction: Transaction,
  situationId: string,
) {
  const review = await transaction.reviewJob.findFirst({
    where: { situationId, state: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true },
  });
  if (review)
    throw new WorkflowError(
      "The situation is read-only while review is queued or running.",
      409,
      "REVIEW_ACTIVE",
    );
}

async function assertDraftMutationAllowed(
  transaction: Transaction,
  situationId: string,
) {
  await assertNoActivePublication(transaction, situationId);
}

async function assertSharedPublishableSnapshot(
  transaction: Transaction,
  bundle: SituationBundle,
  body: string,
) {
  if (bundle.schemaVersion !== "situation-bundle-v2") return null;
  if (bundle.visibility === "UNPUBLISHED")
    throw new WorkflowError(
      "This older draft must set an explicit Public publication intent before it can be saved as a canonical snapshot.",
      422,
      "PUBLICATION_INTENT_REQUIRED",
    );
  const persisted = await transaction.scopedArtifactVariant.findMany({
    where: {
      ownerSituationId: bundle.situationId,
      logicalId: { in: bundle.artifacts.map((artifact) => artifact.logicalId) },
    },
    include: { content: true },
  });
  const exact = verifyExactScopedArtifactDescriptors({
    situationId: bundle.situationId,
    situationSlug: bundle.metadata.slug,
    descriptors: bundle.artifacts,
    persisted,
  });
  if (!exact.ok)
    throw new WorkflowError(
      exact.errors.join(" "),
      422,
      "INVALID_SCOPED_ARTIFACT",
      { diagnostics: exact.errors },
    );
  let snapshot: PublishableSituationSnapshot;
  try {
    snapshot = toPublishableSituationSnapshot({
      bundle,
      body,
      scopedArtifactBodies: exact.bodies,
    });
  } catch (error) {
    throw new WorkflowError(
      error instanceof Error ? error.message : String(error),
      422,
      "INVALID_CONTENT",
    );
  }
  const validated = await validatePublishableSituationSnapshot(snapshot);
  if (!validated.ok)
    throw new WorkflowError(
      validated.diagnostics
        .map(
          (diagnostic) =>
            `${diagnostic.path.join(".") || "snapshot"}: ${diagnostic.message}`,
        )
        .join(" "),
      422,
      "INVALID_CONTENT",
      { diagnostics: validated.diagnostics },
    );
  return validated;
}

const templateSections = Object.fromEntries(
  requiredSituationSections.map((section) => [
    section,
    section === "The short answer"
      ? "Name what you are seeing, ask for their view, and agree on one concrete next move."
      : `Add specific, evidence-based guidance for ${section.toLowerCase()}.`,
  ]),
) as SituationSections;

export function newSituationTemplate(input: {
  situationId: string;
  slug: string;
  title: string;
  today?: string;
  defaultPractice: SituationBundle["relationships"][number];
  defaultSource: SituationBundle["relationships"][number];
  defaultSourceReference: string;
  defaultRelatedSituationIds: string[];
}): { bundle: SituationBundle; body: string } {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const practiceId = input.defaultPractice.logicalId.replace(/^practice:/u, "");
  const sections = {
    ...templateSections,
    "Two-minute practice": `<PracticeEmbed compact practiceId="${practiceId}" surface="situation" variant="default" />`,
    "I have my next move": `<PreparedAction scenario="${input.slug}" skill="coaching" />`,
  };
  const body = serializeSituationSections(sections);
  const metadata: PublishableSituationBundle["metadata"] = {
    slug: input.slug,
    title: input.title,
    description:
      "A practical field guide for understanding the pattern, choosing a responsible response, and following through.",
    stakes:
      "The situation affects trust, clarity, delivery, and the conditions people need to do good work together.",
    primarySkill: "coaching",
    preparationTime: "15 minutes",
    emotionalLoad: "medium",
    pattern: "first-occurrence",
    scope: "individual",
    tags: ["coaching", "conversation"],
    audience: ["manager"],
    support: [],
    published: today,
    lastReviewed: today,
    author: "studio-editor",
    reviewer: "studio-editor",
    sourceReferences: [input.defaultSourceReference],
    relatedSituationIds: input.defaultRelatedSituationIds,
    practiceId,
    practiceVariant: "default",
    fieldNotePresent: true,
    safetyEscalationNotePresent: true,
    socialHook:
      "A clear next move for the management conversation you have been postponing.",
    campaignCluster: "manager_conversations",
    reviewStatus: "human-approved",
  };
  const practice = input.defaultPractice;
  const source = input.defaultSource;
  const relationships: PublishableSituationBundle["relationships"] = [
    {
      ...practice,
      kind: "PRACTICE",
      originalLogicalId:
        (practice as { originalLogicalId?: string }).originalLogicalId ??
        practice.logicalId,
    },
    {
      ...source,
      kind: "SOURCE",
      originalLogicalId:
        (source as { originalLogicalId?: string }).originalLogicalId ??
        source.logicalId,
    },
  ];
  return {
    body,
    bundle: publishableSituationBundleSchema.parse({
      schemaVersion: "situation-bundle-v2",
      contractVersion: PUBLISHABLE_CONTRACT_VERSION,
      validationPolicyVersion: PUBLISHABLE_VALIDATION_POLICY_VERSION,
      situationId: input.situationId,
      visibility: "PUBLIC",
      metadata,
      bodyHash: sha256(body),
      managedComponents: parseManagedSituationComponents(
        `content/situations/${input.slug}.mdx`,
        body,
      ),
      artifacts: [],
      relationships,
      promotion: {
        status: "human-review-required",
        canonical: `/situations/${input.slug}`,
        socialDrafts: [metadata.socialHook],
        scenarioQuestion: `What would you do next in ${metadata.title}?`,
        pullQuoteIdea: metadata.socialHook,
        utm: {
          campaign: metadata.campaignCluster,
          content: input.slug.replaceAll("-", "_"),
        },
        ogPreview: `/situations/${input.slug}/opengraph-image`,
      },
      contextHashes: relationships.map(
        (relationship) => relationship.contentHash,
      ),
    }),
  };
}

async function defaultTemplateContext(
  transaction: Transaction,
  newSituationSlug: string,
) {
  const versions = await transaction.productionSituationVersion.findMany({
    orderBy: { productionAt: "desc" },
    distinct: ["situationId"],
    select: { situationId: true, bundleManifest: true },
  });
  let practice: SituationBundle["relationships"][number] | undefined;
  let source:
    | {
        relationship: SituationBundle["relationships"][number];
        reference: string;
      }
    | undefined;
  const relatedSituationIds: string[] = [];
  for (const version of versions) {
    const bundle = situationBundleSchema.safeParse(version.bundleManifest);
    if (!bundle.success) continue;
    if (
      bundle.data.metadata.slug !== newSituationSlug &&
      !relatedSituationIds.includes(bundle.data.metadata.slug)
    )
      relatedSituationIds.push(bundle.data.metadata.slug);
    const practices = bundle.data.relationships.filter(
      (relationship) =>
        relationship.kind === "PRACTICE" &&
        relationship.visibility === "GLOBAL",
    );
    const preferred = practices.find(
      (relationship) => relationship.logicalId === "practice:listen-first",
    );
    practice = preferred ?? practice ?? practices[0];
    if (!source && bundle.data.schemaVersion === "situation-bundle-v2") {
      const relationship = bundle.data.relationships.find(
        (candidate) =>
          candidate.kind === "SOURCE" && candidate.visibility === "GLOBAL",
      );
      if (relationship) {
        const logicalReference = relationship.originalLogicalId.replace(
          /^source:/u,
          "",
        );
        source = {
          relationship,
          reference: bundle.data.metadata.sourceReferences.includes(
            logicalReference,
          )
            ? logicalReference
            : bundle.data.metadata.sourceReferences[0]!,
        };
      }
    }
  }
  if (!practice || !source || relatedSituationIds.length < 2) return null;
  return {
    defaultPractice: { ...practice, position: 0 },
    defaultSource: { ...source.relationship, position: 0 },
    defaultSourceReference: source.reference,
    defaultRelatedSituationIds: relatedSituationIds.slice(0, 2),
  };
}

async function putTextBlob(
  transaction: Transaction,
  body: string,
  mediaType = "text/mdx; charset=utf-8",
) {
  const canonical = canonicalText(body);
  const hash = sha256(canonical);
  await transaction.contentBlob.createMany({
    data: {
      hash,
      encoding: "UTF8",
      mediaType,
      byteLength: new TextEncoder().encode(canonical).byteLength,
      textBody: canonical,
    },
    skipDuplicates: true,
  });
  return { hash, body: canonical };
}

function canonicalScopedArtifactPath(input: {
  slug: string;
  kind: string;
  logicalId: string;
  mediaType: string;
}) {
  const identity = input.logicalId
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const extension = input.mediaType.startsWith("application/json")
    ? "json"
    : "mdx";
  return `content/scoped/${input.slug}/${input.kind.toLowerCase()}/${identity}.${extension}`;
}

async function synchronizeLegacyBundle(
  transaction: Transaction,
  input: {
    draftId: string;
    situationId: string;
    bundle: SituationBundle;
    body: string;
    authoritativeBase?: PublishableSituationBundle;
  },
): Promise<SituationBundle> {
  if (input.bundle.schemaVersion === "situation-bundle-v2") return input.bundle;
  const draft = await transaction.draft.findUniqueOrThrow({
    where: { id: input.draftId },
    include: {
      baseProductionVersion: true,
    },
  });
  const base = input.authoritativeBase
    ? { success: true as const, data: input.authoritativeBase }
    : draft.baseProductionVersion
      ? publishableSituationBundleSchema.safeParse(
          draft.baseProductionVersion.bundleManifest,
        )
      : null;
  if (!base?.success)
    throw new WorkflowError(
      "This legacy draft has no exact Leadership snapshot to synchronize from. Check it in, synchronize production, and check it out again.",
      409,
      "LEGACY_DRAFT_REQUIRES_SYNC",
    );
  const baseBundle = base.data;
  const relationships = input.bundle.relationships.map(
    (relationship, position) => {
      const baseline = baseBundle.relationships.find(
        (candidate) =>
          candidate.logicalId === relationship.logicalId ||
          candidate.originalLogicalId === relationship.logicalId,
      );
      return {
        ...relationship,
        originalLogicalId:
          baseline?.originalLogicalId ?? relationship.logicalId,
        position,
      };
    },
  );
  const artifacts = input.bundle.artifacts.map((artifact) => {
    const baseline = baseBundle.artifacts.find(
      (candidate) => candidate.logicalId === artifact.logicalId,
    );
    const selectedMediaType =
      artifact.kind === "PRACTICE" || artifact.kind === "SOURCE"
        ? "application/json; charset=utf-8"
        : "text/mdx; charset=utf-8";
    return {
      ...artifact,
      path:
        baseline?.path ??
        canonicalScopedArtifactPath({
          slug: input.bundle.metadata.slug,
          kind: artifact.kind,
          logicalId: artifact.logicalId,
          mediaType: selectedMediaType,
        }),
      encoding: baseline?.encoding ?? "UTF8",
      mediaType: baseline?.mediaType ?? selectedMediaType,
    };
  });
  try {
    return publishableSituationBundleSchema.parse({
      schemaVersion: "situation-bundle-v2",
      contractVersion: PUBLISHABLE_CONTRACT_VERSION,
      validationPolicyVersion: PUBLISHABLE_VALIDATION_POLICY_VERSION,
      situationId: input.situationId,
      visibility: input.bundle.visibility,
      metadata: {
        ...baseBundle.metadata,
        ...input.bundle.metadata,
      },
      bodyHash: sha256(canonicalText(input.body)),
      managedComponents: parseManagedSituationComponents(
        `content/situations/${input.bundle.metadata.slug}.mdx`,
        input.body,
      ),
      artifacts,
      relationships,
      promotion:
        input.bundle.visibility === "RETIRED" ? null : input.bundle.promotion,
      contextHashes: relationships.map(
        (relationship) => relationship.contentHash,
      ),
    });
  } catch (error) {
    throw new WorkflowError(
      `The legacy draft could not be synchronized safely: ${error instanceof Error ? error.message : String(error)}`,
      422,
      "LEGACY_DRAFT_SYNC_INVALID",
    );
  }
}

async function createRevision(
  transaction: Transaction,
  input: {
    draftId: string;
    actorId: string;
    bundle: SituationBundle;
    body: string;
    namedCheckpoint: string;
    expectedParentRevisionId?: string;
    expectedParentBundleHash?: string;
    preserveProposalId?: string;
  },
) {
  const draft = await transaction.draft.findUniqueOrThrow({
    where: { id: input.draftId },
    include: {
      revisions: {
        orderBy: { revision: "desc" },
        take: 1,
        include: { artifacts: { include: { content: true } } },
      },
    },
  });
  const canonicalBody = canonicalText(input.body);
  const parsedBundle = situationBundleSchema.parse({
    ...input.bundle,
    bodyHash: sha256(canonicalBody),
  });
  await assertSharedPublishableSnapshot(
    transaction,
    parsedBundle,
    canonicalBody,
  );
  const nextBundleHash = bundleHash(parsedBundle);
  const previous = draft.revisions[0];
  if (
    input.expectedParentRevisionId !== undefined &&
    (previous?.id !== input.expectedParentRevisionId ||
      previous.bundleHash !== input.expectedParentBundleHash)
  )
    throw new WorkflowError(
      "This draft changed before the save completed. Reload the authoritative revision before saving again.",
      409,
      "STALE_REVISION",
    );
  if (previous?.bundleHash === nextBundleHash) return previous;
  const blob = await putTextBlob(transaction, canonicalBody);
  const revision = await transaction.draftRevision.create({
    data: {
      draftId: draft.id,
      revision: draft.currentRevisionNumber + 1,
      parentId: previous?.id ?? null,
      bundleHash: nextBundleHash,
      bundleManifest: parsedBundle as Prisma.InputJsonValue,
      contractVersion: parsedBundle.contractVersion,
      validationPolicy: parsedBundle.validationPolicyVersion,
      actorId: input.actorId,
      namedCheckpoint: input.namedCheckpoint,
      artifacts: {
        create: [
          {
            logicalId: `situation:${parsedBundle.metadata.slug}`,
            kind: "SITUATION",
            visibility:
              parsedBundle.visibility === "PUBLIC" ? "GLOBAL" : "INTERNAL",
            contentHash: blob.hash,
            position: 0,
            metadata: { role: "primary-body" },
          },
        ],
      },
    },
    include: { artifacts: { include: { content: true } } },
  });
  const advanced = await transaction.draft.updateMany({
    where: {
      id: draft.id,
      currentRevisionNumber: draft.currentRevisionNumber,
      currentBundleHash: draft.currentBundleHash,
    },
    data: {
      currentRevisionNumber: revision.revision,
      currentBundleHash: revision.bundleHash,
    },
  });
  if (advanced.count !== 1)
    throw new WorkflowError(
      "This draft changed before the revision could be recorded. Reload and retry.",
      409,
      "STALE_REVISION",
    );
  if (previous)
    await transaction.reviewProposal.updateMany({
      where: {
        currentRevisionId: previous.id,
        supersededAt: null,
        ...(input.preserveProposalId
          ? { id: { not: input.preserveProposalId } }
          : {}),
      },
      data: {
        supersededAt: new Date(),
        supersededByRevisionId: revision.id,
      },
    });
  return revision;
}

function authoritativeRevisionPayload(
  revision: Awaited<ReturnType<typeof createRevision>>,
) {
  const body = revision.artifacts.find(
    (artifact) => artifact.kind === "SITUATION",
  )?.content.textBody;
  if (!body)
    throw new WorkflowError(
      "The authoritative revision body is unavailable.",
      500,
      "REVISION_BODY_MISSING",
    );
  return {
    revisionId: revision.id,
    revision: revision.revision,
    bundleHash: revision.bundleHash,
    bundle: situationBundleSchema.parse(revision.bundleManifest),
    body,
    savedAt: revision.createdAt.toISOString(),
  };
}

async function createDraftFromProduction(
  transaction: Transaction,
  situation: {
    id: string;
    slug: string;
    title: string;
    productionBundleHash: string | null;
    productionReleaseId: string | null;
  },
  actorId: string,
) {
  const baseVersion = await transaction.productionSituationVersion.findFirst({
    where: { situationId: situation.id },
    orderBy: { productionAt: "desc" },
    include: {
      observation: true,
      artifacts: { include: { content: true }, orderBy: { position: "asc" } },
    },
  });
  const lineage =
    (
      await transaction.draft.aggregate({
        where: { situationId: situation.id },
        _max: { lineage: true },
      })
    )._max.lineage ?? 0;
  const draft = await transaction.draft.create({
    data: {
      situationId: situation.id,
      lineage: lineage + 1,
      baseProductionVersionId: baseVersion?.id ?? null,
      baseReleaseId: baseVersion?.observation.releaseId ?? null,
      baseManifestHash: baseVersion?.observation.manifestHash ?? null,
      basePointerGeneration: baseVersion?.observation.pointerGeneration ?? null,
      baseBundleHash: baseVersion?.bundleHash ?? null,
    },
  });
  const body =
    baseVersion?.artifacts.find((artifact) => artifact.kind === "SITUATION")
      ?.content.textBody ?? null;
  const defaultContext = baseVersion
    ? undefined
    : await defaultTemplateContext(transaction, situation.slug);
  if (!baseVersion && !defaultContext)
    throw new WorkflowError(
      "A new situation requires a synchronized Leadership practice, source, and at least two related situations. Synchronize production before creating it.",
      422,
      "NEW_SITUATION_CONTEXT_REQUIRED",
    );
  const baseline = baseVersion
    ? {
        bundle: situationBundleSchema.parse(baseVersion.bundleManifest),
        body: body ?? "",
      }
    : newSituationTemplate({
        situationId: situation.id,
        slug: situation.slug,
        title: situation.title,
        ...defaultContext!,
      });
  await createRevision(transaction, {
    draftId: draft.id,
    actorId,
    bundle: baseline.bundle,
    body: baseline.body,
    namedCheckpoint: baseVersion ? "Checked out from production" : "Created",
  });
  return transaction.draft.findUniqueOrThrow({ where: { id: draft.id } });
}

export async function createSituation(input: {
  actorId: string;
  slug: string;
  title: string;
}) {
  return database().$transaction(
    async (transaction) => {
      await assertNoPublicationRecovery(transaction);
      const situation = await transaction.situation.create({
        data: {
          slug: input.slug,
          title: input.title,
          visibility: "UNPUBLISHED",
        },
      });
      const draft = await createDraftFromProduction(
        transaction,
        situation,
        input.actorId,
      );
      const fenced = await transaction.situation.update({
        where: { id: situation.id },
        data: { fence: { increment: 1 } },
      });
      const checkout = await transaction.situationCheckout.create({
        data: {
          situationId: situation.id,
          holderId: input.actorId,
          draftId: draft.id,
          fence: fenced.fence,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "SITUATION_CREATED",
          subjectType: "SITUATION",
          subjectId: situation.id,
          payload: { slug: situation.slug },
        },
      });
      return { situation, draft, checkout };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function checkoutSituation(input: {
  situationId: string;
  actorId: string;
}) {
  await reconcileLeadershipRelease();
  try {
    return await database().$transaction(
      async (transaction) => {
        await assertNoPublicationRecovery(transaction);
        const situation = await transaction.situation.findUniqueOrThrow({
          where: { id: input.situationId },
        });
        const existingCheckout = await transaction.situationCheckout.findFirst({
          where: { situationId: situation.id, releasedAt: null },
          include: { holder: { select: { displayName: true } } },
        });
        if (existingCheckout)
          throw new WorkflowError(
            `This situation is checked out by ${existingCheckout.holder.displayName}.`,
          );
        let draft = await transaction.draft.findFirst({
          where: { situationId: situation.id, state: "ACTIVE" },
          orderBy: { lineage: "desc" },
        });
        if (!draft)
          draft = await createDraftFromProduction(
            transaction,
            situation,
            input.actorId,
          );
        else if (
          draft.baseBundleHash &&
          situation.productionBundleHash !== draft.baseBundleHash
        )
          draft = await transaction.draft.update({
            where: { id: draft.id },
            data: { conflictedAt: new Date() },
          });
        else if (situation.productionReleaseId !== draft.baseReleaseId)
          draft = await transaction.draft.update({
            where: { id: draft.id },
            data: { rebaseReleaseId: situation.productionReleaseId },
          });
        const fenced = await transaction.situation.update({
          where: { id: situation.id },
          data: { fence: { increment: 1 } },
        });
        const checkout = await transaction.situationCheckout.create({
          data: {
            situationId: situation.id,
            holderId: input.actorId,
            draftId: draft.id,
            fence: fenced.fence,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: input.actorId,
            action: "SITUATION_CHECKED_OUT",
            subjectType: "SITUATION",
            subjectId: situation.id,
            payload: {
              checkoutId: checkout.id,
              fence: checkout.fence.toString(),
            },
          },
        });
        return checkout;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new WorkflowError(
        "Another editor completed checkout first. The current owner is shown in the inventory.",
      );
    throw error;
  }
}

export async function saveDraft(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  bundle: unknown;
  body: string;
  expectedParentRevisionId: string;
  expectedParentBundleHash: string;
  namedCheckpoint?: string;
}) {
  let authoritativeLegacyBase: PublishableSituationBundle | undefined;
  if (
    input.bundle &&
    typeof input.bundle === "object" &&
    (input.bundle as { schemaVersion?: unknown }).schemaVersion ===
      "situation-bundle-v1"
  ) {
    const checkout = await database().situationCheckout.findFirst({
      where: {
        id: input.checkoutId,
        holderId: input.actorId,
        fence: input.fence,
        releasedAt: null,
      },
      include: { situation: true },
    });
    const leadershipUrl = environment().LEADERSHIP_STUDIO_READER_DATABASE_URL;
    if (!checkout || !leadershipUrl)
      throw new WorkflowError(
        "This legacy draft needs a live read-only Leadership synchronization before it can be saved.",
        409,
        "LEGACY_DRAFT_REQUIRES_SYNC",
      );
    const official = await readOfficialLeadershipRelease(leadershipUrl);
    if (official.identity.releaseId !== checkout.situation.productionReleaseId)
      throw new WorkflowError(
        "Leadership changed while this legacy draft was open. Refresh production before synchronizing it.",
        409,
        "LEGACY_DRAFT_REQUIRES_SYNC",
      );
    const authoritative = official.situations.find(
      (situation) => situation.slug === checkout.situation.slug,
    );
    if (!authoritative)
      throw new WorkflowError(
        "The legacy draft has no matching Leadership situation snapshot.",
        409,
        "LEGACY_DRAFT_REQUIRES_SYNC",
      );
    authoritativeLegacyBase = publishableSituationBundleSchema.parse({
      ...authoritative.bundle,
      situationId: checkout.situationId,
    });
  }
  try {
    return await database().$transaction(
      async (transaction) => {
        const checkout = await transaction.situationCheckout.findFirst({
          where: {
            id: input.checkoutId,
            holderId: input.actorId,
            fence: input.fence,
            releasedAt: null,
          },
          include: {
            situation: true,
            draft: true,
          },
        });
        if (!checkout)
          throw new WorkflowError(
            "The checkout changed. Reload before saving.",
            409,
            "STALE_CHECKOUT",
          );
        await assertDraftMutationAllowed(transaction, checkout.situationId);
        const previousRevision = await transaction.draftRevision.findFirst({
          where: { draftId: checkout.draftId },
          orderBy: { revision: "desc" },
          select: { bundleManifest: true },
        });
        const previousBundle = previousRevision
          ? situationBundleSchema.parse(previousRevision.bundleManifest)
          : null;
        const stored = situationBundleSchema.parse(input.bundle);
        const parsed = await synchronizeLegacyBundle(transaction, {
          draftId: checkout.draftId,
          situationId: checkout.situationId,
          bundle: stored,
          body: input.body,
          ...(authoritativeLegacyBase
            ? { authoritativeBase: authoritativeLegacyBase }
            : {}),
        });
        if (parsed.situationId !== checkout.situationId)
          throw new WorkflowError(
            "The draft does not belong to this checkout.",
          );
        const validation = validateSituationBundle(parsed, input.body);
        if (!validation.valid)
          throw new WorkflowError(
            validation.errors.join(" "),
            422,
            "INVALID_CONTENT",
          );
        const revision = await createRevision(transaction, {
          draftId: checkout.draftId,
          actorId: input.actorId,
          bundle: parsed,
          body: input.body,
          namedCheckpoint: input.namedCheckpoint ?? "Autosave",
          expectedParentRevisionId: input.expectedParentRevisionId,
          expectedParentBundleHash: input.expectedParentBundleHash,
        });
        if (stored.schemaVersion === "situation-bundle-v1")
          await transaction.draft.update({
            where: { id: checkout.draftId },
            data: {
              baseBundleHash: authoritativeLegacyBase
                ? publishableBundleHash(authoritativeLegacyBase)
                : checkout.draft.baseBundleHash,
            },
          });
        if (stored.schemaVersion === "situation-bundle-v1")
          await transaction.auditEvent.create({
            data: {
              actorId: input.actorId,
              action: "LEGACY_DRAFT_SYNCHRONIZED",
              subjectType: "DRAFT_REVISION",
              subjectId: revision.id,
              payload: {
                previousSchemaVersion: stored.schemaVersion,
                schemaVersion: parsed.schemaVersion,
                bundleHash: revision.bundleHash,
              },
            },
          });
        if (
          previousBundle?.schemaVersion === "situation-bundle-v2" &&
          previousBundle.visibility === "UNPUBLISHED" &&
          parsed.schemaVersion === "situation-bundle-v2" &&
          parsed.visibility === "PUBLIC"
        )
          await transaction.auditEvent.create({
            data: {
              actorId: input.actorId,
              action: "PUBLICATION_INTENT_SET",
              subjectType: "DRAFT_REVISION",
              subjectId: revision.id,
              payload: {
                previousRevisionVisibility: "UNPUBLISHED",
                intendedRuntimeVisibility: "PUBLIC",
                bundleHash: revision.bundleHash,
              },
            },
          });
        return revision;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2002")
    )
      throw new WorkflowError(
        "This draft changed before the save completed. Reload the authoritative revision before saving again.",
        409,
        "STALE_REVISION",
      );
    throw error;
  }
}

export async function checkInSituation(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          id: input.checkoutId,
          holderId: input.actorId,
          fence: input.fence,
          releasedAt: null,
        },
        include: { draft: true },
      });
      if (!checkout)
        throw new WorkflowError("The checkout is no longer active.");
      await assertNoActivePublication(transaction, checkout.situationId);
      await assertNoActiveReview(transaction, checkout.situationId);
      await transaction.reviewJob.updateMany({
        where: { checkoutId: checkout.id, laneOwner: true },
        data: { laneOwner: false },
      });
      const released = await transaction.situationCheckout.update({
        where: { id: checkout.id },
        data: {
          releasedAt: new Date(),
          releaseReason: "CHECKED_IN",
          resultingDraftHash: checkout.draft.currentBundleHash,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "SITUATION_CHECKED_IN",
          subjectType: "SITUATION",
          subjectId: checkout.situationId,
          payload: { checkoutId: checkout.id },
        },
      });
      return released;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function forceCheckInSituation(input: {
  adminId: string;
  situationId: string;
  reason: string;
}) {
  if (input.reason.trim().length < 3)
    throw new WorkflowError("A short reason is required.", 422);
  return database().$transaction(
    async (transaction) => {
      const checkout = await transaction.situationCheckout.findFirst({
        where: { situationId: input.situationId, releasedAt: null },
        include: { draft: true, holder: true },
      });
      if (!checkout) throw new WorkflowError("No active checkout exists.", 404);
      await assertNoActivePublication(transaction, checkout.situationId);
      const now = new Date();
      await transaction.reviewStep.updateMany({
        where: {
          job: {
            checkoutId: checkout.id,
            state: { in: ["QUEUED", "RUNNING", "FAILED"] },
          },
          state: { in: ["PENDING", "READY", "RUNNING", "FAILED"] },
        },
        data: { state: "CANCELLED", finishedAt: now },
      });
      await transaction.reviewJob.updateMany({
        where: {
          checkoutId: checkout.id,
          state: { in: ["QUEUED", "RUNNING", "FAILED"] },
        },
        data: {
          state: "CANCELLED",
          fence: { increment: 1 },
          cancelledAt: now,
          cancelledById: input.adminId,
          cancellationReason: "Administrative force check-in",
          finishedAt: now,
          laneOwner: false,
          claimToken: null,
          leaseExpiresAt: null,
          retryNotBefore: null,
        },
      });
      const released = await transaction.situationCheckout.update({
        where: { id: checkout.id },
        data: {
          releasedAt: now,
          releaseReason: "FORCED_CHECK_IN",
          forcedById: input.adminId,
          forceReason: input.reason.trim(),
          resultingDraftHash: checkout.draft.currentBundleHash,
        },
      });
      await transaction.situation.update({
        where: { id: input.situationId },
        data: { fence: { increment: 1 } },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.adminId,
          action: "SITUATION_FORCE_CHECKED_IN",
          subjectType: "SITUATION",
          subjectId: input.situationId,
          payload: {
            checkoutId: checkout.id,
            formerHolderId: checkout.holderId,
            reason: input.reason.trim(),
            resultingDraftHash: checkout.draft.currentBundleHash,
          },
        },
      });
      return released;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function startOverFromProduction(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          id: input.checkoutId,
          holderId: input.actorId,
          fence: input.fence,
          releasedAt: null,
        },
        include: { situation: true, draft: true },
      });
      if (!checkout)
        throw new WorkflowError("The checkout is no longer active.");
      await assertDraftMutationAllowed(transaction, checkout.situationId);
      await transaction.draft.update({
        where: { id: checkout.draftId },
        data: { state: "ARCHIVED", archivedAt: new Date() },
      });
      const nextDraft = await createDraftFromProduction(
        transaction,
        checkout.situation,
        input.actorId,
      );
      await transaction.situationCheckout.update({
        where: { id: checkout.id },
        data: { draftId: nextDraft.id },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "DRAFT_RESET_FROM_PRODUCTION",
          subjectType: "SITUATION",
          subjectId: checkout.situationId,
          payload: {
            archivedDraftId: checkout.draftId,
            newDraftId: nextDraft.id,
            productionReleaseId: checkout.situation.productionReleaseId,
          },
        },
      });
      return nextDraft;
    },
    { isolationLevel: "Serializable" },
  );
}

async function compatibleLeadershipRuntimeForWorkflow(): Promise<
  Awaited<ReturnType<typeof requireCompatibleLeadershipRuntime>>
> {
  try {
    return await requireCompatibleLeadershipRuntime();
  } catch (error) {
    if (error instanceof LeadershipCapabilityError)
      throw new WorkflowError(
        error.message,
        error.retryable ? 503 : 409,
        error.code,
      );
    throw error;
  }
}

export async function queueReview(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  revisionId: string;
  bundleHash: string;
}) {
  try {
    return await database().$transaction(
      async (transaction) => {
        const checkout = await transaction.situationCheckout.findFirst({
          where: {
            id: input.checkoutId,
            holderId: input.actorId,
            fence: input.fence,
            releasedAt: null,
          },
          include: {
            draft: {
              include: {
                revisions: {
                  orderBy: { revision: "desc" },
                  take: 1,
                  include: { artifacts: { include: { content: true } } },
                },
              },
            },
          },
        });
        if (!checkout)
          throw new WorkflowError("The checkout is no longer active.");
        const focusedReview = await transaction.reviewJob.findFirst({
          where: {
            checkoutId: checkout.id,
            checkoutFence: checkout.fence,
            laneOwner: true,
            state: { in: ["QUEUED", "RUNNING", "FAILED"] },
          },
          select: { id: true },
        });
        if (focusedReview)
          throw new WorkflowError(
            "This checkout already has the focused review. Finish, retry, or stop it before starting another review.",
            409,
            "REVIEW_FOCUSED_UNRESOLVED",
          );
        await assertNoActivePublication(transaction, checkout.situationId);
        const revision = checkout.draft.revisions[0];
        if (!revision) throw new WorkflowError("Save the draft before review.");
        if (
          revision.id !== input.revisionId ||
          revision.bundleHash !== input.bundleHash
        )
          throw new WorkflowError(
            "The draft changed before review was requested. Review the latest saved revision.",
            409,
            "STALE_REVISION",
          );
        const body = revision.artifacts.find(
          (artifact) => artifact.kind === "SITUATION",
        )?.content.textBody;
        if (!body)
          throw new WorkflowError("Save the situation body before review.");
        const reviewBundle = situationBundleSchema.parse(
          revision.bundleManifest,
        );
        if (reviewBundle.schemaVersion !== "situation-bundle-v2")
          throw new WorkflowError(
            "Save an action checkpoint to synchronize this legacy draft before starting review.",
            409,
            "LEGACY_DRAFT_REQUIRES_SYNC",
          );
        await assertSharedPublishableSnapshot(transaction, reviewBundle, body);
        assertManagedSituationMdx(body);
        const job = await transaction.reviewJob.create({
          data: {
            situationId: checkout.situationId,
            inputRevisionId: revision.id,
            inputBundleHash: revision.bundleHash,
            checkoutId: checkout.id,
            checkoutFence: checkout.fence,
            contextHash: sha256(
              JSON.stringify({
                bundleHash: revision.bundleHash,
                contractVersion: revision.contractVersion,
                reviewPolicyVersion: REVIEW_POLICY_VERSION,
              }),
            ),
            contractVersion: revision.contractVersion,
            policyVersion: REVIEW_POLICY_VERSION,
            steps: {
              create: reviewStages.map((stage) => ({
                ordinal: stage.ordinal,
                roleCode: stage.role,
                dependencies: stage.dependencies,
                state: stage.ordinal === 1 ? "READY" : "PENDING",
              })),
            },
          },
          include: { steps: true },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: input.actorId,
            action: "REVIEW_QUEUED",
            subjectType: "REVIEW_JOB",
            subjectId: job.id,
            payload: {
              inputRevisionId: revision.id,
              inputBundleHash: revision.bundleHash,
              stepCount: job.steps.length,
            },
          },
        });
        return job;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new WorkflowError("A review is already active for this situation.");
    throw error;
  }
}

export async function cancelReview(input: {
  actorId: string;
  jobId: string;
  revisionId: string;
  bundleHash: string;
  reason?: string;
}) {
  return database().$transaction(
    async (transaction) => {
      const job = await transaction.reviewJob.findFirst({
        where: {
          id: input.jobId,
          state: { in: ["QUEUED", "RUNNING", "FAILED"] },
        },
      });
      if (!job)
        throw new WorkflowError("The review can no longer be stopped.", 404);
      if (
        job.inputRevisionId !== input.revisionId ||
        job.inputBundleHash !== input.bundleHash
      )
        throw new WorkflowError(
          "The review input changed before this command was applied.",
          409,
          "STALE_REVIEW",
        );
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          id: job.checkoutId,
          holderId: input.actorId,
          fence: job.checkoutFence,
          releasedAt: null,
        },
        select: { id: true },
      });
      if (!checkout)
        throw new WorkflowError(
          "Only the current checkout holder can cancel this review.",
          403,
          "CHECKOUT_OWNER_REQUIRED",
        );
      const now = new Date();
      await transaction.reviewStep.updateMany({
        where: {
          jobId: job.id,
          state: { in: ["PENDING", "READY", "RUNNING", "FAILED"] },
        },
        data: { state: "CANCELLED", finishedAt: now },
      });
      const cancelled = await transaction.reviewJob.update({
        where: { id: job.id },
        data: {
          state: "CANCELLED",
          fence: { increment: 1 },
          cancelledAt: now,
          finishedAt: now,
          cancelledById: input.actorId,
          cancellationReason: input.reason?.slice(0, 500) ?? "Editor cancelled",
          laneOwner: false,
          claimToken: null,
          leaseExpiresAt: null,
          retryNotBefore: null,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "REVIEW_CANCELLED",
          subjectType: "REVIEW_JOB",
          subjectId: job.id,
          payload: {
            fence: cancelled.fence.toString(),
            previousState: job.state,
          },
        },
      });
      return cancelled;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function retryReview(input: {
  actorId: string;
  jobId: string;
  revisionId: string;
  bundleHash: string;
}) {
  try {
    return await database().$transaction(
      async (transaction) => {
        const job = await transaction.reviewJob.findFirst({
          where: { id: input.jobId, state: "FAILED" },
          include: {
            steps: { orderBy: { ordinal: "asc" } },
            inputRevision: {
              include: { artifacts: { include: { content: true } } },
            },
          },
        });
        if (!job)
          throw new WorkflowError("The failed review is unavailable.", 404);
        if (
          job.inputRevisionId !== input.revisionId ||
          job.inputBundleHash !== input.bundleHash
        )
          throw new WorkflowError(
            "The failed review does not match this exact pinned revision.",
            409,
            "STALE_REVIEW",
          );
        const body = job.inputRevision.artifacts.find(
          (artifact) => artifact.kind === "SITUATION",
        )?.content.textBody;
        if (!body)
          throw new WorkflowError(
            "The reviewed situation body is unavailable.",
          );
        assertManagedSituationMdx(body);
        const checkout = await transaction.situationCheckout.findFirst({
          where: {
            id: job.checkoutId,
            holderId: input.actorId,
            fence: job.checkoutFence,
            releasedAt: null,
          },
        });
        if (!checkout)
          throw new WorkflowError("The original checkout is no longer active.");
        await assertNoActivePublication(transaction, checkout.situationId);
        const failed = job.steps.find((step) => step.state === "FAILED");
        if (!failed)
          throw new WorkflowError("The review has no failed resumable step.");
        const laneOwner = await transaction.reviewJob.findFirst({
          where: { laneOwner: true },
          select: { id: true },
        });
        if (laneOwner && laneOwner.id !== job.id)
          throw new WorkflowError(
            "Another review owns the focused review lane. Finish or stop it before retrying this review.",
            409,
            "REVIEW_LANE_BUSY",
          );
        await transaction.reviewStep.update({
          where: { id: failed.id },
          data: { state: "READY", startedAt: null, finishedAt: null },
        });
        await transaction.reviewStep.updateMany({
          where: {
            jobId: job.id,
            ordinal: { gt: failed.ordinal },
            state: { not: "SUCCEEDED" },
          },
          data: { state: "PENDING", startedAt: null, finishedAt: null },
        });
        const queued = await transaction.reviewJob.update({
          where: { id: job.id },
          data: {
            state: "QUEUED",
            finishedAt: null,
            failureCode: null,
            claimToken: null,
            leaseExpiresAt: null,
            retryNotBefore: null,
            laneOwner: true,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: input.actorId,
            action: "REVIEW_RETRIED",
            subjectType: "REVIEW_JOB",
            subjectId: job.id,
            payload: {
              resumedOrdinal: failed.ordinal,
              inputRevisionId: job.inputRevisionId,
              inputBundleHash: job.inputBundleHash,
            },
          },
        });
        return queued;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw new WorkflowError(
        "Another review owns the focused review lane. Finish or stop it before retrying this review.",
        409,
        "REVIEW_LANE_BUSY",
      );
    throw error;
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function publicationSourceKind(input: {
  restorationParentId: string | null;
  productionBundleHash: string | null;
  visibility: "PUBLIC" | "RETIRED" | "UNPUBLISHED";
  agentAssisted: boolean;
}) {
  return input.restorationParentId
    ? ("RESTORE" as const)
    : !input.productionBundleHash
      ? ("CREATE" as const)
      : input.visibility === "RETIRED"
        ? ("RETIRE" as const)
        : input.agentAssisted
          ? ("AGENT_ASSISTED" as const)
          : ("MANUAL" as const);
}

function leadershipBaseMatchesReceipt(
  receipt: {
    baseReleaseId: string;
    baseManifestHash: string;
    expectedPointerGeneration: bigint;
  },
  base: {
    identity: { releaseId: string; manifestHash: string; generation: string };
  },
) {
  return (
    receipt.baseReleaseId === base.identity.releaseId &&
    receipt.baseManifestHash === base.identity.manifestHash &&
    receipt.expectedPointerGeneration === BigInt(base.identity.generation)
  );
}

export async function preflightPublication(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  revisionId: string;
  bundleHash: string;
}) {
  await reconcileLeadershipRelease({ force: true });
  const runtimeCapabilities = await compatibleLeadershipRuntimeForWorkflow();
  const leadershipUrl = environment().LEADERSHIP_STUDIO_READER_DATABASE_URL;
  if (!leadershipUrl)
    throw new WorkflowError(
      "Leadership preflight is unavailable.",
      503,
      "PREFLIGHT_UNAVAILABLE",
    );
  const [checkout, base] = await Promise.all([
    database().situationCheckout.findFirst({
      where: {
        id: input.checkoutId,
        holderId: input.actorId,
        fence: input.fence,
        releasedAt: null,
      },
      include: {
        situation: true,
        draft: {
          include: {
            revisions: {
              where: { id: input.revisionId, bundleHash: input.bundleHash },
              take: 1,
              include: { artifacts: { include: { content: true } } },
            },
          },
        },
      },
    }),
    readOfficialLeadershipCompilationBase(leadershipUrl),
  ]);
  if (!checkout)
    throw new WorkflowError(
      "The checkout changed. Reload before validation.",
      409,
      "STALE_CHECKOUT",
    );
  if (
    checkout.draft.currentBundleHash !== input.bundleHash ||
    checkout.draft.currentRevisionNumber !==
      checkout.draft.revisions[0]?.revision ||
    checkout.draft.revisions[0]?.id !== input.revisionId
  )
    throw new WorkflowError(
      "The draft changed before publication validation. Save and validate the current revision.",
      409,
      "STALE_REVISION",
    );
  const revision = checkout.draft.revisions[0];
  const body = revision.artifacts.find(
    (artifact) => artifact.kind === "SITUATION",
  )?.content.textBody;
  if (!body) throw new WorkflowError("The exact revision body is unavailable.");
  const parsedBundle = publishableSituationBundleSchema.safeParse(
    revision.bundleManifest,
  );
  if (!parsedBundle.success)
    throw new WorkflowError(
      "This draft must be synchronized to the complete v2 publishable snapshot before preflight.",
      422,
      "PUBLISHABLE_SNAPSHOT_REQUIRED",
    );
  if (parsedBundle.data.visibility === "UNPUBLISHED")
    throw new WorkflowError(
      "Choose Public as the saved publication intent before running production validation.",
      422,
      "PUBLICATION_INTENT_REQUIRED",
    );
  const validation = validateSituationBundle(parsedBundle.data, body);
  if (!validation.valid || validation.bundleHash !== revision.bundleHash)
    throw new WorkflowError(
      validation.errors.join(" ") || "Exact revision validation failed.",
      422,
      "VALIDATION_FAILED",
    );
  const observedTarget = base.situations.find(
    (situation) => situation.slug === checkout.situation.slug,
  );
  const observedBundleHash = observedTarget
    ? bundleHash(
        publishableSituationBundleSchema.parse({
          ...observedTarget.bundle,
          situationId: checkout.situationId,
        }),
      )
    : null;
  const conflict = publicationConflictDecision({
    draftBaseBundleHash: checkout.draft.baseBundleHash,
    observedTargetBundleHash: observedBundleHash,
    baseReleaseId: checkout.draft.baseReleaseId,
    observedReleaseId: base.identity.releaseId,
  });
  if (conflict.kind === "NEEDS_REFRESH")
    throw new WorkflowError(
      "The target situation changed in Leadership. Refresh the draft and run preflight again.",
      409,
      "PREFLIGHT_BASE_CHANGED",
    );
  const scoped = await database().scopedArtifactVariant.findMany({
    where: {
      ownerSituationId: checkout.situationId,
      logicalId: {
        in: parsedBundle.data.artifacts.map((artifact) => artifact.logicalId),
      },
    },
    include: { content: true },
  });
  const scopedEvidence = verifyExactScopedArtifactDescriptors({
    situationId: checkout.situationId,
    situationSlug: parsedBundle.data.metadata.slug,
    descriptors: parsedBundle.data.artifacts,
    persisted: scoped,
  });
  if (!scopedEvidence.ok)
    throw new WorkflowError(
      scopedEvidence.errors.join(" "),
      422,
      "INVALID_SCOPED_ARTIFACT",
      { diagnostics: scopedEvidence.errors },
    );
  const scopedBodies = scopedEvidence.bodies;
  const agentAssisted =
    (await database().proposalChange.count({
      where: { appliedRevisionId: revision.id, state: "ACCEPTED" },
    })) > 0;
  const sourceKind = publicationSourceKind({
    restorationParentId: checkout.draft.restorationParentId,
    productionBundleHash: checkout.situation.productionBundleHash,
    visibility: parsedBundle.data.visibility,
    agentAssisted,
  });
  const publicationBundle = publishableSituationBundleSchema.parse({
    ...parsedBundle.data,
    visibility: parsedBundle.data.visibility,
    promotion: parsedBundle.data.promotion,
  });
  const publicationId = crypto.randomUUID();
  const releaseId = crypto.randomUUID();
  let snapshot: PublishableSituationSnapshot;
  try {
    snapshot = toPublishableSituationSnapshot({
      bundle: publicationBundle,
      body,
      scopedArtifactBodies: scopedBodies,
    });
  } catch (error) {
    throw new WorkflowError(
      error instanceof Error ? error.message : String(error),
      422,
      "PREFLIGHT_VALIDATION_FAILED",
      {
        diagnostics: [
          {
            code: "PUBLISHABLE_SNAPSHOT_INVALID",
            path: ["snapshot"],
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      },
    );
  }
  const compiled = await compilePublishableSituationSnapshot({
    snapshot,
    base: {
      releaseId: base.identity.releaseId,
      manifestBody: base.manifestBody,
      bodies: base.bodies,
    },
    publication: {
      releaseId,
      publicationId,
      parentReleaseId: base.identity.releaseId,
      expectedBaseGeneration: base.identity.generation,
      sourceKind,
    },
  });
  if (!compiled.ok)
    throw new WorkflowError(
      compiled.diagnostics
        .map((item) => `${item.path.join(".") || "snapshot"}: ${item.message}`)
        .join(" "),
      422,
      "PREFLIGHT_VALIDATION_FAILED",
      { diagnostics: compiled.diagnostics },
    );
  if (
    compiled.compiler.digest !== PUBLICATION_COMPILER_DIGEST ||
    runtimeCapabilities.contracts.publicationCompiler.digest !==
      PUBLICATION_COMPILER_DIGEST
  )
    throw new WorkflowError(
      "Leadership and Studio publication compiler identities differ.",
      409,
      "PREFLIGHT_COMPILER_MISMATCH",
    );
  const confirmedBase =
    await readOfficialLeadershipCompilationBase(leadershipUrl);
  if (
    confirmedBase.identity.releaseId !== base.identity.releaseId ||
    confirmedBase.identity.manifestHash !== base.identity.manifestHash ||
    confirmedBase.identity.generation !== base.identity.generation
  )
    throw new WorkflowError(
      "Leadership changed while validation was running. Run preflight again against the new base.",
      409,
      "PREFLIGHT_BASE_CHANGED",
    );
  const totalByteLength = compiled.candidate.artifacts.reduce(
    (total, artifact) => total + BigInt(artifact.bytes.byteLength),
    0n,
  );
  const receipt = await database().$transaction(
    async (transaction) => {
      const current = await transaction.situationCheckout.findFirst({
        where: {
          id: checkout.id,
          holderId: input.actorId,
          fence: input.fence,
          releasedAt: null,
          draft: {
            currentRevisionNumber: revision.revision,
            currentBundleHash: input.bundleHash,
            revisions: {
              some: { id: input.revisionId, bundleHash: input.bundleHash },
            },
          },
        },
      });
      if (!current)
        throw new WorkflowError(
          "The draft changed while preflight was running. Validate again.",
          409,
          "STALE_REVISION",
        );
      await assertNoActivePublication(transaction, checkout.situationId);
      const created = await transaction.publicationPreflightReceipt.create({
        data: {
          publicationId,
          releaseId,
          situationId: checkout.situationId,
          revisionId: revision.id,
          checkoutId: checkout.id,
          checkoutFence: checkout.fence,
          revisionBundleHash: revision.bundleHash,
          candidateHash: compiled.candidate.completeCandidateHash,
          baseReleaseId: base.identity.releaseId,
          baseManifestHash: base.identity.manifestHash,
          expectedPointerGeneration: BigInt(base.identity.generation),
          contractIdentity: jsonInput(PUBLICATION_COMPILER_IDENTITY),
          contractDigest: PUBLICATION_COMPILER_DIGEST,
          validationResult: "PASSED",
          diagnostics: [],
          routeExpectations: jsonInput(compiled.affectedRoutes),
          sourceKind,
          manifestHash: compiled.candidate.manifestHash,
          manifestBody: compiled.candidate.manifestBody,
          artifactCount: compiled.candidate.artifacts.length,
          edgeCount: compiled.candidate.manifest.edges.length,
          totalByteLength,
          compiledProjection: jsonInput(compiled.typedProjection),
          artifacts: {
            create: compiled.candidate.artifacts.map((artifact, position) => ({
              logicalId: artifact.logicalId,
              position,
              artifactType: artifact.type,
              path: artifact.path,
              contentHash: artifact.contentHash,
              byteLength: artifact.bytes.byteLength,
              encoding: artifact.encoding,
              mediaType: artifact.mediaType,
              bytes: Uint8Array.from(artifact.bytes),
            })),
          },
        },
      });
      const sealed = await transaction.publicationPreflightReceipt.update({
        where: { id: created.id },
        data: { sealedAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "PUBLICATION_PREFLIGHT_PASSED",
          subjectType: "PUBLICATION_PREFLIGHT_RECEIPT",
          subjectId: created.id,
          payload: {
            revisionId: revision.id,
            bundleHash: revision.bundleHash,
            candidateHash: compiled.candidate.completeCandidateHash,
            baseReleaseId: base.identity.releaseId,
            baseManifestHash: base.identity.manifestHash,
            expectedPointerGeneration: base.identity.generation,
            contractDigest: PUBLICATION_COMPILER_DIGEST,
            leadershipCapabilityDigest: runtimeCapabilities.capabilityDigest,
          },
        },
      });
      return sealed;
    },
    { isolationLevel: "Serializable" },
  );
  return {
    ...receipt,
    affectedRoutes: compiled.affectedRoutes,
    situationArtifactHash: compiled.candidate.situationArtifactHash,
    candidatePreview: compiled.typedProjection,
  };
}

export async function requestPublication(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  revisionId: string;
  bundleHash: string;
  preflightReceiptId: string;
  candidateHash: string;
}) {
  await assertNoPublicationRecovery(database());
  const existingReceipt =
    await database().publicationPreflightReceipt.findUnique({
      where: { id: input.preflightReceiptId },
      include: {
        job: true,
        checkout: { select: { holderId: true } },
        revision: { select: { revision: true } },
      },
    });
  if (!existingReceipt)
    throw new WorkflowError(
      "The publication preflight receipt was not found.",
      404,
      "PREFLIGHT_REQUIRED",
    );
  if (
    existingReceipt.checkoutId !== input.checkoutId ||
    existingReceipt.checkoutFence !== input.fence ||
    existingReceipt.checkout.holderId !== input.actorId ||
    existingReceipt.revisionId !== input.revisionId ||
    existingReceipt.revisionBundleHash !== input.bundleHash ||
    existingReceipt.candidateHash !== input.candidateHash ||
    existingReceipt.sealedAt === null
  )
    throw new WorkflowError(
      "The preflight receipt does not match the current editor revision and candidate.",
      409,
      "STALE_PREFLIGHT_RECEIPT",
    );
  // A byte-for-byte replay of an accepted command is idempotent even after
  // the publisher has advanced the Leadership pointer or runtime availability
  // has changed. Mismatched replays are rejected above.
  if (existingReceipt.job) return existingReceipt.job;
  const runtimeCapabilities = await compatibleLeadershipRuntimeForWorkflow();
  const leadershipUrl = environment().LEADERSHIP_STUDIO_READER_DATABASE_URL;
  if (!leadershipUrl)
    throw new WorkflowError(
      "Leadership publication is unavailable.",
      503,
      "PREFLIGHT_UNAVAILABLE",
    );
  const base = await readOfficialLeadershipCompilationBase(leadershipUrl);
  if (!leadershipBaseMatchesReceipt(existingReceipt, base))
    throw new WorkflowError(
      "Leadership changed after validation. Run a new preflight; the previous candidate remains immutable.",
      409,
      "PREFLIGHT_BASE_CHANGED",
    );
  try {
    return await database().$transaction(
      async (transaction) => {
        const receipt =
          await transaction.publicationPreflightReceipt.findUnique({
            where: { id: input.preflightReceiptId },
            include: { job: true },
          });
        if (!receipt || receipt.sealedAt === null)
          throw new WorkflowError("The preflight receipt is unavailable.", 404);
        if (receipt.job) return receipt.job;
        const checkout = await transaction.situationCheckout.findFirst({
          where: {
            id: input.checkoutId,
            holderId: input.actorId,
            fence: input.fence,
            releasedAt: null,
            draft: {
              currentRevisionNumber: existingReceipt.revision.revision,
              currentBundleHash: input.bundleHash,
              revisions: {
                some: { id: input.revisionId, bundleHash: input.bundleHash },
              },
            },
          },
          include: { situation: true, draft: true },
        });
        if (!checkout || receipt.checkoutId !== checkout.id)
          throw new WorkflowError(
            "The checkout or exact revision changed after validation.",
            409,
            "STALE_PREFLIGHT_RECEIPT",
          );
        await assertNoActivePublication(transaction, checkout.situationId);
        await assertNoActiveReview(transaction, checkout.situationId);
        const backupStatus =
          await publicationBackupStatusForTransaction(transaction);
        if (!backupStatus.ready)
          throw new WorkflowError(
            backupStatus.message,
            503,
            PUBLICATION_BACKUP_NOT_READY_CODE,
          );
        const confirmedBase =
          await readOfficialLeadershipCompilationBase(leadershipUrl);
        if (!leadershipBaseMatchesReceipt(receipt, confirmedBase))
          throw new WorkflowError(
            "Leadership changed before publication was queued. Run a new preflight.",
            409,
            "PREFLIGHT_BASE_CHANGED",
          );
        const job = await transaction.publicationJob.create({
          data: {
            publicationId: receipt.publicationId,
            situationId: checkout.situationId,
            targetRevisionId: input.revisionId,
            checkoutId: checkout.id,
            checkoutFence: checkout.fence,
            sourceKind: receipt.sourceKind,
            targetBundleHash: input.bundleHash,
            preflightReceiptId: receipt.id,
            candidateHash: receipt.candidateHash,
            baseBundleHash: checkout.draft.baseBundleHash,
            expectedPointerGeneration: receipt.expectedPointerGeneration,
            observedReleaseId: receipt.baseReleaseId,
            previousReleaseId: receipt.baseReleaseId,
            restorationParentId: checkout.draft.restorationParentId,
            events: {
              create: {
                sequence: 1,
                kind: "REQUESTED",
                payload: {
                  sourceKind: receipt.sourceKind,
                  targetRevisionId: input.revisionId,
                  targetBundleHash: input.bundleHash,
                  preflightReceiptId: receipt.id,
                  candidateHash: receipt.candidateHash,
                  baseReleaseId: receipt.baseReleaseId,
                  baseManifestHash: receipt.baseManifestHash,
                  expectedPointerGeneration:
                    receipt.expectedPointerGeneration.toString(),
                  contractDigest: receipt.contractDigest,
                  leadershipCapabilityDigest:
                    runtimeCapabilities.capabilityDigest,
                },
              },
            },
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: input.actorId,
            action: "PUBLICATION_REQUESTED",
            subjectType: "PUBLICATION_JOB",
            subjectId: job.id,
            payload: {
              situationId: checkout.situationId,
              revisionId: input.revisionId,
              bundleHash: input.bundleHash,
              preflightReceiptId: receipt.id,
              candidateHash: receipt.candidateHash,
              leadershipCapabilityDigest: runtimeCapabilities.capabilityDigest,
            },
          },
        });
        return job;
      },
      {
        isolationLevel: "Serializable",
        maxWait: 5_000,
        timeout: 30_000,
      },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      const accepted = await database().publicationJob.findUnique({
        where: { preflightReceiptId: input.preflightReceiptId },
      });
      if (accepted) return accepted;
    }
    throw error;
  }
}

export async function startRestorationDraft(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  productionVersionId: string;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          id: input.checkoutId,
          holderId: input.actorId,
          fence: input.fence,
          releasedAt: null,
        },
        include: { situation: true, draft: true },
      });
      if (!checkout)
        throw new WorkflowError("The checkout is no longer active.");
      await assertDraftMutationAllowed(transaction, checkout.situationId);
      const selected = await transaction.productionSituationVersion.findFirst({
        where: {
          id: input.productionVersionId,
          situationId: checkout.situationId,
        },
        include: {
          artifacts: {
            include: { content: true },
            orderBy: { position: "asc" },
          },
        },
      });
      if (!selected)
        throw new WorkflowError("That production version is unavailable.", 404);
      const activeReview = await transaction.reviewJob.findFirst({
        where: {
          situationId: checkout.situationId,
          state: { in: ["QUEUED", "RUNNING"] },
        },
      });
      if (activeReview)
        throw new WorkflowError("Cancel the active review before restoring.");
      await transaction.draft.update({
        where: { id: checkout.draftId },
        data: { state: "ARCHIVED", archivedAt: new Date() },
      });
      const current = await transaction.productionSituationVersion.findFirst({
        where: { situationId: checkout.situationId },
        orderBy: { productionAt: "desc" },
        include: {
          observation: true,
          artifacts: {
            include: { content: true },
            orderBy: { position: "asc" },
          },
        },
      });
      const lineage =
        (
          await transaction.draft.aggregate({
            where: { situationId: checkout.situationId },
            _max: { lineage: true },
          })
        )._max.lineage ?? 0;
      const draft = await transaction.draft.create({
        data: {
          situationId: checkout.situationId,
          lineage: lineage + 1,
          baseProductionVersionId: current?.id ?? null,
          baseReleaseId: current?.observation.releaseId ?? null,
          baseManifestHash: current?.observation.manifestHash ?? null,
          basePointerGeneration: current?.observation.pointerGeneration ?? null,
          baseBundleHash: current?.bundleHash ?? null,
          restorationParentId: selected.id,
        },
      });
      const body =
        selected.artifacts.find((artifact) => artifact.kind === "SITUATION")
          ?.content.textBody ?? "";
      const selectedBundle = situationBundleSchema.parse(
        selected.bundleManifest,
      );
      const currentBundle = current
        ? situationBundleSchema.parse(current.bundleManifest)
        : null;
      const restorationArtifacts = [...selectedBundle.artifacts];
      const restorationRelationships = [];
      for (const relationship of selectedBundle.relationships) {
        const newestRelationship = currentBundle?.relationships.find(
          (candidate) => candidate.logicalId === relationship.logicalId,
        );
        if (
          relationship.visibility === "GLOBAL" &&
          newestRelationship?.contentHash !== relationship.contentHash
        ) {
          const historical = selected.artifacts.find(
            (artifact) =>
              artifact.logicalId === relationship.logicalId &&
              artifact.contentHash === relationship.contentHash,
          );
          if (!historical?.content.textBody)
            throw new WorkflowError(
              `Historical context ${relationship.logicalId} is not restorable.`,
              409,
              "HISTORICAL_CONTEXT_UNAVAILABLE",
            );
          const variant = createScopedVariant({
            situationId: checkout.situationId,
            ownerSituationSlug: selectedBundle.metadata.slug,
            kind: relationship.kind as
              | "GUIDE"
              | "PRACTICE"
              | "SOURCE"
              | "LESSON_PLAN"
              | "PREPARATION_PROMPT",
            originalLogicalId: relationship.logicalId,
            originalContentHash: relationship.contentHash,
            changedBody: historical.content.textBody,
          });
          await transaction.scopedArtifactVariant.createMany({
            data: {
              ownerSituationId: checkout.situationId,
              logicalId: variant.artifact.logicalId,
              kind: variant.artifact.kind,
              visibility: variant.artifact.visibility,
              forkedFromLogicalId: relationship.logicalId,
              forkedFromContentHash: relationship.contentHash,
              contentHash: variant.artifact.contentHash,
            },
            skipDuplicates: true,
          });
          if (
            !restorationArtifacts.some(
              (artifact) => artifact.logicalId === variant.artifact.logicalId,
            )
          )
            restorationArtifacts.push(variant.artifact);
          restorationRelationships.push({
            ...relationship,
            logicalId: variant.artifact.logicalId,
            contentHash: variant.artifact.contentHash,
            visibility: variant.artifact.visibility,
          });
        } else restorationRelationships.push(relationship);
      }
      const restorationBundle = situationBundleSchema.parse({
        ...selectedBundle,
        artifacts: restorationArtifacts,
        relationships: restorationRelationships,
        contextHashes: restorationRelationships.map(
          (relationship) => relationship.contentHash,
        ),
      });
      await createRevision(transaction, {
        draftId: draft.id,
        actorId: input.actorId,
        bundle: restorationBundle,
        body,
        namedCheckpoint: "Restoration draft",
      });
      await transaction.situationCheckout.update({
        where: { id: checkout.id },
        data: { draftId: draft.id },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "RESTORATION_DRAFT_STARTED",
          subjectType: "SITUATION",
          subjectId: checkout.situationId,
          payload: {
            selectedProductionVersionId: selected.id,
            selectedBundleHash: selected.bundleHash,
            newestProductionVersionId: current?.id ?? null,
          },
        },
      });
      return draft;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function createRetirementDraft(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          id: input.checkoutId,
          holderId: input.actorId,
          fence: input.fence,
          releasedAt: null,
        },
        include: {
          draft: {
            include: {
              revisions: {
                orderBy: { revision: "desc" },
                take: 1,
                include: { artifacts: { include: { content: true } } },
              },
            },
          },
        },
      });
      if (!checkout)
        throw new WorkflowError("The checkout is no longer active.");
      await assertDraftMutationAllowed(transaction, checkout.situationId);
      const revision = checkout.draft.revisions[0];
      const body = revision?.artifacts.find(
        (artifact) => artifact.kind === "SITUATION",
      )?.content.textBody;
      if (!revision || !body)
        throw new WorkflowError("The current draft is unavailable.");
      const currentBundle = situationBundleSchema.parse(
        revision.bundleManifest,
      );
      const nextBundle = situationBundleSchema.parse({
        ...currentBundle,
        visibility: "RETIRED",
        ...(currentBundle.schemaVersion === "situation-bundle-v2"
          ? { promotion: null }
          : {}),
      });
      const created = await createRevision(transaction, {
        draftId: checkout.draftId,
        actorId: input.actorId,
        bundle: nextBundle,
        body,
        namedCheckpoint: "Retirement draft",
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "RETIREMENT_DRAFT_CREATED",
          subjectType: "SITUATION",
          subjectId: checkout.situationId,
          payload: { revisionId: created.id, bundleHash: created.bundleHash },
        },
      });
      return created;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function createScopedArtifactEdit(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  originalLogicalId: string;
  kind: "GUIDE" | "PRACTICE" | "SOURCE" | "LESSON_PLAN" | "PREPARATION_PROMPT";
  originalContentHash: string;
  changedBody: string;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          id: input.checkoutId,
          holderId: input.actorId,
          fence: input.fence,
          releasedAt: null,
        },
        include: {
          draft: {
            include: {
              revisions: {
                orderBy: { revision: "desc" },
                take: 1,
                include: { artifacts: { include: { content: true } } },
              },
            },
          },
        },
      });
      if (!checkout)
        throw new WorkflowError("The checkout is no longer active.");
      await assertDraftMutationAllowed(transaction, checkout.situationId);
      const revision = checkout.draft.revisions[0];
      const body = revision?.artifacts.find(
        (artifact) => artifact.kind === "SITUATION",
      )?.content.textBody;
      if (!revision || !body)
        throw new WorkflowError("The current draft is unavailable.");
      const currentBundle = situationBundleSchema.parse(
        revision.bundleManifest,
      );
      const relationship = currentBundle.relationships.find(
        (item) => item.logicalId === input.originalLogicalId,
      );
      if (
        !relationship ||
        relationship.contentHash !== input.originalContentHash
      )
        throw new WorkflowError(
          "The shared artifact changed. Reload before forking.",
        );
      if (relationship.kind !== input.kind)
        throw new WorkflowError(
          "The scoped artifact kind does not match the current relationship.",
          422,
          "INVALID_SCOPED_ARTIFACT",
        );
      const scopedValidation = validateScopedArtifactBody(
        input.kind,
        input.changedBody,
      );
      if (!scopedValidation.valid)
        throw new WorkflowError(
          `The scoped ${input.kind.toLowerCase()} is invalid: ${scopedValidation.errors.join(" ")}`,
          422,
          "INVALID_SCOPED_ARTIFACT",
        );
      const currentVariant = await transaction.scopedArtifactVariant.findUnique(
        {
          where: { logicalId: relationship.logicalId },
        },
      );
      if (
        currentVariant &&
        currentVariant.ownerSituationId !== checkout.situationId
      )
        throw new WorkflowError(
          "The current scoped artifact belongs to another situation.",
          409,
          "SCOPED_VARIANT_CONFLICT",
        );
      const forkedFromLogicalId =
        currentVariant?.forkedFromLogicalId ?? relationship.logicalId;
      const forkedFromContentHash =
        currentVariant?.forkedFromContentHash ?? relationship.contentHash;
      const variant = createScopedVariant({
        situationId: checkout.situationId,
        ownerSituationSlug: currentBundle.metadata.slug,
        kind: input.kind,
        originalLogicalId: forkedFromLogicalId,
        originalContentHash: forkedFromContentHash,
        changedBody: input.changedBody,
      });
      await putTextBlob(transaction, variant.body, variant.artifact.mediaType);
      const retainedVariant =
        await transaction.scopedArtifactVariant.findUnique({
          where: { logicalId: variant.artifact.logicalId },
        });
      if (!retainedVariant)
        await transaction.scopedArtifactVariant.create({
          data: {
            ownerSituationId: checkout.situationId,
            logicalId: variant.artifact.logicalId,
            kind: input.kind,
            visibility: variant.artifact.visibility,
            forkedFromLogicalId,
            forkedFromContentHash,
            contentHash: variant.artifact.contentHash,
          },
        });
      else if (
        retainedVariant.ownerSituationId !== checkout.situationId ||
        retainedVariant.kind !== input.kind ||
        retainedVariant.forkedFromLogicalId !== forkedFromLogicalId ||
        retainedVariant.forkedFromContentHash !== forkedFromContentHash ||
        retainedVariant.contentHash !== variant.artifact.contentHash
      )
        throw new WorkflowError(
          "The scoped edit conflicts with a retained variant.",
          409,
          "SCOPED_VARIANT_CONFLICT",
        );
      const nextBundle = situationBundleSchema.parse({
        ...currentBundle,
        artifacts: [
          ...currentBundle.artifacts.filter(
            (artifact) =>
              artifact.logicalId !== variant.artifact.logicalId &&
              (!currentVariant ||
                artifact.logicalId !== currentVariant.logicalId),
          ),
          variant.artifact,
        ],
        relationships: currentBundle.relationships.map((item) =>
          item.logicalId === relationship.logicalId
            ? {
                ...item,
                logicalId: variant.artifact.logicalId,
                contentHash: variant.artifact.contentHash,
                visibility: variant.artifact.visibility,
              }
            : item,
        ),
        contextHashes: currentBundle.relationships.map((item) =>
          item.logicalId === relationship.logicalId
            ? variant.artifact.contentHash
            : item.contentHash,
        ),
      });
      const created = await createRevision(transaction, {
        draftId: checkout.draftId,
        actorId: input.actorId,
        bundle: nextBundle,
        body,
        namedCheckpoint: `Scoped ${input.kind.toLowerCase()} variant`,
      });
      return { revision: created, variant: variant.artifact };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function decideProposalChange(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  changeId: string;
  decision: "ACCEPT" | "REJECT";
  revisionId: string;
  bundleHash: string;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await proposalCheckout(transaction, input);
      const change = await transaction.proposalChange.findFirst({
        where: {
          id: input.changeId,
          proposal: { job: { situationId: checkout.situationId } },
        },
        include: { proposal: true },
      });
      if (!change) throw new WorkflowError("Proposal change not found.", 404);
      assertCurrentProposalRevision(change.proposal, input);
      if (change.state !== "PENDING")
        throw new WorkflowError("That proposal change is already decided.");
      if (input.decision === "REJECT") {
        await transaction.proposalChange.update({
          where: { id: change.id },
          data: {
            state: "REJECTED",
            decidedAt: new Date(),
            decidedById: input.actorId,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: input.actorId,
            action: "PROPOSAL_CHANGE_REJECTED",
            subjectType: "PROPOSAL_CHANGE",
            subjectId: change.id,
            payload: {
              proposalId: change.proposalId,
              targetKind: change.targetKind,
              targetKey: change.targetKey,
            },
          },
        });
        return {
          state: "REJECTED" as const,
          authoritativeRevision: authoritativeRevisionPayload(
            checkout.draft.revisions[0]!,
          ),
        };
      }
      if (!isProposalChangeApplicable(change))
        throw new WorkflowError(
          "This is an explicit manual suggestion and cannot be auto-applied.",
          422,
          "MANUAL_SUGGESTION",
        );
      const created = await applyProposalChanges(transaction, {
        actorId: input.actorId,
        checkout,
        changes: [change],
        namedCheckpoint: `Accepted agent suggestion: ${change.targetKey}`,
        proposalId: change.proposalId,
      });
      const now = new Date();
      await transaction.proposalChange.update({
        where: { id: change.id },
        data: {
          state: "ACCEPTED",
          decidedAt: now,
          decidedById: input.actorId,
          appliedRevisionId: created.id,
        },
      });
      await transaction.reviewProposal.update({
        where: { id: change.proposalId },
        data: {
          currentRevisionId: created.id,
          currentBundleHash: created.bundleHash,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "PROPOSAL_CHANGE_ACCEPTED",
          subjectType: "PROPOSAL_CHANGE",
          subjectId: change.id,
          payload: {
            proposalId: change.proposalId,
            inputRevisionId: change.proposal.inputRevisionId,
            appliedRevisionId: created.id,
            modified: Boolean(change.editorBody),
            targetKind: change.targetKind,
            targetKey: change.targetKey,
          },
        },
      });
      return {
        state: "ACCEPTED" as const,
        authoritativeRevision: authoritativeRevisionPayload(created),
      };
    },
    { isolationLevel: "Serializable" },
  );
}

type ProposalCheckout = Awaited<ReturnType<typeof proposalCheckout>>;

async function proposalCheckout(
  transaction: Transaction,
  input: {
    actorId: string;
    checkoutId: string;
    fence: bigint;
    revisionId: string;
    bundleHash: string;
  },
) {
  const checkout = await transaction.situationCheckout.findFirst({
    where: {
      id: input.checkoutId,
      holderId: input.actorId,
      fence: input.fence,
      releasedAt: null,
    },
    include: {
      draft: {
        include: {
          revisions: {
            orderBy: { revision: "desc" },
            take: 1,
            include: { artifacts: { include: { content: true } } },
          },
        },
      },
    },
  });
  if (!checkout)
    throw new WorkflowError(
      "The checkout changed. Reload before reviewing suggestions.",
      409,
      "STALE_CHECKOUT",
    );
  await assertDraftMutationAllowed(transaction, checkout.situationId);
  const revision = checkout.draft.revisions[0];
  if (
    !revision ||
    revision.id !== input.revisionId ||
    revision.bundleHash !== input.bundleHash
  )
    throw new WorkflowError(
      "The draft changed after this command was prepared. Reload the authoritative revision.",
      409,
      "STALE_REVISION",
    );
  return checkout;
}

function assertCurrentProposalRevision(
  proposal: {
    currentRevisionId: string;
    currentBundleHash: string;
    supersededAt: Date | null;
  },
  expected: { revisionId: string; bundleHash: string },
) {
  if (proposal.supersededAt)
    throw new WorkflowError(
      "This proposal was superseded by a newer draft revision. Run review again.",
      409,
      "SUPERSEDED_PROPOSAL",
    );
  if (
    proposal.currentRevisionId !== expected.revisionId ||
    proposal.currentBundleHash !== expected.bundleHash
  )
    throw new WorkflowError(
      "This proposal targets a different revision. Reload before deciding it.",
      409,
      "STALE_PROPOSAL",
    );
}

type ApplicableProposalChange = {
  id: string;
  targetKind:
    | "SECTION"
    | "METADATA"
    | "SCOPED_VARIANT"
    | "RELATIONSHIP"
    | "EMBED"
    | "BUNDLE";
  targetKey: string;
  applicationMode: "AUTOMATIC" | "MANUAL";
  beforeHash: string | null;
  afterBody: string;
  editorBody: string | null;
};

function isProposalChangeApplicable(
  change: Pick<
    ApplicableProposalChange,
    "applicationMode" | "targetKind" | "beforeHash"
  >,
) {
  return (
    change.applicationMode === "AUTOMATIC" &&
    (change.targetKind === "SECTION" ||
      change.targetKind === "METADATA" ||
      change.targetKind === "SCOPED_VARIANT")
  );
}

export function proposalPreservesManagedMdxComponents(
  before: string,
  after: string,
) {
  return sharedProposalPreservesManagedMdxComponents(before, after);
}

function proposedBody(change: ApplicableProposalChange) {
  const replacement = change.editorBody ?? change.afterBody;
  return change.targetKind === "SECTION"
    ? normalizeSituationSectionReplacement(change.targetKey, replacement)
    : replacement;
}

async function applyProposalChanges(
  transaction: Transaction,
  input: {
    actorId: string;
    checkout: ProposalCheckout;
    changes: ApplicableProposalChange[];
    namedCheckpoint: string;
    proposalId: string;
  },
) {
  const revision = input.checkout.draft.revisions[0];
  const initialBody = revision?.artifacts.find(
    (artifact) => artifact.kind === "SITUATION",
  )?.content.textBody;
  if (!revision || !initialBody)
    throw new WorkflowError("The current draft is unavailable.");
  let body = initialBody;
  let bundle = situationBundleSchema.parse(revision.bundleManifest);
  for (const change of input.changes) {
    if (!isProposalChangeApplicable(change))
      throw new WorkflowError(
        `Manual suggestion ${change.targetKey} cannot be included in automatic acceptance.`,
        422,
        "MANUAL_SUGGESTION",
      );
    const afterBody = proposedBody(change);
    let applied: ReturnType<typeof applyDeterministicSituationChange>;
    try {
      if (
        change.targetKind !== "SECTION" &&
        change.targetKind !== "METADATA" &&
        change.targetKind !== "SCOPED_VARIANT"
      )
        throw new DeterministicChangeApplicationError(
          `Suggestion type ${change.targetKind} is not safely auto-applicable.`,
          "UNSUPPORTED_SUGGESTION",
        );
      applied = applyDeterministicSituationChange({
        bundle,
        body,
        change: {
          targetKind: change.targetKind,
          targetKey: change.targetKey,
          beforeHash: change.beforeHash,
          afterBody,
        },
      });
    } catch (error) {
      if (error instanceof DeterministicChangeApplicationError)
        throw new WorkflowError(
          error.message,
          error.code === "STALE_SUGGESTION" ? 409 : 422,
          error.code,
        );
      throw new WorkflowError(
        error instanceof Error ? error.message : String(error),
        422,
        "INVALID_SUGGESTION",
      );
    }
    if (applied.scopedVariant) {
      const variant = applied.scopedVariant;
      await putTextBlob(transaction, variant.body, variant.artifact.mediaType);
      const existingVariant =
        await transaction.scopedArtifactVariant.findUnique({
          where: { logicalId: variant.artifact.logicalId },
        });
      if (!existingVariant)
        await transaction.scopedArtifactVariant.create({
          data: {
            ownerSituationId: input.checkout.situationId,
            logicalId: variant.artifact.logicalId,
            kind: variant.artifact.kind,
            visibility: variant.artifact.visibility,
            forkedFromLogicalId: variant.artifact.forkedFromLogicalId!,
            forkedFromContentHash: variant.artifact.forkedFromContentHash!,
            contentHash: variant.artifact.contentHash,
          },
        });
      else if (
        existingVariant.ownerSituationId !== input.checkout.situationId ||
        existingVariant.kind !== variant.artifact.kind ||
        existingVariant.visibility !== variant.artifact.visibility ||
        existingVariant.forkedFromLogicalId !==
          variant.artifact.forkedFromLogicalId ||
        existingVariant.forkedFromContentHash !==
          variant.artifact.forkedFromContentHash ||
        existingVariant.contentHash !== variant.artifact.contentHash
      )
        throw new WorkflowError(
          "The scoped suggestion conflicts with a retained variant.",
          409,
          "SCOPED_VARIANT_CONFLICT",
        );
    }
    bundle = applied.bundle;
    body = applied.body;
  }
  bundle = situationBundleSchema.parse({
    ...bundle,
    bodyHash: sha256(canonicalText(body)),
  });
  const validation = validateSituationBundle(bundle, body);
  if (!validation.valid)
    throw new WorkflowError(
      validation.errors.join(" "),
      422,
      "INVALID_SUGGESTION",
    );
  return createRevision(transaction, {
    draftId: input.checkout.draftId,
    actorId: input.actorId,
    bundle,
    body,
    namedCheckpoint: input.namedCheckpoint,
    expectedParentRevisionId: revision.id,
    expectedParentBundleHash: revision.bundleHash,
    preserveProposalId: input.proposalId,
  });
}

export async function editProposalChange(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  changeId: string;
  editedBody: string;
  revisionId: string;
  bundleHash: string;
}) {
  if (
    !input.editedBody.length ||
    Buffer.byteLength(input.editedBody, "utf8") > 512_000
  )
    throw new WorkflowError(
      "The edited suggestion must contain no more than 512 KB.",
      422,
      "INVALID_SUGGESTION",
    );
  return database().$transaction(
    async (transaction) => {
      const checkout = await proposalCheckout(transaction, input);
      const change = await transaction.proposalChange.findFirst({
        where: {
          id: input.changeId,
          proposal: { job: { situationId: checkout.situationId } },
        },
        include: { proposal: true },
      });
      if (!change) throw new WorkflowError("Proposal change not found.", 404);
      assertCurrentProposalRevision(change.proposal, input);
      if (change.state !== "PENDING")
        throw new WorkflowError("That proposal change is already decided.");
      if (!isProposalChangeApplicable(change))
        throw new WorkflowError(
          "Manual suggestions must be resolved in the editor.",
          422,
          "MANUAL_SUGGESTION",
        );
      if (change.targetKind === "METADATA")
        try {
          JSON.parse(input.editedBody);
        } catch {
          throw new WorkflowError(
            "The edited metadata value must be valid JSON.",
            422,
            "INVALID_SUGGESTION",
          );
        }
      if (change.targetKind === "RELATIONSHIP")
        try {
          JSON.parse(input.editedBody);
        } catch {
          throw new WorkflowError(
            "The edited relationship must be valid JSON.",
            422,
            "INVALID_SUGGESTION",
          );
        }
      const editorHash = sha256(input.editedBody);
      const edited = await transaction.proposalChange.update({
        where: { id: change.id },
        data: {
          editorBody: input.editedBody,
          editorHash,
          editedAt: new Date(),
          editedById: input.actorId,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "PROPOSAL_CHANGE_EDITED",
          subjectType: "PROPOSAL_CHANGE",
          subjectId: change.id,
          payload: {
            proposalId: change.proposalId,
            originalAfterHash: change.afterHash,
            editorHash,
            targetKind: change.targetKind,
            targetKey: change.targetKey,
          },
        },
      });
      return { state: edited.state, modified: true, editorHash };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function acceptAllProposalChanges(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  proposalId: string;
  revisionId: string;
  bundleHash: string;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await proposalCheckout(transaction, input);
      const proposal = await transaction.reviewProposal.findFirst({
        where: {
          id: input.proposalId,
          job: { situationId: checkout.situationId },
        },
        include: { changes: { orderBy: { position: "asc" } } },
      });
      if (!proposal) throw new WorkflowError("Review proposal not found.", 404);
      assertCurrentProposalRevision(proposal, input);
      const pending = proposal.changes.filter(
        (change) => change.state === "PENDING",
      );
      const actionable = pending.filter((change) =>
        isProposalChangeApplicable(change),
      );
      const manual = pending.filter(
        (change) => !isProposalChangeApplicable(change),
      );
      if (!actionable.length)
        throw new WorkflowError(
          "There are no unresolved automatic suggestions to accept.",
          422,
          "NO_ACTIONABLE_SUGGESTIONS",
        );
      const created = await applyProposalChanges(transaction, {
        actorId: input.actorId,
        checkout,
        changes: actionable,
        namedCheckpoint: `Accepted all ${actionable.length} agent suggestions`,
        proposalId: proposal.id,
      });
      const now = new Date();
      const accepted = await transaction.proposalChange.updateMany({
        where: {
          id: { in: actionable.map((change) => change.id) },
          state: "PENDING",
        },
        data: {
          state: "ACCEPTED",
          decidedAt: now,
          decidedById: input.actorId,
          appliedRevisionId: created.id,
        },
      });
      if (accepted.count !== actionable.length)
        throw new WorkflowError(
          "The suggestion set changed before atomic acceptance.",
          409,
          "STALE_SUGGESTION_SET",
        );
      await transaction.reviewProposal.update({
        where: { id: proposal.id },
        data: {
          currentRevisionId: created.id,
          currentBundleHash: created.bundleHash,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "PROPOSAL_CHANGES_ACCEPTED_ALL",
          subjectType: "REVIEW_PROPOSAL",
          subjectId: proposal.id,
          payload: {
            inputRevisionId: proposal.inputRevisionId,
            appliedRevisionId: created.id,
            appliedCount: actionable.length,
            manualRemainingCount: manual.length,
            changeIds: actionable.map((change) => change.id),
          },
        },
      });
      return {
        state: "ACCEPTED" as const,
        authoritativeRevision: authoritativeRevisionPayload(created),
        appliedCount: actionable.length,
        manualRemainingCount: manual.length,
      };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function rejectAllProposalChanges(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  proposalId: string;
  revisionId: string;
  bundleHash: string;
}) {
  return database().$transaction(
    async (transaction) => {
      const checkout = await proposalCheckout(transaction, input);
      const proposal = await transaction.reviewProposal.findFirst({
        where: {
          id: input.proposalId,
          job: { situationId: checkout.situationId },
        },
        include: { changes: { orderBy: { position: "asc" } } },
      });
      if (!proposal) throw new WorkflowError("Review proposal not found.", 404);
      assertCurrentProposalRevision(proposal, input);
      const pending = proposal.changes.filter(
        (change) => change.state === "PENDING",
      );
      if (!pending.length)
        throw new WorkflowError(
          "There are no unresolved suggestions to reject.",
          422,
          "NO_ACTIONABLE_SUGGESTIONS",
        );
      const now = new Date();
      const rejected = await transaction.proposalChange.updateMany({
        where: {
          id: { in: pending.map((change) => change.id) },
          state: "PENDING",
        },
        data: {
          state: "REJECTED",
          decidedAt: now,
          decidedById: input.actorId,
        },
      });
      if (rejected.count !== pending.length)
        throw new WorkflowError(
          "The suggestion set changed before atomic rejection.",
          409,
          "STALE_SUGGESTION_SET",
        );
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "PROPOSAL_CHANGES_REJECTED_ALL",
          subjectType: "REVIEW_PROPOSAL",
          subjectId: proposal.id,
          payload: {
            rejectedCount: pending.length,
            changeIds: pending.map((change) => change.id),
          },
        },
      });
      return {
        state: "REJECTED" as const,
        rejectedCount: pending.length,
        authoritativeRevision: authoritativeRevisionPayload(
          checkout.draft.revisions[0]!,
        ),
      };
    },
    { isolationLevel: "Serializable" },
  );
}

export async function workspaceForSlug(slug: string) {
  return database().situation.findUnique({
    where: { slug },
    include: {
      checkouts: {
        where: { releasedAt: null },
        include: { holder: { select: { id: true, displayName: true } } },
      },
      drafts: {
        where: { state: "ACTIVE" },
        include: {
          revisions: {
            orderBy: { revision: "desc" },
            take: 1,
            include: { artifacts: { include: { content: true } } },
          },
        },
      },
      reviewJobs: {
        orderBy: [{ laneOwner: "desc" }, { queuedAt: "desc" }],
        take: 1,
        include: {
          inputRevision: {
            include: {
              artifacts: {
                where: { kind: "SITUATION" },
                include: { content: true },
              },
            },
          },
          steps: {
            orderBy: { ordinal: "asc" },
            include: {
              runs: {
                orderBy: { attempt: "desc" },
                take: 1,
                select: {
                  attempt: true,
                  failureClass: true,
                  retryable: true,
                },
              },
            },
          },
          proposal: {
            include: {
              candidate: true,
              findings: { orderBy: { position: "asc" } },
              changes: {
                orderBy: { position: "asc" },
                include: {
                  findingLinks: {
                    include: { finding: true },
                  },
                },
              },
            },
          },
        },
      },
      publicationJobs: {
        orderBy: { createdAt: "desc" },
        take: 1,
        include: {
          events: {
            orderBy: { sequence: "asc" },
            select: {
              sequence: true,
              kind: true,
              createdAt: true,
              payload: true,
            },
          },
        },
      },
      productionVersions: {
        orderBy: { productionAt: "desc" },
        include: {
          observation: true,
          artifacts: { include: { content: true } },
        },
      },
      variants: { include: { content: true }, orderBy: { createdAt: "desc" } },
    },
  });
}

export async function publicationRecoveryRequired() {
  return Boolean(
    await database().publicationJob.findFirst({
      where: { state: "RECOVERY_REQUIRED" },
      select: { id: true },
    }),
  );
}
