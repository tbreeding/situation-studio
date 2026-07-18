import { randomUUID } from "node:crypto";
import { Prisma, type DatabaseClient } from "@situation-studio/db";
import {
  canonicalBundleHash,
  sha256,
  type BundleManifest,
} from "@situation-studio/domain";
import { RepositoryPublisher, type RepositoryPublication } from "./repository";

const steps = [
  "WORKTREE_READY",
  "APPLIED",
  "VALIDATED",
  "COMMITTED",
  "PUSHED",
  "PREVIEW_BUILT",
  "PREVIEW_VERIFIED",
  "CUTOVER",
  "LIVE_VERIFIED",
  "RECONCILED",
] as const;

type Step = (typeof steps)[number];

function stateAfter(step: Step) {
  return step === "PREVIEW_VERIFIED" ? "AWAITING_CONFIRMATION" : step;
}

async function publicationInput(database: DatabaseClient, requestId: string) {
  const request = await database.publicationRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      approval: true,
      publication: true,
      bundle: {
        include: {
          draft: true,
          validations: true,
          comments: { where: { status: "OPEN", blocking: true } },
          artifacts: { include: { content: true } },
        },
      },
    },
  });
  const manifest = request.bundle.manifest as BundleManifest;
  if (
    request.targetEnvironment !== "protected-beta" ||
    request.bundleHash !== request.bundle.canonicalHash ||
    canonicalBundleHash(manifest) !== request.bundleHash ||
    request.baseCommit !== request.bundle.baseCommit ||
    request.approval.invalidatedAt ||
    request.approval.bundleHash !== request.bundleHash ||
    request.approval.baseCommit !== request.baseCommit ||
    (request.bundle.state !== "APPROVED" &&
      !(request.publication && request.bundle.state === "PUBLISHED")) ||
    request.bundle.comments.length ||
    !request.bundle.validations.length ||
    request.bundle.validations.some(
      (validation) =>
        validation.state !== "PASSED" ||
        validation.bundleHash !== request.bundleHash,
    )
  )
    throw new Error("Publication approval or bundle preconditions changed.");
  const publication: RepositoryPublication = {
    publicationUuid: request.publicationUuid,
    bundleHash: request.bundleHash,
    baseCommit: request.baseCommit,
    manifest,
    artifacts: request.bundle.artifacts.map((artifact) => ({
      path: artifact.path,
      body: artifact.changeKind === "DELETE" ? null : artifact.content.body,
    })),
  };
  return publication;
}

async function executeStep(
  database: DatabaseClient,
  requestId: string,
  step: Step,
  inputHash: string,
  action: () => Promise<string>,
) {
  const existing = await database.publicationStep.findUnique({
    where: { requestId_step_attempt: { requestId, step, attempt: 1 } },
  });
  if (existing?.state === "SUCCEEDED") return existing.externalId ?? "";
  const row = existing
    ? await database.publicationStep.update({
        where: { id: existing.id },
        data: {
          state: "RUNNING",
          fence: { increment: 1 },
          inputHash,
          finishedAt: null,
        },
      })
    : await database.publicationStep.create({
        data: {
          requestId,
          step,
          attempt: 1,
          fence: BigInt(steps.indexOf(step) + 1),
          state: "RUNNING",
          inputHash,
        },
      });
  try {
    const externalId = await action();
    await database.$transaction([
      database.publicationStep.update({
        where: { id: row.id },
        data: {
          state: "SUCCEEDED",
          externalId,
          outputHash: sha256(externalId),
          finishedAt: new Date(),
        },
      }),
      database.publicationRequest.update({
        where: { id: requestId },
        data: {
          state: stateAfter(step),
          currentStep: step,
          errorClass: null,
          reconciliationReason: null,
        },
      }),
    ]);
    return externalId;
  } catch (error) {
    const afterCutover = steps.indexOf(step) >= steps.indexOf("CUTOVER");
    await database.$transaction([
      database.publicationStep.update({
        where: { id: row.id },
        data: { state: "FAILED", finishedAt: new Date() },
      }),
      database.publicationRequest.update({
        where: { id: requestId },
        data: {
          state: afterCutover ? "RECONCILIATION_REQUIRED" : "FAILED_PREVIEW",
          currentStep: step,
          errorClass: afterCutover
            ? "RECONCILIATION_REQUIRED"
            : "PUBLISHER_FAILURE",
          reconciliationReason:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown publisher failure",
        },
      }),
    ]);
    if (!afterCutover) await returnPublisherCheckout(database, requestId);
    throw error;
  }
}

async function returnPublisherCheckout(
  database: DatabaseClient,
  requestId: string,
) {
  const request = await database.publicationRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { bundle: true },
  });
  await database.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT id FROM situations WHERE id = ${request.bundle.situationId}::uuid FOR UPDATE`;
    const situation = await transaction.situation.update({
      where: { id: request.bundle.situationId },
      data: { fence: { increment: 1 } },
    });
    const checkout = await transaction.situationCheckout.updateMany({
      where: {
        situationId: request.bundle.situationId,
        custody: "PUBLISHER",
        custodyReference: request.id,
        releasedAt: null,
      },
      data: {
        custody: "USER",
        custodyReference: null,
        mode: "APPROVED",
        fencingToken: situation.fence,
        transferReason: "PUBLICATION_PREVIEW_FAILED",
        renewedAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    if (checkout.count !== 1)
      throw new Error("Publisher checkout custody was lost before return.");
    await transaction.draft.update({
      where: { id: request.bundle.draftId },
      data: { state: "APPROVED" },
    });
  });
}

async function reconcile(
  database: DatabaseClient,
  requestId: string,
  commitSha: string,
  releasePath: string,
) {
  return database.$transaction(
    async (transaction) => {
      const request = await transaction.publicationRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: {
          publication: true,
          bundle: { include: { artifacts: true } },
        },
      });
      if (request.publication) return request.publication.id;
      const previous = await transaction.situation.findUniqueOrThrow({
        where: { id: request.bundle.situationId },
      });
      const version = await transaction.situationVersion.create({
        data: {
          situationId: request.bundle.situationId,
          sourceKind: "PUBLICATION",
          snapshotId: request.bundle.snapshotId,
          manifestHash: request.bundleHash,
          bundleHash: request.bundleHash,
          actorId: request.requestedById,
          aiJobId: request.bundle.aiJobId,
        },
      });
      for (const artifact of request.bundle.artifacts.filter(
        (item) => item.changeKind !== "DELETE",
      ))
        await transaction.versionArtifact.create({
          data: {
            versionId: version.id,
            artifactId: artifact.artifactId,
            path: artifact.path,
            type: artifact.type,
            contentHash: artifact.contentHash,
            changeKind: artifact.changeKind,
          },
        });
      const publication = await transaction.publication.create({
        data: {
          situationId: request.bundle.situationId,
          bundleId: request.bundle.id,
          requestId: request.id,
          versionId: version.id,
          kind: "STUDIO_PUBLICATION",
          commitSha,
          manifestHash: request.bundleHash,
          releaseId: releasePath,
          previewReleaseId: releasePath,
          previousPublicationId: previous.currentPublicationId,
          publishedById: request.requestedById,
          cutoverAt: new Date(),
          healthState: "VERIFIED",
        },
      });
      await transaction.situation.update({
        where: { id: request.bundle.situationId },
        data: {
          currentPublicationId: publication.id,
          publicationState: "PUBLISHED",
          lifecycle: "ACTIVE",
        },
      });
      await transaction.proposedBundle.update({
        where: { id: request.bundle.id },
        data: { state: "PUBLISHED" },
      });
      await transaction.draft.update({
        where: { id: request.bundle.draftId },
        data: { state: "PUBLISHED", active: false },
      });
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          situationId: request.bundle.situationId,
          custody: "PUBLISHER",
          custodyReference: request.id,
          releasedAt: null,
        },
      });
      if (checkout) {
        const now = new Date();
        await transaction.situationCheckout.update({
          where: { id: checkout.id },
          data: { releasedAt: now, releaseReason: "PUBLICATION_SUCCEEDED" },
        });
        await transaction.checkoutResource.updateMany({
          where: { checkoutId: checkout.id, releasedAt: null },
          data: { releasedAt: now },
        });
      }
      await transaction.auditEvent.create({
        data: {
          actorType: "SERVICE",
          permissionSnapshot: [],
          action: "publication.reconcile",
          targetType: "publication",
          targetId: publication.id,
          targetVersion: request.bundleHash,
          requestId: request.id,
          correlationId: randomUUID(),
          outcome: "SUCCEEDED",
          afterMetadata: {
            commitSha,
            releaseId: releasePath,
            requestedById: request.requestedById,
          } as Prisma.InputJsonValue,
        },
      });
      return publication.id;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function nextPublicationRequest(database: DatabaseClient) {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM publication_requests
    WHERE state IN (
      'REQUESTED', 'WORKTREE_READY', 'APPLIED', 'VALIDATED', 'COMMITTED',
      'PUSHED', 'PREVIEW_BUILT', 'PREVIEW_VERIFIED', 'CUTOVER',
      'LIVE_VERIFIED', 'RECONCILIATION_REQUIRED'
    ) OR (state = 'AWAITING_CONFIRMATION' AND final_confirmed_at IS NOT NULL)
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export async function processPublication(
  database: DatabaseClient,
  publisher: RepositoryPublisher,
  requestId: string,
) {
  const publication = await publicationInput(database, requestId);
  const input = (step: Step, prior = "") =>
    sha256(`${publication.bundleHash}:${step}:${prior}`);
  await executeStep(
    database,
    requestId,
    "WORKTREE_READY",
    input("WORKTREE_READY"),
    async () => {
      return publisher.prepareWorktree(publication);
    },
  );
  await executeStep(
    database,
    requestId,
    "APPLIED",
    input("APPLIED"),
    async () => {
      await publisher.apply(publication);
      return publication.bundleHash;
    },
  );
  await executeStep(
    database,
    requestId,
    "VALIDATED",
    input("VALIDATED"),
    async () => {
      await publisher.validate(publication);
      return publication.bundleHash;
    },
  );
  const commitSha = await executeStep(
    database,
    requestId,
    "COMMITTED",
    input("COMMITTED"),
    () => publisher.commit(publication),
  );
  await executeStep(
    database,
    requestId,
    "PUSHED",
    input("PUSHED", commitSha),
    () => publisher.pushPreview(publication, commitSha),
  );
  const releasePath = await executeStep(
    database,
    requestId,
    "PREVIEW_BUILT",
    input("PREVIEW_BUILT", commitSha),
    () => publisher.buildPreview(publication, commitSha),
  );
  await executeStep(
    database,
    requestId,
    "PREVIEW_VERIFIED",
    input("PREVIEW_VERIFIED", `${commitSha}:${releasePath}`),
    async () => {
      await publisher.verifyPreview(publication, commitSha, releasePath);
      return releasePath;
    },
  );
  const confirmation = await database.publicationRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: { finalConfirmedAt: true },
  });
  if (!confirmation.finalConfirmedAt)
    return { state: "AWAITING_CONFIRMATION" as const };
  await executeStep(
    database,
    requestId,
    "CUTOVER",
    input("CUTOVER", `${commitSha}:${releasePath}`),
    async () => {
      await publisher.cutover(publication, commitSha, releasePath);
      return releasePath;
    },
  );
  await executeStep(
    database,
    requestId,
    "LIVE_VERIFIED",
    input("LIVE_VERIFIED", `${commitSha}:${releasePath}`),
    async () => {
      await publisher.verifyLive(publication, commitSha, releasePath);
      return releasePath;
    },
  );
  const publicationId = await executeStep(
    database,
    requestId,
    "RECONCILED",
    input("RECONCILED", `${commitSha}:${releasePath}`),
    () => reconcile(database, requestId, commitSha, releasePath),
  );
  return { state: "RECONCILED" as const, publicationId, commitSha };
}
