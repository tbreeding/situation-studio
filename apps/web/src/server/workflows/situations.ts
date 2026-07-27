import { Prisma, type DatabaseClient } from "@situation-studio/db";
import {
  CONTRACT_VERSION,
  VALIDATION_POLICY_VERSION,
  bundleHash,
  canonicalText,
  canonicalJson,
  createScopedVariant,
  applySectionProposal,
  parseSituationSections,
  proposalChangeSchema,
  relationshipSchema,
  requiredSituationSections,
  reviewStages,
  serializeSituationSections,
  sha256,
  situationBundleSchema,
  situationMetadataSchema,
  validateSituationBundle,
  type SituationBundle,
  type SituationMetadata,
  type SituationSections,
} from "@situation-studio/domain";
import { database } from "@/server/database";
import { reconcileLeadershipRelease } from "@/server/leadership-sync";

type Transaction = Parameters<Parameters<DatabaseClient["$transaction"]>[0]>[0];

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = "WORKFLOW_CONFLICT",
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

async function assertNoActivePublication(
  transaction: Transaction,
  situationId: string,
) {
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
  await assertNoActiveReview(transaction, situationId);
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
  defaultPractice?: SituationBundle["relationships"][number];
}): { bundle: SituationBundle; body: string } {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const body = serializeSituationSections(templateSections);
  const metadata: SituationMetadata = {
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
    socialHook:
      "A clear next move for the management conversation you have been postponing.",
    campaignCluster: "manager_conversations",
  };
  const relationships = input.defaultPractice ? [input.defaultPractice] : [];
  return {
    body,
    bundle: {
      schemaVersion: "situation-bundle-v1",
      contractVersion: CONTRACT_VERSION,
      validationPolicyVersion: VALIDATION_POLICY_VERSION,
      situationId: input.situationId,
      visibility: "UNPUBLISHED",
      metadata,
      bodyHash: sha256(body),
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
    },
  };
}

async function defaultPracticeRelationship(transaction: Transaction) {
  const versions = await transaction.productionSituationVersion.findMany({
    orderBy: { productionAt: "desc" },
    take: 100,
    select: { bundleManifest: true },
  });
  let fallback: SituationBundle["relationships"][number] | undefined;
  for (const version of versions) {
    const bundle = situationBundleSchema.safeParse(version.bundleManifest);
    if (!bundle.success) continue;
    const practices = bundle.data.relationships.filter(
      (relationship) => relationship.kind === "PRACTICE",
    );
    const preferred = practices.find(
      (relationship) => relationship.logicalId === "practice:listen-first",
    );
    if (preferred) return { ...preferred, position: 0 };
    fallback ??= practices[0];
  }
  return fallback ? { ...fallback, position: 0 } : undefined;
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

async function createRevision(
  transaction: Transaction,
  input: {
    draftId: string;
    actorId: string;
    bundle: SituationBundle;
    body: string;
    namedCheckpoint: string;
  },
) {
  const draft = await transaction.draft.findUniqueOrThrow({
    where: { id: input.draftId },
    include: {
      revisions: { orderBy: { revision: "desc" }, take: 1 },
    },
  });
  const canonicalBody = canonicalText(input.body);
  const parsedBundle = situationBundleSchema.parse({
    ...input.bundle,
    bodyHash: sha256(canonicalBody),
  });
  const nextBundleHash = bundleHash(parsedBundle);
  const previous = draft.revisions[0];
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
  });
  await transaction.draft.update({
    where: { id: draft.id },
    data: {
      currentRevisionNumber: revision.revision,
      currentBundleHash: revision.bundleHash,
    },
  });
  return revision;
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
  const defaultPractice = baseVersion
    ? undefined
    : await defaultPracticeRelationship(transaction);
  const baseline = baseVersion
    ? {
        bundle: situationBundleSchema.parse(baseVersion.bundleManifest),
        body: body ?? "",
      }
    : newSituationTemplate({
        situationId: situation.id,
        slug: situation.slug,
        title: situation.title,
        ...(defaultPractice ? { defaultPractice } : {}),
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
  namedCheckpoint?: string;
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
      const parsed = situationBundleSchema.parse(input.bundle);
      if (parsed.situationId !== checkout.situationId)
        throw new WorkflowError("The draft does not belong to this checkout.");
      const validation = validateSituationBundle(parsed, input.body);
      if (!validation.valid)
        throw new WorkflowError(
          validation.errors.join(" "),
          422,
          "INVALID_CONTENT",
        );
      return createRevision(transaction, {
        draftId: checkout.draftId,
        actorId: input.actorId,
        bundle: parsed,
        body: input.body,
        namedCheckpoint: input.namedCheckpoint ?? "Autosave",
      });
    },
    { isolationLevel: "Serializable" },
  );
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
            situationId: input.situationId,
            state: { in: ["QUEUED", "RUNNING"] },
          },
          state: { in: ["PENDING", "READY", "RUNNING"] },
        },
        data: { state: "CANCELLED", finishedAt: now },
      });
      await transaction.reviewJob.updateMany({
        where: {
          situationId: input.situationId,
          state: { in: ["QUEUED", "RUNNING"] },
        },
        data: {
          state: "CANCELLED",
          fence: { increment: 1 },
          cancelledAt: now,
          cancelledById: input.adminId,
          cancellationReason: "Administrative force check-in",
          finishedAt: now,
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

export async function queueReview(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
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
                revisions: { orderBy: { revision: "desc" }, take: 1 },
              },
            },
          },
        });
        if (!checkout)
          throw new WorkflowError("The checkout is no longer active.");
        await assertNoActivePublication(transaction, checkout.situationId);
        const revision = checkout.draft.revisions[0];
        if (!revision) throw new WorkflowError("Save the draft before review.");
        const job = await transaction.reviewJob.create({
          data: {
            situationId: checkout.situationId,
            inputRevisionId: revision.id,
            checkoutId: checkout.id,
            checkoutFence: checkout.fence,
            contextHash: sha256(
              JSON.stringify({
                bundleHash: revision.bundleHash,
                contractVersion: revision.contractVersion,
              }),
            ),
            contractVersion: revision.contractVersion,
            policyVersion: revision.validationPolicy,
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
  reason?: string;
}) {
  return database().$transaction(
    async (transaction) => {
      const job = await transaction.reviewJob.findFirst({
        where: { id: input.jobId, state: { in: ["QUEUED", "RUNNING"] } },
      });
      if (!job) throw new WorkflowError("The review is no longer active.", 404);
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
          state: { in: ["PENDING", "READY", "RUNNING"] },
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
          payload: { fence: cancelled.fence.toString() },
        },
      });
      return cancelled;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function retryReview(input: { actorId: string; jobId: string }) {
  return database().$transaction(
    async (transaction) => {
      const job = await transaction.reviewJob.findFirst({
        where: { id: input.jobId, state: "FAILED" },
        include: {
          steps: { orderBy: { ordinal: "asc" } },
        },
      });
      if (!job)
        throw new WorkflowError("The failed review is unavailable.", 404);
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
          queuedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
          retryNotBefore: null,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: input.actorId,
          action: "REVIEW_RETRIED",
          subjectType: "REVIEW_JOB",
          subjectId: job.id,
          payload: { resumedOrdinal: failed.ordinal },
        },
      });
      return queued;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function requestPublication(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
}) {
  await reconcileLeadershipRelease();
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
          situation: true,
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
      await assertNoActivePublication(transaction, checkout.situationId);
      await assertNoActiveReview(transaction, checkout.situationId);
      const revision = checkout.draft.revisions[0];
      const body = revision?.artifacts.find(
        (artifact) => artifact.kind === "SITUATION",
      )?.content.textBody;
      if (!revision || !body)
        throw new WorkflowError("The latest saved revision is unavailable.");
      const targetBundle = situationBundleSchema.parse(revision.bundleManifest);
      const agentAssisted = await transaction.proposalChange.count({
        where: { appliedRevisionId: revision.id, state: "ACCEPTED" },
      });
      const sourceKind = checkout.draft.restorationParentId
        ? "RESTORE"
        : !checkout.situation.productionBundleHash
          ? "CREATE"
          : targetBundle.visibility === "RETIRED"
            ? "RETIRE"
            : agentAssisted
              ? "AGENT_ASSISTED"
              : "MANUAL";
      const validation = validateSituationBundle(revision.bundleManifest, body);
      if (!validation.valid || validation.bundleHash !== revision.bundleHash)
        throw new WorkflowError(
          validation.errors.join(" ") || "Exact-hash validation failed.",
          422,
          "VALIDATION_FAILED",
        );
      const job = await transaction.publicationJob.create({
        data: {
          publicationId: crypto.randomUUID(),
          situationId: checkout.situationId,
          targetRevisionId: revision.id,
          checkoutId: checkout.id,
          checkoutFence: checkout.fence,
          sourceKind,
          targetBundleHash: revision.bundleHash,
          baseBundleHash: checkout.draft.baseBundleHash,
          restorationParentId: checkout.draft.restorationParentId,
          events: {
            create: {
              sequence: 1,
              kind: "REQUESTED",
              payload: {
                sourceKind,
                targetBundleHash: revision.bundleHash,
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
            sourceKind,
            targetBundleHash: revision.bundleHash,
          },
        },
      });
      return job;
    },
    { isolationLevel: "Serializable" },
  );
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
      const nextBundle = situationBundleSchema.parse({
        ...situationBundleSchema.parse(revision.bundleManifest),
        visibility: "RETIRED",
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
      const variant = createScopedVariant({
        situationId: checkout.situationId,
        kind: input.kind,
        originalLogicalId: input.originalLogicalId,
        originalContentHash: input.originalContentHash,
        changedBody: input.changedBody,
      });
      await putTextBlob(
        transaction,
        variant.body,
        input.kind === "PRACTICE" || input.kind === "SOURCE"
          ? "application/json; charset=utf-8"
          : "text/markdown; charset=utf-8",
      );
      await transaction.scopedArtifactVariant.create({
        data: {
          ownerSituationId: checkout.situationId,
          logicalId: variant.artifact.logicalId,
          kind: input.kind,
          visibility: variant.artifact.visibility,
          forkedFromLogicalId: input.originalLogicalId,
          forkedFromContentHash: input.originalContentHash,
          contentHash: variant.artifact.contentHash,
        },
      });
      const nextBundle = situationBundleSchema.parse({
        ...currentBundle,
        artifacts: [
          ...currentBundle.artifacts.filter(
            (artifact) => artifact.logicalId !== variant.artifact.logicalId,
          ),
          variant.artifact,
        ],
        relationships: currentBundle.relationships.map((item) =>
          item.logicalId === input.originalLogicalId
            ? {
                ...item,
                logicalId: variant.artifact.logicalId,
                contentHash: variant.artifact.contentHash,
                visibility: variant.artifact.visibility,
              }
            : item,
        ),
        contextHashes: currentBundle.relationships.map((item) =>
          item.logicalId === input.originalLogicalId
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
        return { state: "REJECTED" as const, revisionId: null };
      }
      if (change.applicationMode !== "AUTOMATIC")
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
      return { state: "ACCEPTED" as const, revisionId: created.id };
    },
    { isolationLevel: "Serializable" },
  );
}

type ProposalCheckout = Awaited<ReturnType<typeof proposalCheckout>>;

async function proposalCheckout(
  transaction: Transaction,
  input: { actorId: string; checkoutId: string; fence: bigint },
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
  return checkout;
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

function proposedBody(change: ApplicableProposalChange) {
  return change.editorBody ?? change.afterBody;
}

function staleSuggestion(target: string): never {
  throw new WorkflowError(
    `${target} changed after this review. Run a new review or resolve it manually.`,
    409,
    "STALE_SUGGESTION",
  );
}

async function applyProposalChanges(
  transaction: Transaction,
  input: {
    actorId: string;
    checkout: ProposalCheckout;
    changes: ApplicableProposalChange[];
    namedCheckpoint: string;
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
    if (change.applicationMode !== "AUTOMATIC")
      throw new WorkflowError(
        `Manual suggestion ${change.targetKey} cannot be included in automatic acceptance.`,
        422,
        "MANUAL_SUGGESTION",
      );
    const afterBody = proposedBody(change);
    if (change.targetKind === "SECTION") {
      const sections = parseSituationSections(body);
      const before = sections[change.targetKey as keyof typeof sections];
      if (
        before === undefined ||
        sha256(canonicalText(before)) !== change.beforeHash
      )
        staleSuggestion(change.targetKey);
      const proposal = proposalChangeSchema.parse({
        id: change.id,
        targetKind: change.targetKind,
        targetKey: change.targetKey,
        beforeHash: change.beforeHash,
        afterBody,
        rationale: "Fenced candidate application.",
      });
      body = serializeSituationSections(
        applySectionProposal(sections, proposal),
      );
      continue;
    }
    if (change.targetKind === "METADATA") {
      if (!(change.targetKey in bundle.metadata))
        staleSuggestion(change.targetKey);
      const current =
        bundle.metadata[change.targetKey as keyof typeof bundle.metadata];
      if (sha256(canonicalJson(current)) !== change.beforeHash)
        staleSuggestion(change.targetKey);
      let after: unknown;
      try {
        after = JSON.parse(afterBody);
      } catch {
        throw new WorkflowError(
          `Edited metadata suggestion ${change.targetKey} is not valid JSON.`,
          422,
          "INVALID_SUGGESTION",
        );
      }
      const metadata = situationMetadataSchema.parse({
        ...bundle.metadata,
        [change.targetKey]: after,
      });
      bundle = situationBundleSchema.parse({ ...bundle, metadata });
      continue;
    }
    if (change.targetKind === "RELATIONSHIP") {
      const current =
        bundle.relationships.find(
          (relationship) => relationship.logicalId === change.targetKey,
        ) ?? null;
      const currentHash = current ? sha256(canonicalJson(current)) : null;
      if (currentHash !== change.beforeHash) staleSuggestion(change.targetKey);
      let after: unknown;
      try {
        after = JSON.parse(afterBody);
      } catch {
        throw new WorkflowError(
          `Edited relationship suggestion ${change.targetKey} is not valid JSON.`,
          422,
          "INVALID_SUGGESTION",
        );
      }
      const relationship =
        after === null ? null : relationshipSchema.parse(after);
      if (relationship && relationship.logicalId !== change.targetKey)
        throw new WorkflowError(
          "A relationship replacement must retain its target logical ID.",
          422,
          "INVALID_SUGGESTION",
        );
      if (
        relationship &&
        !(await transaction.contentBlob.findUnique({
          where: { hash: relationship.contentHash },
          select: { hash: true },
        }))
      )
        throw new WorkflowError(
          "The suggested relationship content is not available.",
          422,
          "MISSING_RELATIONSHIP_CONTENT",
        );
      const index = bundle.relationships.findIndex(
        (candidate) => candidate.logicalId === change.targetKey,
      );
      const relationships = [...bundle.relationships];
      if (index >= 0 && relationship) relationships[index] = relationship;
      else if (index >= 0) relationships.splice(index, 1);
      else if (relationship) relationships.push(relationship);
      bundle = situationBundleSchema.parse({
        ...bundle,
        relationships,
        contextHashes: relationships.map((candidate) => candidate.contentHash),
      });
      continue;
    }
    if (change.targetKind === "SCOPED_VARIANT") {
      const relationship = bundle.relationships.find(
        (candidate) => candidate.logicalId === change.targetKey,
      );
      if (!relationship || relationship.contentHash !== change.beforeHash)
        staleSuggestion(change.targetKey);
      if (
        ![
          "GUIDE",
          "PRACTICE",
          "SOURCE",
          "LESSON_PLAN",
          "PREPARATION_PROMPT",
        ].includes(relationship.kind)
      )
        throw new WorkflowError(
          "The suggested shared target cannot be safely scoped.",
          422,
          "INVALID_SUGGESTION",
        );
      const variant = createScopedVariant({
        situationId: input.checkout.situationId,
        kind: relationship.kind as
          | "GUIDE"
          | "PRACTICE"
          | "SOURCE"
          | "LESSON_PLAN"
          | "PREPARATION_PROMPT",
        originalLogicalId: relationship.logicalId,
        originalContentHash: relationship.contentHash,
        changedBody: afterBody,
      });
      await putTextBlob(
        transaction,
        variant.body,
        relationship.kind === "PRACTICE" || relationship.kind === "SOURCE"
          ? "application/json; charset=utf-8"
          : "text/markdown; charset=utf-8",
      );
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
            forkedFromLogicalId: relationship.logicalId,
            forkedFromContentHash: relationship.contentHash,
            contentHash: variant.artifact.contentHash,
          },
        });
      else if (
        existingVariant.ownerSituationId !== input.checkout.situationId ||
        existingVariant.forkedFromLogicalId !== relationship.logicalId ||
        existingVariant.forkedFromContentHash !== relationship.contentHash ||
        existingVariant.contentHash !== variant.artifact.contentHash
      )
        throw new WorkflowError(
          "The scoped suggestion conflicts with a retained variant.",
          409,
          "SCOPED_VARIANT_CONFLICT",
        );
      const relationships = bundle.relationships.map((candidate) =>
        candidate.logicalId === relationship.logicalId
          ? {
              ...candidate,
              logicalId: variant.artifact.logicalId,
              contentHash: variant.artifact.contentHash,
              visibility: variant.artifact.visibility,
            }
          : candidate,
      );
      bundle = situationBundleSchema.parse({
        ...bundle,
        artifacts: bundle.artifacts.some(
          (artifact) => artifact.logicalId === variant.artifact.logicalId,
        )
          ? bundle.artifacts
          : [...bundle.artifacts, variant.artifact],
        relationships,
        contextHashes: relationships.map((candidate) => candidate.contentHash),
      });
      continue;
    }
    throw new WorkflowError(
      `Suggestion type ${change.targetKind} is not safely auto-applicable.`,
      422,
      "UNSUPPORTED_SUGGESTION",
    );
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
  });
}

export async function editProposalChange(input: {
  actorId: string;
  checkoutId: string;
  fence: bigint;
  changeId: string;
  editedBody: string;
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
      });
      if (!change) throw new WorkflowError("Proposal change not found.", 404);
      if (change.state !== "PENDING")
        throw new WorkflowError("That proposal change is already decided.");
      if (change.applicationMode !== "AUTOMATIC")
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
      const pending = proposal.changes.filter(
        (change) => change.state === "PENDING",
      );
      const actionable = pending.filter(
        (change) => change.applicationMode === "AUTOMATIC",
      );
      const manual = pending.filter(
        (change) => change.applicationMode === "MANUAL",
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
      });
      const now = new Date();
      const accepted = await transaction.proposalChange.updateMany({
        where: {
          id: { in: actionable.map((change) => change.id) },
          state: "PENDING",
          applicationMode: "AUTOMATIC",
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
        revisionId: created.id,
        appliedCount: actionable.length,
        manualRemainingCount: manual.length,
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
        orderBy: { queuedAt: "desc" },
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
      publicationJobs: { orderBy: { createdAt: "desc" }, take: 1 },
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
