import { randomUUID } from "node:crypto";
import { Prisma, type DatabaseClient } from "@situation-studio/db";
import { sha256 } from "@situation-studio/domain";
import { RepositoryPublisher, type RepositoryRollback } from "./repository";

const rollbackSteps = [
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
type RollbackStepName = (typeof rollbackSteps)[number];

async function rollbackInput(database: DatabaseClient, requestId: string) {
  const request = await database.rollbackRequest.findUniqueOrThrow({
    where: { id: requestId },
  });
  if (
    !request.situationId ||
    !request.targetPublicationId ||
    !request.expectedCurrentPublicationId
  )
    throw new Error(
      "Database-native rollback requests are handled by the database materializer.",
    );
  const situationId = request.situationId;
  const targetPublicationId = request.targetPublicationId;
  const expectedCurrentPublicationId = request.expectedCurrentPublicationId;
  const [situation, target, current, result] = await Promise.all([
    database.situation.findUniqueOrThrow({
      where: { id: situationId },
    }),
    database.publication.findUniqueOrThrow({
      where: { id: targetPublicationId },
    }),
    database.publication.findUniqueOrThrow({
      where: { id: expectedCurrentPublicationId },
    }),
    database.publication.findUnique({
      where: { rollbackRequestId: request.id },
    }),
  ]);
  if (result && situation.currentPublicationId === result.id)
    return {
      request,
      rollback: {
        rollbackUuid: request.rollbackUuid,
        expectedHead: current.commitSha,
        targetCommit: target.commitSha,
        targetManifestHash: target.manifestHash,
      } satisfies RepositoryRollback,
      existingPublicationId: result.id,
    };
  if (
    situation.currentPublicationId !== current.id ||
    current.situationId !== situation.id ||
    target.situationId !== situation.id ||
    target.id === current.id ||
    ![
      "IMPORTED_BASELINE",
      "VERIFIED",
      "ROLLED_BACK_VERIFIED",
      "VERIFIED_FAKE_ACCEPTANCE",
    ].includes(target.healthState)
  )
    throw new Error("Rollback target or expected live publication changed.");
  return {
    request,
    rollback: {
      rollbackUuid: request.rollbackUuid,
      expectedHead: current.commitSha,
      targetCommit: target.commitSha,
      targetManifestHash: target.manifestHash,
    } satisfies RepositoryRollback,
    existingPublicationId: null,
  };
}

async function releaseFailedCheckout(
  database: DatabaseClient,
  requestId: string,
) {
  const checkout = await database.situationCheckout.findFirst({
    where: {
      custody: "PUBLISHER",
      custodyReference: requestId,
      releasedAt: null,
    },
  });
  if (!checkout) return;
  const now = new Date();
  await database.$transaction([
    database.situationCheckout.update({
      where: { id: checkout.id },
      data: { releasedAt: now, releaseReason: "ROLLBACK_PREVIEW_FAILED" },
    }),
    database.checkoutResource.updateMany({
      where: { checkoutId: checkout.id, releasedAt: null },
      data: { releasedAt: now },
    }),
  ]);
}

async function executeRollbackStep(
  database: DatabaseClient,
  requestId: string,
  step: RollbackStepName,
  inputHash: string,
  action: () => Promise<string>,
) {
  const existing = await database.rollbackStep.findUnique({
    where: { requestId_step_attempt: { requestId, step, attempt: 1 } },
  });
  if (existing?.state === "SUCCEEDED") return existing.externalId ?? "";
  const row = existing
    ? await database.rollbackStep.update({
        where: { id: existing.id },
        data: {
          state: "RUNNING",
          fence: { increment: 1 },
          inputHash,
          finishedAt: null,
        },
      })
    : await database.rollbackStep.create({
        data: {
          requestId,
          step,
          attempt: 1,
          fence: BigInt(rollbackSteps.indexOf(step) + 1),
          state: "RUNNING",
          inputHash,
        },
      });
  try {
    const externalId = await action();
    await database.$transaction([
      database.rollbackStep.update({
        where: { id: row.id },
        data: {
          state: "SUCCEEDED",
          externalId,
          outputHash: sha256(externalId),
          finishedAt: new Date(),
        },
      }),
      database.rollbackRequest.update({
        where: { id: requestId },
        data: {
          state: step,
          currentStep: step,
          errorClass: null,
          reconciliationReason: null,
        },
      }),
    ]);
    return externalId;
  } catch (error) {
    const afterCutover =
      rollbackSteps.indexOf(step) >= rollbackSteps.indexOf("CUTOVER");
    await database.$transaction([
      database.rollbackStep.update({
        where: { id: row.id },
        data: { state: "FAILED", finishedAt: new Date() },
      }),
      database.rollbackRequest.update({
        where: { id: requestId },
        data: {
          state: afterCutover ? "RECONCILIATION_REQUIRED" : "FAILED_PREVIEW",
          currentStep: step,
          errorClass: afterCutover
            ? "RECONCILIATION_REQUIRED"
            : "ROLLBACK_FAILURE",
          reconciliationReason:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown rollback failure",
        },
      }),
    ]);
    if (!afterCutover) await releaseFailedCheckout(database, requestId);
    throw error;
  }
}

async function reconcileRollback(
  database: DatabaseClient,
  requestId: string,
  commitSha: string,
  releasePath: string,
) {
  return database.$transaction(
    async (transaction) => {
      const request = await transaction.rollbackRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      if (
        !request.situationId ||
        !request.targetPublicationId ||
        !request.expectedCurrentPublicationId
      )
        throw new Error(
          "Database-native rollback requests are handled by the database materializer.",
        );
      const situationId = request.situationId;
      const targetPublicationId = request.targetPublicationId;
      const expectedCurrentPublicationId = request.expectedCurrentPublicationId;
      const existing = await transaction.publication.findUnique({
        where: { rollbackRequestId: request.id },
      });
      if (existing) return existing.id;
      const [current, target, situation] = await Promise.all([
        transaction.publication.findUniqueOrThrow({
          where: { id: expectedCurrentPublicationId },
        }),
        transaction.publication.findUniqueOrThrow({
          where: { id: targetPublicationId },
        }),
        transaction.situation.findUniqueOrThrow({
          where: { id: situationId },
        }),
      ]);
      if (situation.currentPublicationId !== current.id)
        throw new Error(
          "Live publication changed before rollback reconciliation.",
        );
      const publication = await transaction.publication.create({
        data: {
          situationId,
          rollbackRequestId: request.id,
          versionId: target.versionId,
          kind: "ROLLBACK",
          commitSha,
          manifestHash: target.manifestHash,
          releaseId: releasePath,
          previewReleaseId: releasePath,
          previousPublicationId: current.id,
          publishedById: request.requestedById,
          cutoverAt: new Date(),
          healthState: "ROLLED_BACK_VERIFIED",
        },
      });
      await transaction.situation.update({
        where: { id: situationId },
        data: {
          currentPublicationId: publication.id,
          publicationState: "ROLLED_BACK",
        },
      });
      const checkout = await transaction.situationCheckout.findFirst({
        where: {
          situationId,
          custody: "PUBLISHER",
          custodyReference: request.id,
          releasedAt: null,
        },
      });
      if (!checkout) throw new Error("Rollback publisher checkout was lost.");
      const now = new Date();
      await transaction.situationCheckout.update({
        where: { id: checkout.id },
        data: { releasedAt: now, releaseReason: "ROLLBACK_SUCCEEDED" },
      });
      await transaction.checkoutResource.updateMany({
        where: { checkoutId: checkout.id, releasedAt: null },
        data: { releasedAt: now },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "SERVICE",
          permissionSnapshot: [],
          action: "publication.rollback.reconcile",
          targetType: "publication",
          targetId: publication.id,
          targetVersion: target.manifestHash,
          correlationId: randomUUID(),
          outcome: "SUCCEEDED",
          reason: request.reason,
          afterMetadata: {
            targetPublicationId: target.id,
            rollbackCommit: commitSha,
            releaseId: releasePath,
          } as Prisma.InputJsonValue,
        },
      });
      return publication.id;
    },
    { isolationLevel: "Serializable" },
  );
}

export async function nextRollbackRequest(database: DatabaseClient) {
  const rows = await database.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM rollback_requests
    WHERE publication_target_id IS NULL
      AND state IN (
      'REQUESTED', 'WORKTREE_READY', 'APPLIED', 'VALIDATED', 'COMMITTED',
      'PUSHED', 'PREVIEW_BUILT', 'PREVIEW_VERIFIED', 'CUTOVER',
      'LIVE_VERIFIED', 'RECONCILIATION_REQUIRED'
    )
    ORDER BY created_at ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export async function processRollback(
  database: DatabaseClient,
  publisher: RepositoryPublisher,
  requestId: string,
) {
  const { rollback } = await rollbackInput(database, requestId);
  const input = (step: RollbackStepName, prior = "") =>
    sha256(
      `${rollback.expectedHead}:${rollback.targetCommit}:${rollback.rollbackUuid}:${step}:${prior}`,
    );
  await executeRollbackStep(
    database,
    requestId,
    "WORKTREE_READY",
    input("WORKTREE_READY"),
    () => publisher.prepareRollback(rollback),
  );
  await executeRollbackStep(
    database,
    requestId,
    "APPLIED",
    input("APPLIED"),
    async () => {
      await publisher.applyRollback(rollback);
      return rollback.targetCommit;
    },
  );
  await executeRollbackStep(
    database,
    requestId,
    "VALIDATED",
    input("VALIDATED"),
    async () => {
      await publisher.validateRollback(rollback);
      return rollback.targetManifestHash;
    },
  );
  const commitSha = await executeRollbackStep(
    database,
    requestId,
    "COMMITTED",
    input("COMMITTED"),
    () => publisher.commitRollback(rollback),
  );
  await executeRollbackStep(
    database,
    requestId,
    "PUSHED",
    input("PUSHED", commitSha),
    () => publisher.pushRollbackPreview(rollback, commitSha),
  );
  const releasePath = await executeRollbackStep(
    database,
    requestId,
    "PREVIEW_BUILT",
    input("PREVIEW_BUILT", commitSha),
    () => publisher.buildRollback(rollback, commitSha),
  );
  await executeRollbackStep(
    database,
    requestId,
    "PREVIEW_VERIFIED",
    input("PREVIEW_VERIFIED", `${commitSha}:${releasePath}`),
    async () => {
      await publisher.verifyRollbackPreview(rollback, commitSha, releasePath);
      return releasePath;
    },
  );
  await executeRollbackStep(
    database,
    requestId,
    "CUTOVER",
    input("CUTOVER", `${commitSha}:${releasePath}`),
    async () => {
      await publisher.cutoverRollback(rollback, commitSha, releasePath);
      return releasePath;
    },
  );
  await executeRollbackStep(
    database,
    requestId,
    "LIVE_VERIFIED",
    input("LIVE_VERIFIED", `${commitSha}:${releasePath}`),
    async () => {
      await publisher.verifyRollbackLive(rollback, commitSha, releasePath);
      return releasePath;
    },
  );
  const publicationId = await executeRollbackStep(
    database,
    requestId,
    "RECONCILED",
    input("RECONCILED", `${commitSha}:${releasePath}`),
    () => reconcileRollback(database, requestId, commitSha, releasePath),
  );
  return { state: "RECONCILED" as const, publicationId, commitSha };
}
