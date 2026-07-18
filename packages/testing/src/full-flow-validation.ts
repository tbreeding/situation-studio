import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "@situation-studio/db";
import {
  LEADERSHIP_REVIEW_WORKFLOW_VERSION,
  MODEL_POLICY,
  sha256,
} from "@situation-studio/domain";
import {
  acquireCheckout,
  saveDraft,
} from "../../../apps/web/src/server/workflows/checkouts";
import { prepareBundleForHumanApproval } from "../../../apps/web/src/server/workflows/review-provenance";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const databaseName = new URL(databaseUrl).pathname.slice(1);
if (!databaseName.startsWith("situation_studio_full_validation_"))
  throw new Error(
    "Refusing full-flow harness outside a situation_studio_full_validation_* database.",
  );
const mode = process.argv[2];
const database = createDatabaseClient(databaseUrl, 3);

async function seed() {
  const existing = await database.aiJob.findFirst({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
  });
  if (existing)
    return {
      mode: "seed",
      reused: true,
      jobId: existing.id,
      state: existing.state,
    };
  const user = await database.user.findFirstOrThrow({
    where: { identityType: "HUMAN", state: "ACTIVE" },
    orderBy: { createdAt: "asc" },
  });
  const situation = await database.situation.findUniqueOrThrow({
    where: { slug: "make-bad-attitude-specific" },
    include: {
      currentPublication: {
        include: {
          version: {
            include: {
              artifacts: { include: { artifact: true, content: true } },
            },
          },
        },
      },
      versions: {
        orderBy: { createdAt: "asc" },
        take: 1,
        include: {
          artifacts: { include: { artifact: true, content: true } },
        },
      },
    },
  });
  const artifact =
    situation.currentPublication?.version?.artifacts.find(
      (item) =>
        item.artifact.logicalId === "situation:make-bad-attitude-specific",
    ) ??
    situation.versions[0]?.artifacts.find(
      (item) =>
        item.artifact.logicalId === "situation:make-bad-attitude-specific",
    );
  if (!artifact)
    throw new Error("Validation situation artifact is unavailable.");
  const acquired = await acquireCheckout(database, {
    situationId: situation.id,
    userId: user.id,
    mode: "EDITING",
  });
  if (!acquired.ok)
    throw new Error("Validation situation is already checked out.");
  const baseBody = artifact.content.body.replace(
    /\n(?:<!-- Situation Studio isolated full-flow validation fixture\. -->|\{\/\* Situation Studio isolated full-flow validation fixture\. \*\/\})\n$/u,
    "\n",
  );
  const body = `${baseBody.replace(/\n+$/u, "")}\n\n{/* Situation Studio isolated full-flow validation fixture. */}\n`;
  const saved = await saveDraft(database, {
    draftId: acquired.draft.id,
    checkoutId: acquired.checkout.id,
    userId: user.id,
    fencingToken: acquired.checkout.fencingToken,
    expectedRevision: acquired.draft.currentRevision,
    clientMutationId: randomUUID(),
    artifactId: artifact.artifactId,
    body,
  });
  if (!saved.ok) throw new Error("Validation draft could not be saved.");
  const draft = await database.draft.findUniqueOrThrow({
    where: { id: acquired.draft.id },
    include: {
      baseSnapshot: true,
      revisions: { orderBy: { revision: "desc" }, take: 1 },
    },
  });
  const revision = draft.revisions[0];
  if (!revision) throw new Error("Validation draft revision is unavailable.");
  const job = await database.$transaction(async (transaction) => {
    const row = await transaction.aiJob.create({
      data: {
        kind: "FULL_REVIEW",
        ownerId: user.id,
        situationId: situation.id,
        draftId: draft.id,
        inputBundleHash: revision.manifestHash,
        graphHash: sha256(JSON.stringify(draft.baseSnapshot.manifest)),
        workflowVersion: LEADERSHIP_REVIEW_WORKFLOW_VERSION,
        modelPolicyVersion: MODEL_POLICY.version,
        state: "QUEUED",
        stage: "Waiting for complete-review capacity",
        idempotencyKey: `full-flow-validation-${randomUUID()}`,
      },
    });
    await transaction.draft.update({
      where: { id: draft.id },
      data: { state: "AI_REVIEW_QUEUED" },
    });
    const fenced = await transaction.situation.update({
      where: { id: situation.id },
      data: { fence: { increment: 1 } },
    });
    const transferred = await transaction.situationCheckout.updateMany({
      where: {
        id: acquired.checkout.id,
        custody: "USER",
        fencingToken: acquired.checkout.fencingToken,
        releasedAt: null,
      },
      data: {
        holderUserId: null,
        mode: "AI_QUEUED",
        custody: "AI_JOB",
        custodyReference: row.id,
        fencingToken: fenced.fence,
        transferReason: "FULL_FLOW_VALIDATION",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    if (transferred.count !== 1)
      throw new Error("AI checkout transfer was lost.");
    return row;
  });
  return {
    mode: "seed",
    reused: false,
    jobId: job.id,
    situation: situation.slug,
    candidateHash: saved.contentHash,
  };
}

async function approveAndStage() {
  const job = await database.aiJob.findFirstOrThrow({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
    include: {
      bundles: {
        orderBy: { revision: "desc" },
        take: 1,
        include: { validations: true, approvals: true },
      },
    },
  });
  if (job.state !== "SUCCEEDED")
    throw new Error(`Review is not successful: ${job.state}`);
  const aiBundle = job.bundles[0];
  if (!aiBundle) throw new Error("Review did not produce a bundle.");
  if (
    !aiBundle.validations.length ||
    aiBundle.validations.some((validation) => validation.state !== "PASSED")
  )
    throw new Error("Review produced blocking validation findings.");
  const priorRequest = await database.publicationRequest.findFirst({
    where: {
      bundle: {
        OR: [{ id: aiBundle.id }, { parentBundleId: aiBundle.id }],
      },
    },
  });
  if (priorRequest)
    return {
      mode: "approve-stage",
      reused: true,
      requestId: priorRequest.id,
      state: priorRequest.state,
    };
  const user = await database.user.findUniqueOrThrow({
    where: { id: job.ownerId },
  });
  if (!user.repositoryReviewerId)
    throw new Error(
      "Full-flow human account requires a repository reviewer identity.",
    );
  const prepared = await prepareBundleForHumanApproval(database, {
    bundleId: aiBundle.id,
    userId: user.id,
    repositoryReviewerId: user.repositoryReviewerId,
  });
  const bundle = await database.proposedBundle.findUniqueOrThrow({
    where: { id: prepared.bundle.id },
    include: {
      validations: true,
      approvals: true,
      comments: { where: { status: "OPEN", blocking: true } },
    },
  });
  if (bundle.comments.length)
    throw new Error("Prepared bundle has unresolved blocking comments.");
  const session = await database.session.create({
    data: {
      tokenHash: sha256(randomUUID()),
      userId: user.id,
      passwordVersion: user.passwordVersion,
      csrfSecretHash: sha256(randomUUID()),
      reauthenticatedAt: new Date(),
      idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
    },
  });
  const validationPolicyHash = sha256(
    JSON.stringify(
      bundle.validations
        .map((item) => [item.validator, item.version, item.environmentHash])
        .sort(),
    ),
  );
  const publicationUuid = randomUUID();
  const request = await database.$transaction(async (transaction) => {
    const approval = await transaction.approval.create({
      data: {
        bundleId: bundle.id,
        bundleHash: bundle.canonicalHash,
        baseCommit: bundle.baseCommit,
        validationPolicyHash,
        approvedById: user.id,
        repositoryReviewerId: user.repositoryReviewerId,
        contentReviewDate: prepared.provenance.reviewDate,
        sessionId: session.id,
        permissionSnapshot: ["publication.approve", "publication.publish"],
      },
    });
    await transaction.proposedBundle.update({
      where: { id: bundle.id },
      data: { state: "APPROVED" },
    });
    await transaction.draft.update({
      where: { id: bundle.draftId },
      data: { state: "APPROVED" },
    });
    await transaction.$executeRaw`SELECT id FROM situations WHERE id = ${bundle.situationId}::uuid FOR UPDATE`;
    const checkout = await transaction.situationCheckout.findFirstOrThrow({
      where: {
        situationId: bundle.situationId,
        draftId: bundle.draftId,
        holderUserId: user.id,
        custody: "USER",
        releasedAt: null,
      },
    });
    const fenced = await transaction.situation.update({
      where: { id: bundle.situationId },
      data: { fence: { increment: 1 } },
    });
    const row = await transaction.publicationRequest.create({
      data: {
        publicationUuid,
        idempotencyKey: `full-flow-validation-${randomUUID()}`,
        targetEnvironment: "protected-beta",
        bundleId: bundle.id,
        bundleHash: bundle.canonicalHash,
        approvalId: approval.id,
        baseCommit: bundle.baseCommit,
        state: "REQUESTED",
        currentStep: "REQUESTED",
        requestedById: user.id,
      },
    });
    const transferred = await transaction.situationCheckout.updateMany({
      where: {
        id: checkout.id,
        fencingToken: checkout.fencingToken,
        custody: "USER",
        releasedAt: null,
      },
      data: {
        custody: "PUBLISHER",
        custodyReference: row.id,
        mode: "PUBLISHING",
        fencingToken: fenced.fence,
        transferReason: "FULL_FLOW_VALIDATION",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    if (transferred.count !== 1)
      throw new Error("Publisher checkout transfer was lost.");
    await transaction.draft.update({
      where: { id: bundle.draftId },
      data: { state: "PUBLISHING" },
    });
    return row;
  });
  return {
    mode: "approve-stage",
    reused: false,
    bundleId: bundle.id,
    requestId: request.id,
    state: request.state,
  };
}

async function fixAndRerun() {
  const priorJob = await database.aiJob.findFirstOrThrow({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
  });
  if (priorJob.state !== "SUCCEEDED")
    throw new Error(`Prior review is not complete: ${priorJob.state}`);
  const draft = await database.draft.findUniqueOrThrow({
    where: { id: priorJob.draftId },
    include: {
      baseSnapshot: true,
      revisions: {
        orderBy: { revision: "desc" },
        take: 1,
        include: {
          artifacts: { include: { artifact: true, content: true } },
        },
      },
    },
  });
  const revision = draft.revisions[0];
  const artifact = revision?.artifacts.find(
    (item) =>
      item.artifact.logicalId === "situation:make-bad-attitude-specific",
  );
  if (!revision || !artifact)
    throw new Error("Review correction artifact is unavailable.");
  const checkout = await database.situationCheckout.findFirstOrThrow({
    where: {
      situationId: priorJob.situationId,
      holderUserId: priorJob.ownerId,
      custody: "USER",
      releasedAt: null,
    },
  });
  const body = artifact.content.body.replace(
    "promptly escalate suspected discrimination, retaliation, harassment, threats, or protected activity through the correct process",
    "promptly escalate concerns about discrimination, retaliation, harassment, threats, or interference with protected activity through the correct process",
  );
  if (body === artifact.content.body)
    throw new Error("The adjudicated validation correction was not found.");
  const saved = await saveDraft(database, {
    draftId: draft.id,
    checkoutId: checkout.id,
    userId: priorJob.ownerId,
    fencingToken: checkout.fencingToken,
    expectedRevision: draft.currentRevision,
    clientMutationId: randomUUID(),
    artifactId: artifact.artifactId,
    body,
  });
  if (!saved.ok) throw new Error("Corrected draft could not be saved.");
  const corrected = await database.draftRevision.findUniqueOrThrow({
    where: {
      draftId_revision: { draftId: draft.id, revision: saved.revision },
    },
  });
  const job = await database.$transaction(async (transaction) => {
    const row = await transaction.aiJob.create({
      data: {
        kind: "FULL_REVIEW",
        ownerId: priorJob.ownerId,
        situationId: priorJob.situationId,
        draftId: draft.id,
        inputBundleHash: corrected.manifestHash,
        graphHash: sha256(JSON.stringify(draft.baseSnapshot.manifest)),
        workflowVersion: LEADERSHIP_REVIEW_WORKFLOW_VERSION,
        modelPolicyVersion: MODEL_POLICY.version,
        runNonce: randomUUID(),
        state: "QUEUED",
        stage: "Waiting for corrected complete-review capacity",
        idempotencyKey: `full-flow-validation-${randomUUID()}`,
      },
    });
    await transaction.draft.update({
      where: { id: draft.id },
      data: { state: "AI_REVIEW_QUEUED" },
    });
    const fenced = await transaction.situation.update({
      where: { id: priorJob.situationId },
      data: { fence: { increment: 1 } },
    });
    const transferred = await transaction.situationCheckout.updateMany({
      where: {
        id: checkout.id,
        custody: "USER",
        fencingToken: checkout.fencingToken,
        releasedAt: null,
      },
      data: {
        holderUserId: null,
        mode: "AI_QUEUED",
        custody: "AI_JOB",
        custodyReference: row.id,
        fencingToken: fenced.fence,
        transferReason: "FULL_FLOW_VALIDATION_CORRECTION",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    if (transferred.count !== 1)
      throw new Error("Corrected AI checkout transfer was lost.");
    return row;
  });
  return {
    mode: "fix-and-rerun",
    jobId: job.id,
    revision: saved.revision,
    candidateHash: saved.contentHash,
  };
}

async function rerunCurrentRevision() {
  const priorJob = await database.aiJob.findFirstOrThrow({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
  });
  if (!["CANCELLED", "SUCCEEDED", "FAILED"].includes(priorJob.state))
    throw new Error(
      `Prior review has not reached a safe boundary: ${priorJob.state}`,
    );
  const draft = await database.draft.findUniqueOrThrow({
    where: { id: priorJob.draftId },
    include: {
      baseSnapshot: true,
      revisions: { orderBy: { revision: "desc" }, take: 1 },
    },
  });
  const revision = draft.revisions[0];
  if (!revision) throw new Error("Current validation revision is unavailable.");
  const checkout = await database.situationCheckout.findFirstOrThrow({
    where: {
      situationId: priorJob.situationId,
      holderUserId: priorJob.ownerId,
      custody: "USER",
      releasedAt: null,
    },
  });
  const job = await database.$transaction(async (transaction) => {
    const row = await transaction.aiJob.create({
      data: {
        kind: "FULL_REVIEW",
        ownerId: priorJob.ownerId,
        situationId: priorJob.situationId,
        draftId: draft.id,
        inputBundleHash: revision.manifestHash,
        graphHash: sha256(JSON.stringify(draft.baseSnapshot.manifest)),
        workflowVersion: LEADERSHIP_REVIEW_WORKFLOW_VERSION,
        modelPolicyVersion: MODEL_POLICY.version,
        runNonce: randomUUID(),
        state: "QUEUED",
        stage: "Waiting for complete-review retry capacity",
        idempotencyKey: `full-flow-validation-${randomUUID()}`,
      },
    });
    await transaction.draft.update({
      where: { id: draft.id },
      data: { state: "AI_REVIEW_QUEUED" },
    });
    const fenced = await transaction.situation.update({
      where: { id: priorJob.situationId },
      data: { fence: { increment: 1 } },
    });
    const transferred = await transaction.situationCheckout.updateMany({
      where: {
        id: checkout.id,
        custody: "USER",
        fencingToken: checkout.fencingToken,
        releasedAt: null,
      },
      data: {
        holderUserId: null,
        mode: "AI_QUEUED",
        custody: "AI_JOB",
        custodyReference: row.id,
        fencingToken: fenced.fence,
        transferReason: "FULL_FLOW_VALIDATION_RETRY",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    if (transferred.count !== 1)
      throw new Error("Retry AI checkout transfer was lost.");
    return row;
  });
  return { mode: "rerun", jobId: job.id, revision: revision.revision };
}

async function repairMdxAndRerun() {
  const priorJob = await database.aiJob.findFirstOrThrow({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
  });
  if (priorJob.state !== "SUCCEEDED")
    throw new Error(`Prior review is not complete: ${priorJob.state}`);
  const draft = await database.draft.findUniqueOrThrow({
    where: { id: priorJob.draftId },
    include: {
      baseSnapshot: true,
      revisions: {
        orderBy: { revision: "desc" },
        take: 1,
        include: {
          artifacts: { include: { artifact: true, content: true } },
        },
      },
    },
  });
  const revision = draft.revisions[0];
  const artifact = revision?.artifacts.find(
    (item) =>
      item.artifact.logicalId === "situation:make-bad-attitude-specific",
  );
  if (!revision || !artifact)
    throw new Error("Validation MDX artifact is unavailable.");
  const checkout = await database.situationCheckout.findFirstOrThrow({
    where: {
      situationId: priorJob.situationId,
      holderUserId: priorJob.ownerId,
      custody: "USER",
      releasedAt: null,
    },
  });
  const body = artifact.content.body.replace(
    "<!-- Situation Studio isolated full-flow validation fixture. -->",
    "{/* Situation Studio isolated full-flow validation fixture. */}",
  );
  if (body === artifact.content.body)
    throw new Error("The invalid validation MDX marker was not found.");
  const saved = await saveDraft(database, {
    draftId: draft.id,
    checkoutId: checkout.id,
    userId: priorJob.ownerId,
    fencingToken: checkout.fencingToken,
    expectedRevision: draft.currentRevision,
    clientMutationId: randomUUID(),
    artifactId: artifact.artifactId,
    body,
  });
  if (!saved.ok) throw new Error("Repaired MDX draft could not be saved.");
  const repaired = await database.draftRevision.findUniqueOrThrow({
    where: {
      draftId_revision: { draftId: draft.id, revision: saved.revision },
    },
  });
  const job = await database.$transaction(async (transaction) => {
    const row = await transaction.aiJob.create({
      data: {
        kind: "FULL_REVIEW",
        ownerId: priorJob.ownerId,
        situationId: priorJob.situationId,
        draftId: draft.id,
        inputBundleHash: repaired.manifestHash,
        graphHash: sha256(JSON.stringify(draft.baseSnapshot.manifest)),
        workflowVersion: LEADERSHIP_REVIEW_WORKFLOW_VERSION,
        modelPolicyVersion: MODEL_POLICY.version,
        runNonce: randomUUID(),
        state: "QUEUED",
        stage: "Waiting for repaired-MDX complete review",
        idempotencyKey: `full-flow-validation-${randomUUID()}`,
      },
    });
    await transaction.draft.update({
      where: { id: draft.id },
      data: { state: "AI_REVIEW_QUEUED" },
    });
    const fenced = await transaction.situation.update({
      where: { id: priorJob.situationId },
      data: { fence: { increment: 1 } },
    });
    const transferred = await transaction.situationCheckout.updateMany({
      where: {
        id: checkout.id,
        custody: "USER",
        fencingToken: checkout.fencingToken,
        releasedAt: null,
      },
      data: {
        holderUserId: null,
        mode: "AI_QUEUED",
        custody: "AI_JOB",
        custodyReference: row.id,
        fencingToken: fenced.fence,
        transferReason: "FULL_FLOW_VALIDATION_MDX_REPAIR",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    if (transferred.count !== 1)
      throw new Error("Repaired-MDX AI checkout transfer was lost.");
    return row;
  });
  return {
    mode: "repair-mdx-and-rerun",
    jobId: job.id,
    revision: saved.revision,
    candidateHash: saved.contentHash,
  };
}

async function confirm() {
  const request = await database.publicationRequest.findFirstOrThrow({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
  });
  if (request.state !== "AWAITING_CONFIRMATION")
    throw new Error(
      `Publication is not awaiting confirmation: ${request.state}`,
    );
  const updated = await database.publicationRequest.update({
    where: { id: request.id },
    data: { finalConfirmedAt: request.finalConfirmedAt ?? new Date() },
  });
  return { mode: "confirm", requestId: updated.id, state: updated.state };
}

async function requestRollback() {
  const situation = await database.situation.findUniqueOrThrow({
    where: { slug: "make-bad-attitude-specific" },
  });
  if (!situation.currentPublicationId)
    throw new Error("Validation publication is unavailable for rollback.");
  const current = await database.publication.findUniqueOrThrow({
    where: { id: situation.currentPublicationId },
  });
  if (!current.previousPublicationId)
    throw new Error("Validation publication has no rollback target.");
  const existing = await database.rollbackRequest.findFirst({
    where: { situationId: situation.id },
    orderBy: { createdAt: "desc" },
  });
  if (existing)
    return {
      mode: "rollback",
      reused: true,
      rollbackRequestId: existing.id,
      state: existing.state,
    };
  const rollbackUuid = randomUUID();
  const request = await database.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT id FROM situations WHERE id = ${situation.id}::uuid FOR UPDATE`;
    const active = await transaction.situationCheckout.findFirst({
      where: { situationId: situation.id, releasedAt: null },
    });
    if (active) throw new Error("Validation situation remains checked out.");
    const fenced = await transaction.situation.update({
      where: { id: situation.id },
      data: { fence: { increment: 1 } },
    });
    const row = await transaction.rollbackRequest.create({
      data: {
        rollbackUuid,
        idempotencyKey: `full-flow-validation-${randomUUID()}`,
        targetEnvironment: "protected-beta",
        situationId: situation.id,
        targetPublicationId: current.previousPublicationId!,
        expectedCurrentPublicationId: current.id,
        requestedById: current.publishedById!,
        reason: "Isolated full-flow validation rollback.",
      },
    });
    const checkout = await transaction.situationCheckout.create({
      data: {
        situationId: situation.id,
        holderUserId: current.publishedById,
        mode: "PUBLISHING",
        custody: "PUBLISHER",
        custodyReference: row.id,
        fencingToken: fenced.fence,
        transferReason: "FULL_FLOW_VALIDATION_ROLLBACK",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    await transaction.checkoutResource.create({
      data: {
        checkoutId: checkout.id,
        situationId: situation.id,
        resourceKey: `situation:${situation.id}`,
        purpose: "ROLLBACK",
      },
    });
    return row;
  });
  return {
    mode: "rollback",
    reused: false,
    rollbackRequestId: request.id,
    state: request.state,
  };
}

async function report() {
  const job = await database.aiJob.findFirst({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
    include: {
      steps: { include: { selectedRun: true } },
      bundles: { include: { validations: true } },
    },
  });
  const request = await database.publicationRequest.findFirst({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
    include: { steps: true, publication: true },
  });
  const rollback = await database.rollbackRequest.findFirst({
    where: { idempotencyKey: { startsWith: "full-flow-validation-" } },
    orderBy: { createdAt: "desc" },
    include: { steps: true },
  });
  const rollbackPublication = rollback
    ? await database.publication.findUnique({
        where: { rollbackRequestId: rollback.id },
      })
    : null;
  return {
    mode: "report",
    job: job
      ? {
          id: job.id,
          state: job.state,
          stage: job.stage,
          successfulRoles: job.steps.filter(
            (step) => step.state === "SUCCEEDED",
          ).length,
          providers: [
            ...new Set(
              job.steps
                .map((step) => step.selectedRun?.requestedModel)
                .filter(Boolean),
            ),
          ],
          bundleState: job.bundles[0]?.state ?? null,
          validations:
            job.bundles[0]?.validations.map((item) => ({
              validator: item.validator,
              state: item.state,
            })) ?? [],
        }
      : null,
    publication: request
      ? {
          id: request.id,
          state: request.state,
          successfulSteps: request.steps.filter(
            (step) => step.state === "SUCCEEDED",
          ).length,
          commitSha: request.publication?.commitSha ?? null,
          releaseId: request.publication?.releaseId ?? null,
        }
      : null,
    rollback: rollback
      ? {
          id: rollback.id,
          state: rollback.state,
          successfulSteps: rollback.steps.filter(
            (step) => step.state === "SUCCEEDED",
          ).length,
          commitSha: rollbackPublication?.commitSha ?? null,
          releaseId: rollbackPublication?.releaseId ?? null,
        }
      : null,
  };
}

try {
  const result =
    mode === "seed"
      ? await seed()
      : mode === "approve-stage"
        ? await approveAndStage()
        : mode === "fix-and-rerun"
          ? await fixAndRerun()
          : mode === "repair-mdx-and-rerun"
            ? await repairMdxAndRerun()
            : mode === "rerun"
              ? await rerunCurrentRevision()
              : mode === "confirm"
                ? await confirm()
                : mode === "rollback"
                  ? await requestRollback()
                  : mode === "report"
                    ? await report()
                    : (() => {
                        throw new Error(
                          "Usage: full-flow-validation.ts seed|fix-and-rerun|repair-mdx-and-rerun|rerun|approve-stage|confirm|rollback|report",
                        );
                      })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await database.$disconnect();
}
