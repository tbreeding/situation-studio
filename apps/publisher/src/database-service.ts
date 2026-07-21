import { randomUUID } from "node:crypto";
import {
  applyArtifactOverlay,
  buildCanonicalSnapshot,
  canonicalArtifactBytes,
  classifyArtifactPath,
  logicalIdForArtifact,
  mediaTypeForPath,
  sha256,
  snapshotManifestSchema,
  validateCanonicalSnapshot,
  validationPolicyHash,
  type ArtifactOverlay,
  type SnapshotArtifact,
} from "@situation-studio/content-contracts";
import { Prisma, type DatabaseClient } from "@situation-studio/db";

const targetCode = "leadership-production";

export type DatabasePublicationResult = {
  requestId: string;
  publicationId: string | null;
  state: string;
  snapshotId: string | null;
  snapshotHash: string | null;
};

function bytesForBlob(blob: {
  encoding: "UTF8" | "BINARY";
  body: string;
  binaryBody: Uint8Array | null;
}) {
  if (blob.encoding === "BINARY") {
    if (!blob.binaryBody)
      throw new Error("Binary content blob is missing bytes.");
    return new Uint8Array(blob.binaryBody);
  }
  return new TextEncoder().encode(blob.body);
}

async function appendEvent(
  database: DatabaseClient | Prisma.TransactionClient,
  requestId: string,
  targetId: string,
  eventKey: string,
  eventType: string,
  payload: Prisma.InputJsonValue,
) {
  await database.$queryRaw`
    SELECT * FROM append_publication_event(
      ${requestId}::uuid, NULL, ${targetId}::uuid,
      ${eventKey}, ${eventType}, ${payload}::jsonb
    )
  `;
}

async function appendRollbackEvent(
  database: DatabaseClient | Prisma.TransactionClient,
  rollbackRequestId: string,
  targetId: string,
  eventKey: string,
  eventType: string,
  payload: Prisma.InputJsonValue,
) {
  await database.$queryRaw`
    SELECT * FROM append_publication_event(
      NULL, ${rollbackRequestId}::uuid, ${targetId}::uuid,
      ${eventKey}, ${eventType}, ${payload}::jsonb
    )
  `;
}

async function releasePublisherCheckout(
  database: Prisma.TransactionClient,
  custodyReference: string,
  releaseReason: string,
) {
  const checkout = await database.situationCheckout.findFirst({
    where: {
      custody: "PUBLISHER",
      custodyReference,
      releasedAt: null,
    },
  });
  if (!checkout) return;
  const releasedAt = new Date();
  await database.situationCheckout.update({
    where: { id: checkout.id },
    data: { releasedAt, releaseReason },
  });
  await database.checkoutResource.updateMany({
    where: { checkoutId: checkout.id, releasedAt: null },
    data: { releasedAt },
  });
}

async function ensurePublication(database: DatabaseClient, requestId: string) {
  const existing = await database.databasePublication.findUnique({
    where: { publicationRequestId: requestId },
  });
  if (existing) return existing;
  const request = await database.publicationRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { approval: true, publicationTarget: true },
  });
  const target = request.publicationTarget;
  if (
    !target ||
    target.code !== targetCode ||
    !target.officialSnapshotId ||
    !target.bootstrappedAt ||
    request.targetGeneration !== target.generation ||
    request.baseContentSnapshotId !== target.officialSnapshotId ||
    request.baseContentSnapshotHash !==
      request.approval.baseContentSnapshotHash ||
    request.approval.baseContentSnapshotId !== target.officialSnapshotId ||
    request.approval.validationPolicyHash !== validationPolicyHash ||
    request.approval.invalidatedAt
  )
    throw new Error(
      "Database publication request is not bound to the official base.",
    );
  try {
    return await database.databasePublication.create({
      data: {
        publicationUuid: request.publicationUuid,
        publicationRequestId: request.id,
        targetId: target.id,
        bundleId: request.bundleId,
        approvalId: request.approvalId,
        previousOfficialSnapshotId: target.officialSnapshotId,
        publisherIdentityId: request.requestedById,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      return database.databasePublication.findUniqueOrThrow({
        where: { publicationRequestId: request.id },
      });
    throw error;
  }
}

async function materializeSnapshot(
  database: DatabaseClient,
  requestId: string,
  publicationId: string,
) {
  const request = await database.publicationRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      approval: true,
      publicationTarget: true,
      bundle: {
        include: {
          artifacts: { include: { artifact: true, content: true } },
        },
      },
      baseContentSnapshot: {
        include: {
          artifacts: { include: { artifact: true, content: true } },
        },
      },
    },
  });
  const base = request.baseContentSnapshot;
  const target = request.publicationTarget;
  if (
    !base ||
    !target ||
    target.officialSnapshotId !== base.id ||
    request.baseContentSnapshotHash !== base.manifestHash ||
    request.bundle.canonicalHash !== request.bundleHash ||
    request.approval.bundleHash !== request.bundleHash ||
    request.approval.baseContentSnapshotId !== base.id ||
    request.approval.baseContentSnapshotHash !== base.manifestHash ||
    request.targetGeneration !== target.generation ||
    request.bundle.state !== "APPROVED"
  )
    throw new Error("Candidate materialization preconditions changed.");

  const baseManifest = snapshotManifestSchema.parse(JSON.parse(base.manifest));
  const bodies = new Map<string, Uint8Array>();
  const artifactIds = new Map<string, string>();
  for (const member of base.artifacts) {
    bodies.set(member.contentHash, bytesForBlob(member.content));
    artifactIds.set(member.logicalId, member.artifactId);
  }
  const overlay: ArtifactOverlay[] = [];
  for (const member of request.bundle.artifacts) {
    const logicalId = member.artifact.logicalId;
    artifactIds.set(logicalId, member.artifactId);
    if (member.changeKind === "DELETE") {
      overlay.push({ logicalId, changeKind: "DELETE" });
      continue;
    }
    const canonical = canonicalArtifactBytes(
      member.path,
      new TextEncoder().encode(member.content.body),
    );
    const contentHash = sha256(canonical.bytes);
    if (contentHash !== member.contentHash)
      throw new Error(`Bundle content is not canonical for ${member.path}.`);
    bodies.set(contentHash, canonical.bytes);
    const derivedLogicalId = logicalIdForArtifact(member.path, canonical.bytes);
    if (derivedLogicalId !== logicalId)
      throw new Error(`Bundle logical identity changed for ${member.path}.`);
    const artifact: SnapshotArtifact = {
      logicalId,
      type: classifyArtifactPath(member.path),
      path: member.path,
      contentHash,
      byteLength: canonical.bytes.byteLength,
      encoding: canonical.encoding,
      mediaType: mediaTypeForPath(member.path),
    };
    overlay.push({
      logicalId,
      changeKind: member.changeKind,
      artifact,
    });
  }
  const artifacts = applyArtifactOverlay(baseManifest.artifacts, overlay);
  const activeHashes = new Set(
    artifacts.map((artifact) => artifact.contentHash),
  );
  for (const hash of bodies.keys())
    if (!activeHashes.has(hash)) bodies.delete(hash);
  const built = await buildCanonicalSnapshot(
    baseManifest.source,
    artifacts,
    bodies,
  );

  return database.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${target.id}::uuid FOR UPDATE
      `;
      const locked = await transaction.publicationTarget.findUniqueOrThrow({
        where: { id: target.id },
      });
      if (
        locked.officialSnapshotId !== base.id ||
        locked.candidateSnapshotId !== null
      )
        throw new Error("Publication target is no longer available.");
      const snapshot = await transaction.contentSnapshot.create({
        data: {
          parentSnapshotId: base.id,
          manifest: built.manifestBody,
          manifestHash: built.manifestHash,
          sourceBundleId: request.bundleId,
          validationPolicyHash,
          artifactCount: artifacts.length,
          totalByteLength: BigInt(
            artifacts.reduce(
              (total, artifact) => total + artifact.byteLength,
              0,
            ),
          ),
        },
      });
      for (const artifact of artifacts) {
        const artifactId = artifactIds.get(artifact.logicalId);
        if (!artifactId)
          throw new Error(
            `Artifact identity is missing for ${artifact.logicalId}.`,
          );
        await transaction.contentSnapshotArtifact.create({
          data: {
            snapshotId: snapshot.id,
            artifactId,
            logicalId: artifact.logicalId,
            canonicalPath: artifact.path,
            artifactType: artifact.type,
            contentHash: artifact.contentHash,
            byteLength: artifact.byteLength,
          },
        });
      }
      for (const edge of built.manifest.edges) {
        const sourceArtifactId = artifactIds.get(edge.source);
        const targetArtifactId = artifactIds.get(edge.target);
        if (!sourceArtifactId || !targetArtifactId)
          throw new Error(`Graph identity is missing for ${edge.source}.`);
        await transaction.contentSnapshotEdge.create({
          data: {
            snapshotId: snapshot.id,
            sourceArtifactId,
            targetArtifactId,
            edgeType: edge.type,
            evidence: edge.evidence,
          },
        });
      }
      await transaction.databasePublication.update({
        where: { id: publicationId },
        data: {
          candidateSnapshotId: snapshot.id,
          state: "SNAPSHOT_MATERIALIZED",
        },
      });
      await transaction.publicationRequest.update({
        where: { id: request.id },
        data: {
          candidateContentSnapshotId: snapshot.id,
          candidateContentSnapshotHash: snapshot.manifestHash,
          state: "SNAPSHOT_MATERIALIZED",
          currentStep: "SNAPSHOT_MATERIALIZED",
        },
      });
      await appendEvent(
        transaction,
        request.id,
        target.id,
        "snapshot.materialized",
        "SNAPSHOT_MATERIALIZED",
        {
          snapshotId: snapshot.id,
          snapshotHash: snapshot.manifestHash,
          artifactCount: artifacts.length,
        },
      );
      return snapshot;
    },
    { isolationLevel: "Serializable" },
  );
}

async function validateSnapshot(
  database: DatabaseClient,
  requestId: string,
  publicationId: string,
  snapshotId: string,
) {
  const snapshot = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: snapshotId },
    include: { artifacts: { include: { content: true } } },
  });
  const bodies = new Map(
    snapshot.artifacts.map((artifact) => [
      artifact.contentHash,
      bytesForBlob(artifact.content),
    ]),
  );
  await validateCanonicalSnapshot(snapshot.manifest, bodies);
  await database.$transaction(async (transaction) => {
    await transaction.contentSnapshot.update({
      where: { id: snapshot.id },
      data: { validationState: "VALIDATED", verifiedAt: new Date() },
    });
    await transaction.databasePublication.update({
      where: { id: publicationId },
      data: { state: "SNAPSHOT_VALIDATED" },
    });
    const request = await transaction.publicationRequest.update({
      where: { id: requestId },
      data: {
        state: "SNAPSHOT_VALIDATED",
        currentStep: "SNAPSHOT_VALIDATED",
      },
    });
    await appendEvent(
      transaction,
      requestId,
      request.publicationTargetId as string,
      "snapshot.validated",
      "SNAPSHOT_VALIDATED",
      { snapshotId, snapshotHash: snapshot.manifestHash },
    );
  });
}

async function makeCandidateAvailable(
  database: DatabaseClient,
  requestId: string,
  publicationId: string,
  snapshotId: string,
) {
  return database.$transaction(
    async (transaction) => {
      const request = await transaction.publicationRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const targetId = request.publicationTargetId as string;
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${targetId}::uuid FOR UPDATE
      `;
      const target = await transaction.publicationTarget.findUniqueOrThrow({
        where: { id: targetId },
      });
      if (target.candidateSnapshotId) {
        await transaction.databasePublication.update({
          where: { id: publicationId },
          data: {
            state: "FAILED_PREVIEW",
            terminalOutcome: "FAILED_BEFORE_CONFIRMATION",
          },
        });
        await transaction.publicationRequest.update({
          where: { id: requestId },
          data: {
            state: "FAILED_PREVIEW",
            currentStep: "CANDIDATE_AVAILABLE",
            errorClass: "TARGET_CANDIDATE_BUSY",
            reconciliationReason:
              "Another publication owns the candidate pointer.",
          },
        });
        await releasePublisherCheckout(
          transaction,
          requestId,
          "DATABASE_PUBLICATION_TARGET_BUSY",
        );
        await appendEvent(
          transaction,
          requestId,
          target.id,
          "candidate.rejected-busy",
          "CANDIDATE_REJECTED_BUSY",
          { activeCandidateSnapshotId: target.candidateSnapshotId },
        );
        return false;
      }
      await transaction.databasePublication.update({
        where: { id: publicationId },
        data: { state: "CANDIDATE_AVAILABLE" },
      });
      await transaction.publicationTarget.update({
        where: { id: target.id },
        data: {
          candidateSnapshotId: snapshotId,
          candidatePublicationRequestId: requestId,
          currentDatabasePublicationId: publicationId,
          generation: { increment: 1 },
        },
      });
      await transaction.publicationRequest.update({
        where: { id: requestId },
        data: {
          state: "CANDIDATE_AVAILABLE",
          currentStep: "CANDIDATE_AVAILABLE",
        },
      });
      await appendEvent(
        transaction,
        requestId,
        target.id,
        "candidate.available",
        "CANDIDATE_AVAILABLE",
        { snapshotId },
      );
      return true;
    },
    { isolationLevel: "Serializable" },
  );
}

async function advanceObservedCandidate(
  database: DatabaseClient,
  requestId: string,
  publicationId: string,
  snapshotId: string,
) {
  const receipt = await database.leadershipObservationReceipt.findFirst({
    where: {
      databasePublicationId: publicationId,
      snapshotId,
      observationKind: "CANDIDATE",
      healthResult: "HEALTHY",
    },
    orderBy: { observedAt: "desc" },
  });
  if (!receipt) return false;
  await database.$transaction(async (transaction) => {
    const request = await transaction.publicationRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    await transaction.databasePublication.update({
      where: { id: publicationId },
      data: { state: "CANDIDATE_VERIFIED" },
    });
    await transaction.databasePublication.update({
      where: { id: publicationId },
      data: { state: "AWAITING_CONFIRMATION" },
    });
    await transaction.publicationRequest.update({
      where: { id: requestId },
      data: {
        state: "AWAITING_CONFIRMATION",
        currentStep: "AWAITING_CONFIRMATION",
      },
    });
    await appendEvent(
      transaction,
      requestId,
      request.publicationTargetId as string,
      "candidate.verified",
      "CANDIDATE_VERIFIED",
      { snapshotId, receiptId: receipt.id },
    );
  });
  return true;
}

async function commitOfficialPointer(
  database: DatabaseClient,
  requestId: string,
  publicationId: string,
  snapshotId: string,
) {
  const confirmation = await database.publicationConfirmation.findUnique({
    where: { publicationRequestId: requestId },
  });
  if (!confirmation) return false;
  await database.$transaction(
    async (transaction) => {
      const request = await transaction.publicationRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const targetId = request.publicationTargetId as string;
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${targetId}::uuid FOR UPDATE
      `;
      const target = await transaction.publicationTarget.findUniqueOrThrow({
        where: { id: targetId },
      });
      if (
        target.candidateSnapshotId !== snapshotId ||
        confirmation.targetGeneration !== target.generation
      )
        throw new Error("Confirmation no longer matches the active candidate.");
      await transaction.databasePublication.update({
        where: { id: publicationId },
        data: {
          confirmationId: confirmation.id,
          resultingOfficialSnapshotId: snapshotId,
          state: "OFFICIAL_POINTER_COMMITTED",
        },
      });
      await transaction.publicationTarget.update({
        where: { id: target.id },
        data: {
          officialSnapshotId: snapshotId,
          candidateSnapshotId: null,
          candidatePublicationRequestId: null,
          generation: { increment: 1 },
        },
      });
      await transaction.publicationRequest.update({
        where: { id: requestId },
        data: {
          finalConfirmedAt: confirmation.confirmedAt,
          state: "OFFICIAL_POINTER_COMMITTED",
          currentStep: "OFFICIAL_POINTER_COMMITTED",
        },
      });
      await appendEvent(
        transaction,
        requestId,
        target.id,
        "official.committed",
        "OFFICIAL_POINTER_COMMITTED",
        { snapshotId, confirmationId: confirmation.id },
      );
    },
    { isolationLevel: "Serializable" },
  );
  return true;
}

async function reconcileLive(
  database: DatabaseClient,
  requestId: string,
  publicationId: string,
  snapshotId: string,
) {
  const receipt = await database.leadershipObservationReceipt.findFirst({
    where: {
      databasePublicationId: publicationId,
      snapshotId,
      observationKind: "OFFICIAL",
      healthResult: "HEALTHY",
    },
    orderBy: { observedAt: "desc" },
  });
  if (!receipt) return false;
  await database.$transaction(async (transaction) => {
    const request = await transaction.publicationRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    await transaction.databasePublication.update({
      where: { id: publicationId },
      data: { healthReceiptId: receipt.id, state: "LIVE_VERIFIED" },
    });
    await transaction.databasePublication.update({
      where: { id: publicationId },
      data: { state: "RECONCILED", terminalOutcome: "PUBLISHED" },
    });
    await transaction.publicationRequest.update({
      where: { id: requestId },
      data: { state: "RECONCILED", currentStep: "RECONCILED" },
    });
    await transaction.proposedBundle.update({
      where: { id: request.bundleId },
      data: { state: "PUBLISHED" },
    });
    const bundle = await transaction.proposedBundle.findUniqueOrThrow({
      where: { id: request.bundleId },
    });
    await transaction.draft.update({
      where: { id: bundle.draftId },
      data: { state: "PUBLISHED", active: false },
    });
    const checkout = await transaction.situationCheckout.findFirst({
      where: {
        situationId: bundle.situationId,
        custody: "PUBLISHER",
        custodyReference: requestId,
        releasedAt: null,
      },
    });
    if (checkout) {
      const releasedAt = new Date();
      await transaction.situationCheckout.update({
        where: { id: checkout.id },
        data: { releasedAt, releaseReason: "DATABASE_PUBLICATION_SUCCEEDED" },
      });
      await transaction.checkoutResource.updateMany({
        where: { checkoutId: checkout.id, releasedAt: null },
        data: { releasedAt },
      });
    }
    await appendEvent(
      transaction,
      requestId,
      request.publicationTargetId as string,
      "publication.reconciled",
      "PUBLICATION_RECONCILED",
      { snapshotId, receiptId: receipt.id },
    );
  });
  return true;
}

async function finishAutomaticRestoration(
  database: DatabaseClient,
  requestId: string,
  publicationId: string,
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { id: publicationId },
  });
  const receipt = await database.leadershipObservationReceipt.findFirst({
    where: {
      databasePublicationId: publicationId,
      snapshotId: publication.previousOfficialSnapshotId,
      observationKind: "RESTORATION",
      healthResult: "HEALTHY",
    },
    orderBy: { observedAt: "desc" },
  });
  if (!receipt) return false;
  await database.$transaction(async (transaction) => {
    const request = await transaction.publicationRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    await transaction.databasePublication.update({
      where: { id: publicationId },
      data: {
        healthReceiptId: receipt.id,
        state: "AUTO_ROLLED_BACK",
        terminalOutcome: "PREVIOUS_VERSION_RESTORED",
      },
    });
    await transaction.publicationRequest.update({
      where: { id: requestId },
      data: {
        state: "AUTO_ROLLED_BACK",
        currentStep: "AUTO_ROLLED_BACK",
        errorClass: "LIVE_VERIFICATION_FAILED",
        reconciliationReason:
          "The previous official snapshot was restored and verified.",
      },
    });
    await releasePublisherCheckout(
      transaction,
      requestId,
      "DATABASE_PUBLICATION_AUTO_ROLLED_BACK",
    );
    await appendEvent(
      transaction,
      requestId,
      request.publicationTargetId as string,
      "publication.auto-rolled-back",
      "PUBLICATION_AUTO_ROLLED_BACK",
      {
        restoredSnapshotId: publication.previousOfficialSnapshotId,
        receiptId: receipt.id,
      },
    );
  });
  return true;
}

export async function beginAutomaticRestoration(
  database: DatabaseClient,
  requestId: string,
  reason: string,
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { publicationRequestId: requestId },
  });
  if (
    publication.state === "RESTORING_PREVIOUS" ||
    publication.state === "AUTO_ROLLED_BACK"
  )
    return publication;
  if (
    publication.state !== "OFFICIAL_POINTER_COMMITTED" &&
    publication.state !== "LIVE_VERIFIED"
  )
    throw new Error(`Cannot restore from ${publication.state}.`);
  await database.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${publication.targetId}::uuid FOR UPDATE
      `;
      const target = await transaction.publicationTarget.findUniqueOrThrow({
        where: { id: publication.targetId },
      });
      if (target.officialSnapshotId !== publication.candidateSnapshotId)
        throw new Error(
          "The official pointer no longer matches the failed publication.",
        );
      await transaction.databasePublication.update({
        where: { id: publication.id },
        data: { state: "RESTORING_PREVIOUS" },
      });
      await transaction.publicationTarget.update({
        where: { id: target.id },
        data: {
          officialSnapshotId: publication.previousOfficialSnapshotId,
          generation: { increment: 1 },
        },
      });
      await transaction.candidateAuthorization.updateMany({
        where: { publicationRequestId: requestId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.publicationRequest.update({
        where: { id: requestId },
        data: {
          state: "RESTORING_PREVIOUS",
          currentStep: "RESTORING_PREVIOUS",
          errorClass: "LIVE_VERIFICATION_FAILED",
          reconciliationReason: reason.slice(0, 500),
        },
      });
      await appendEvent(
        transaction,
        requestId,
        target.id,
        "publication.restoring-previous",
        "PUBLICATION_RESTORING_PREVIOUS",
        { previousSnapshotId: publication.previousOfficialSnapshotId, reason },
      );
    },
    { isolationLevel: "Serializable" },
  );
  return database.databasePublication.findUniqueOrThrow({
    where: { id: publication.id },
  });
}

export async function markPublicationReconciliationRequired(
  database: DatabaseClient,
  requestId: string,
  reason: string,
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { publicationRequestId: requestId },
  });
  if (publication.state === "RECONCILIATION_REQUIRED") return publication;
  if (
    ![
      "OFFICIAL_POINTER_COMMITTED",
      "LIVE_VERIFIED",
      "RESTORING_PREVIOUS",
    ].includes(publication.state)
  )
    throw new Error(
      `Cannot require publication reconciliation from ${publication.state}.`,
    );
  await database.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${publication.targetId}::uuid FOR UPDATE
      `;
      await transaction.databasePublication.update({
        where: { id: publication.id },
        data: {
          state: "RECONCILIATION_REQUIRED",
          terminalOutcome: "RECONCILIATION_REQUIRED",
        },
      });
      await transaction.candidateAuthorization.updateMany({
        where: { publicationRequestId: requestId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.publicationRequest.update({
        where: { id: requestId },
        data: {
          state: "RECONCILIATION_REQUIRED",
          currentStep: "RECONCILIATION_REQUIRED",
          errorClass: "AUTOMATIC_RESTORATION_FAILED",
          reconciliationReason: reason.slice(0, 500),
        },
      });
      await appendEvent(
        transaction,
        requestId,
        publication.targetId,
        "publication.reconciliation-required",
        "PUBLICATION_RECONCILIATION_REQUIRED",
        { reason },
      );
    },
    { isolationLevel: "Serializable" },
  );
  return database.databasePublication.findUniqueOrThrow({
    where: { id: publication.id },
  });
}

async function finishAutomaticRollbackRestoration(
  database: DatabaseClient,
  rollbackRequestId: string,
  publicationId: string,
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { id: publicationId },
  });
  const receipt = await database.leadershipObservationReceipt.findFirst({
    where: {
      databasePublicationId: publicationId,
      snapshotId: publication.previousOfficialSnapshotId,
      observationKind: "RESTORATION",
      healthResult: "HEALTHY",
    },
    orderBy: { observedAt: "desc" },
  });
  if (!receipt) return false;
  await database.$transaction(async (transaction) => {
    const request = await transaction.rollbackRequest.findUniqueOrThrow({
      where: { id: rollbackRequestId },
    });
    await transaction.databasePublication.update({
      where: { id: publicationId },
      data: {
        healthReceiptId: receipt.id,
        state: "AUTO_ROLLED_BACK",
        terminalOutcome: "PREVIOUS_VERSION_RESTORED",
      },
    });
    await transaction.rollbackRequest.update({
      where: { id: rollbackRequestId },
      data: {
        state: "AUTO_ROLLED_BACK",
        currentStep: "AUTO_ROLLED_BACK",
        errorClass: "LIVE_VERIFICATION_FAILED",
        reconciliationReason:
          "The pre-rollback official snapshot was restored and verified.",
      },
    });
    await appendRollbackEvent(
      transaction,
      rollbackRequestId,
      request.publicationTargetId as string,
      "rollback.auto-restored-current",
      "ROLLBACK_AUTO_RESTORED_CURRENT",
      {
        restoredSnapshotId: publication.previousOfficialSnapshotId,
        receiptId: receipt.id,
      },
    );
  });
  return true;
}

export async function beginAutomaticRollbackRestoration(
  database: DatabaseClient,
  rollbackRequestId: string,
  reason: string,
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { rollbackRequestId },
  });
  if (
    publication.state === "RESTORING_PREVIOUS" ||
    publication.state === "AUTO_ROLLED_BACK"
  )
    return publication;
  if (
    publication.state !== "OFFICIAL_POINTER_COMMITTED" &&
    publication.state !== "LIVE_VERIFIED"
  )
    throw new Error(`Cannot restore rollback from ${publication.state}.`);
  await database.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${publication.targetId}::uuid FOR UPDATE
      `;
      const target = await transaction.publicationTarget.findUniqueOrThrow({
        where: { id: publication.targetId },
      });
      if (target.officialSnapshotId !== publication.candidateSnapshotId)
        throw new Error(
          "The official pointer no longer matches the failed rollback.",
        );
      await transaction.databasePublication.update({
        where: { id: publication.id },
        data: { state: "RESTORING_PREVIOUS" },
      });
      await transaction.publicationTarget.update({
        where: { id: target.id },
        data: {
          officialSnapshotId: publication.previousOfficialSnapshotId,
          generation: { increment: 1 },
        },
      });
      await transaction.candidateAuthorization.updateMany({
        where: { rollbackRequestId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.rollbackRequest.update({
        where: { id: rollbackRequestId },
        data: {
          state: "RESTORING_PREVIOUS",
          currentStep: "RESTORING_PREVIOUS",
          errorClass: "LIVE_VERIFICATION_FAILED",
          reconciliationReason: reason.slice(0, 500),
        },
      });
      await appendRollbackEvent(
        transaction,
        rollbackRequestId,
        target.id,
        "rollback.restoring-current",
        "ROLLBACK_RESTORING_CURRENT",
        { previousSnapshotId: publication.previousOfficialSnapshotId, reason },
      );
    },
    { isolationLevel: "Serializable" },
  );
  return database.databasePublication.findUniqueOrThrow({
    where: { id: publication.id },
  });
}

export async function markRollbackReconciliationRequired(
  database: DatabaseClient,
  rollbackRequestId: string,
  reason: string,
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { rollbackRequestId },
  });
  if (publication.state === "RECONCILIATION_REQUIRED") return publication;
  if (
    ![
      "OFFICIAL_POINTER_COMMITTED",
      "LIVE_VERIFIED",
      "RESTORING_PREVIOUS",
    ].includes(publication.state)
  )
    throw new Error(
      `Cannot require rollback reconciliation from ${publication.state}.`,
    );
  await database.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${publication.targetId}::uuid FOR UPDATE
      `;
      await transaction.databasePublication.update({
        where: { id: publication.id },
        data: {
          state: "RECONCILIATION_REQUIRED",
          terminalOutcome: "RECONCILIATION_REQUIRED",
        },
      });
      await transaction.candidateAuthorization.updateMany({
        where: { rollbackRequestId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.rollbackRequest.update({
        where: { id: rollbackRequestId },
        data: {
          state: "RECONCILIATION_REQUIRED",
          currentStep: "RECONCILIATION_REQUIRED",
          errorClass: "AUTOMATIC_RESTORATION_FAILED",
          reconciliationReason: reason.slice(0, 500),
        },
      });
      await appendRollbackEvent(
        transaction,
        rollbackRequestId,
        publication.targetId,
        "rollback.reconciliation-required",
        "ROLLBACK_RECONCILIATION_REQUIRED",
        { reason },
      );
    },
    { isolationLevel: "Serializable" },
  );
  return database.databasePublication.findUniqueOrThrow({
    where: { id: publication.id },
  });
}

export async function processDatabasePublication(
  database: DatabaseClient,
  requestId: string,
  options: { stopAfterState?: string } = {},
): Promise<DatabasePublicationResult> {
  const publication = await ensurePublication(database, requestId);
  let current = publication;
  if (current.state === options.stopAfterState) {
    const request = await database.publicationRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    return {
      requestId,
      publicationId: current.id,
      state: current.state,
      snapshotId: current.candidateSnapshotId,
      snapshotHash: request.candidateContentSnapshotHash,
    };
  }
  for (let transitions = 0; transitions < 8; transitions += 1) {
    try {
      if (current.state === "REQUESTED")
        await materializeSnapshot(database, requestId, current.id);
      else if (current.state === "SNAPSHOT_MATERIALIZED")
        await validateSnapshot(
          database,
          requestId,
          current.id,
          current.candidateSnapshotId as string,
        );
      else if (current.state === "SNAPSHOT_VALIDATED") {
        const available = await makeCandidateAvailable(
          database,
          requestId,
          current.id,
          current.candidateSnapshotId as string,
        );
        if (!available) break;
      } else if (current.state === "CANDIDATE_AVAILABLE") {
        if (
          !(await advanceObservedCandidate(
            database,
            requestId,
            current.id,
            current.candidateSnapshotId as string,
          ))
        )
          break;
      } else if (current.state === "AWAITING_CONFIRMATION") {
        if (
          !(await commitOfficialPointer(
            database,
            requestId,
            current.id,
            current.candidateSnapshotId as string,
          ))
        )
          break;
      } else if (current.state === "OFFICIAL_POINTER_COMMITTED") {
        if (
          !(await reconcileLive(
            database,
            requestId,
            current.id,
            current.candidateSnapshotId as string,
          ))
        )
          break;
      } else if (current.state === "RESTORING_PREVIOUS") {
        if (
          !(await finishAutomaticRestoration(database, requestId, current.id))
        )
          break;
      } else break;
    } catch (error) {
      if (
        [
          "REQUESTED",
          "SNAPSHOT_MATERIALIZED",
          "SNAPSHOT_VALIDATED",
          "CANDIDATE_AVAILABLE",
          "CANDIDATE_VERIFIED",
          "AWAITING_CONFIRMATION",
        ].includes(current.state)
      ) {
        await failDatabasePublicationBeforeConfirmation(
          database,
          requestId,
          error instanceof Error
            ? error.message
            : "Database publication failed.",
        );
        current = await database.databasePublication.findUniqueOrThrow({
          where: { id: current.id },
        });
        break;
      }
      throw error;
    }
    current = await database.databasePublication.findUniqueOrThrow({
      where: { id: current.id },
    });
    if (current.state === options.stopAfterState) break;
  }
  const request = await database.publicationRequest.findUniqueOrThrow({
    where: { id: requestId },
  });
  return {
    requestId,
    publicationId: current.id,
    state: current.state,
    snapshotId: current.candidateSnapshotId,
    snapshotHash: request.candidateContentSnapshotHash,
  };
}

export async function failDatabasePublicationBeforeConfirmation(
  database: DatabaseClient,
  requestId: string,
  reason: string,
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { publicationRequestId: requestId },
  });
  if (publication.state === "FAILED_PREVIEW") return publication;
  if (
    ![
      "REQUESTED",
      "SNAPSHOT_MATERIALIZED",
      "SNAPSHOT_VALIDATED",
      "CANDIDATE_AVAILABLE",
      "CANDIDATE_VERIFIED",
      "AWAITING_CONFIRMATION",
    ].includes(publication.state)
  )
    throw new Error(
      `Cannot record a pre-confirmation failure from ${publication.state}.`,
    );
  await database.$transaction(
    async (transaction) => {
      const request = await transaction.publicationRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      const targetId = request.publicationTargetId as string;
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${targetId}::uuid FOR UPDATE
      `;
      const target = await transaction.publicationTarget.findUniqueOrThrow({
        where: { id: targetId },
      });
      await transaction.databasePublication.update({
        where: { id: publication.id },
        data: {
          state: "FAILED_PREVIEW",
          terminalOutcome: "FAILED_BEFORE_CONFIRMATION",
        },
      });
      if (target.candidatePublicationRequestId === requestId)
        await transaction.publicationTarget.update({
          where: { id: target.id },
          data: {
            candidateSnapshotId: null,
            candidatePublicationRequestId: null,
            generation: { increment: 1 },
          },
        });
      await transaction.candidateAuthorization.updateMany({
        where: { publicationRequestId: requestId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.publicationRequest.update({
        where: { id: requestId },
        data: {
          state: "FAILED_PREVIEW",
          currentStep: publication.state,
          errorClass: "DATABASE_PUBLICATION_FAILURE",
          reconciliationReason: reason.slice(0, 500),
        },
      });
      await releasePublisherCheckout(
        transaction,
        requestId,
        "DATABASE_PUBLICATION_FAILED_BEFORE_CONFIRMATION",
      );
      await appendEvent(
        transaction,
        requestId,
        target.id,
        "publication.failed-before-confirmation",
        "PUBLICATION_FAILED_BEFORE_CONFIRMATION",
        { reason },
      );
    },
    { isolationLevel: "Serializable" },
  );
  return database.databasePublication.findUniqueOrThrow({
    where: { id: publication.id },
  });
}

export async function recordSyntheticObservation(
  database: DatabaseClient,
  input: {
    publicationId: string;
    snapshotId: string;
    kind: "CANDIDATE" | "OFFICIAL" | "RESTORATION";
    source?: "DATABASE" | "LAST_KNOWN_GOOD";
    releaseIdentity?: string;
  },
) {
  const publication = await database.databasePublication.findUniqueOrThrow({
    where: { id: input.publicationId },
    include: { target: true, candidateSnapshot: true },
  });
  const snapshot = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: input.snapshotId },
  });
  const observedAt = new Date();
  const receiptDigest = sha256(
    JSON.stringify({
      publicationId: publication.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.manifestHash,
      kind: input.kind,
      observedAt: observedAt.toISOString(),
      nonce: randomUUID(),
    }),
  );
  return database.leadershipObservationReceipt.create({
    data: {
      targetId: publication.targetId,
      databasePublicationId: publication.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.manifestHash,
      observationKind: input.kind,
      cacheSource: input.source ?? "DATABASE",
      healthResult: "HEALTHY",
      applicationReleaseIdentity:
        input.releaseIdentity ?? "disposable-acceptance-build",
      routeProbeHash: sha256(`routes:${snapshot.manifestHash}`),
      attestationKeyId: "synthetic-disposable-only",
      receiptDigest,
      observedAt,
    },
  });
}

async function processDatabaseRollbackAttempt(
  database: DatabaseClient,
  rollbackRequestId: string,
): Promise<DatabasePublicationResult> {
  const request = await database.rollbackRequest.findUniqueOrThrow({
    where: { id: rollbackRequestId },
    include: { publicationTarget: true, targetContentSnapshot: true },
  });
  const target = request.publicationTarget;
  const selected = request.targetContentSnapshot;
  const existingPublication = await database.databasePublication.findUnique({
    where: { rollbackRequestId },
  });
  if (
    !target?.officialSnapshotId ||
    !selected ||
    selected.validationState !== "VALIDATED" ||
    (!existingPublication && selected.id === target.officialSnapshotId) ||
    request.targetContentSnapshotHash !== selected.manifestHash ||
    (!existingPublication &&
      (request.expectedCurrentContentSnapshotId !== target.officialSnapshotId ||
        request.expectedCurrentContentSnapshotHash !==
          (
            await database.contentSnapshot.findUniqueOrThrow({
              where: { id: target.officialSnapshotId },
            })
          ).manifestHash)) ||
    (existingPublication &&
      request.expectedCurrentContentSnapshotId !==
        existingPublication.previousOfficialSnapshotId)
  )
    throw new Error(
      "Rollback selection is not an exact prior validated snapshot.",
    );
  let publication =
    existingPublication ??
    (await database.databasePublication.create({
      data: {
        publicationUuid: request.rollbackUuid,
        rollbackRequestId: request.id,
        targetId: target.id,
        previousOfficialSnapshotId: target.officialSnapshotId,
        publisherIdentityId: request.requestedById,
      },
    }));
  for (let transitions = 0; transitions < 8; transitions += 1) {
    if (publication.state === "REQUESTED") {
      await database.$transaction(async (transaction) => {
        await transaction.databasePublication.update({
          where: { id: publication.id },
          data: {
            candidateSnapshotId: selected.id,
            state: "SNAPSHOT_MATERIALIZED",
          },
        });
        await transaction.rollbackRequest.update({
          where: { id: request.id },
          data: {
            state: "SNAPSHOT_MATERIALIZED",
            currentStep: "SNAPSHOT_MATERIALIZED",
          },
        });
        await appendRollbackEvent(
          transaction,
          request.id,
          target.id,
          "rollback.snapshot-selected",
          "ROLLBACK_SNAPSHOT_SELECTED",
          { snapshotId: selected.id, snapshotHash: selected.manifestHash },
        );
      });
    } else if (publication.state === "SNAPSHOT_MATERIALIZED") {
      const bodiesSnapshot = await database.contentSnapshot.findUniqueOrThrow({
        where: { id: selected.id },
        include: { artifacts: { include: { content: true } } },
      });
      await validateCanonicalSnapshot(
        bodiesSnapshot.manifest,
        new Map(
          bodiesSnapshot.artifacts.map((artifact) => [
            artifact.contentHash,
            bytesForBlob(artifact.content),
          ]),
        ),
      );
      await database.$transaction(async (transaction) => {
        await transaction.databasePublication.update({
          where: { id: publication.id },
          data: { state: "SNAPSHOT_VALIDATED" },
        });
        await transaction.rollbackRequest.update({
          where: { id: request.id },
          data: {
            state: "SNAPSHOT_VALIDATED",
            currentStep: "SNAPSHOT_VALIDATED",
          },
        });
        await appendRollbackEvent(
          transaction,
          request.id,
          target.id,
          "rollback.snapshot-validated",
          "ROLLBACK_SNAPSHOT_VALIDATED",
          { snapshotId: selected.id, snapshotHash: selected.manifestHash },
        );
      });
    } else if (publication.state === "SNAPSHOT_VALIDATED") {
      await database.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT id FROM publication_targets
            WHERE id = ${target.id}::uuid FOR UPDATE
          `;
          const locked = await transaction.publicationTarget.findUniqueOrThrow({
            where: { id: target.id },
          });
          if (
            locked.officialSnapshotId !== publication.previousOfficialSnapshotId
          )
            throw new Error("Rollback base pointer changed.");
          if (locked.candidateSnapshotId)
            throw new Error("Another candidate already owns the target.");
          await transaction.databasePublication.update({
            where: { id: publication.id },
            data: { state: "CANDIDATE_AVAILABLE" },
          });
          await transaction.publicationTarget.update({
            where: { id: target.id },
            data: {
              candidateSnapshotId: selected.id,
              candidateRollbackRequestId: request.id,
              currentDatabasePublicationId: publication.id,
              generation: { increment: 1 },
            },
          });
          await transaction.rollbackRequest.update({
            where: { id: request.id },
            data: {
              state: "CANDIDATE_AVAILABLE",
              currentStep: "CANDIDATE_AVAILABLE",
            },
          });
          await appendRollbackEvent(
            transaction,
            request.id,
            target.id,
            "rollback.candidate-available",
            "ROLLBACK_CANDIDATE_AVAILABLE",
            { snapshotId: selected.id },
          );
        },
        { isolationLevel: "Serializable" },
      );
    } else if (publication.state === "CANDIDATE_AVAILABLE") {
      const receipt = await database.leadershipObservationReceipt.findFirst({
        where: {
          databasePublicationId: publication.id,
          snapshotId: selected.id,
          observationKind: "CANDIDATE",
          healthResult: "HEALTHY",
        },
      });
      if (!receipt) break;
      await database.$transaction(async (transaction) => {
        await transaction.databasePublication.update({
          where: { id: publication.id },
          data: { state: "CANDIDATE_VERIFIED" },
        });
        await transaction.rollbackRequest.update({
          where: { id: request.id },
          data: {
            state: "CANDIDATE_VERIFIED",
            currentStep: "CANDIDATE_VERIFIED",
          },
        });
        await appendRollbackEvent(
          transaction,
          request.id,
          target.id,
          "rollback.candidate-verified",
          "ROLLBACK_CANDIDATE_VERIFIED",
          { snapshotId: selected.id, receiptId: receipt.id },
        );
      });
    } else if (publication.state === "CANDIDATE_VERIFIED") {
      await database.$transaction(async (transaction) => {
        await transaction.databasePublication.update({
          where: { id: publication.id },
          data: { state: "AWAITING_CONFIRMATION" },
        });
        await transaction.rollbackRequest.update({
          where: { id: request.id },
          data: {
            state: "AWAITING_CONFIRMATION",
            currentStep: "AWAITING_CONFIRMATION",
          },
        });
        await appendRollbackEvent(
          transaction,
          request.id,
          target.id,
          "rollback.awaiting-confirmation",
          "ROLLBACK_AWAITING_CONFIRMATION",
          { snapshotId: selected.id },
        );
      });
    } else if (publication.state === "AWAITING_CONFIRMATION") {
      const confirmation = await database.publicationConfirmation.findUnique({
        where: { rollbackRequestId: request.id },
      });
      if (!confirmation) break;
      await database.$transaction(
        async (transaction) => {
          await transaction.$queryRaw`
            SELECT id FROM publication_targets
            WHERE id = ${target.id}::uuid FOR UPDATE
          `;
          const locked = await transaction.publicationTarget.findUniqueOrThrow({
            where: { id: target.id },
          });
          if (
            locked.candidateSnapshotId !== selected.id ||
            locked.generation !== confirmation.targetGeneration
          )
            throw new Error("Rollback confirmation is stale.");
          await transaction.databasePublication.update({
            where: { id: publication.id },
            data: {
              confirmationId: confirmation.id,
              resultingOfficialSnapshotId: selected.id,
              state: "OFFICIAL_POINTER_COMMITTED",
            },
          });
          await transaction.publicationTarget.update({
            where: { id: target.id },
            data: {
              officialSnapshotId: selected.id,
              candidateSnapshotId: null,
              candidateRollbackRequestId: null,
              generation: { increment: 1 },
            },
          });
          await transaction.rollbackRequest.update({
            where: { id: request.id },
            data: {
              state: "OFFICIAL_POINTER_COMMITTED",
              currentStep: "OFFICIAL_POINTER_COMMITTED",
            },
          });
          await appendRollbackEvent(
            transaction,
            request.id,
            target.id,
            "rollback.official-pointer-committed",
            "ROLLBACK_OFFICIAL_POINTER_COMMITTED",
            {
              snapshotId: selected.id,
              previousSnapshotId: publication.previousOfficialSnapshotId,
              confirmationId: confirmation.id,
            },
          );
        },
        { isolationLevel: "Serializable" },
      );
    } else if (publication.state === "OFFICIAL_POINTER_COMMITTED") {
      const receipt = await database.leadershipObservationReceipt.findFirst({
        where: {
          databasePublicationId: publication.id,
          snapshotId: selected.id,
          observationKind: "OFFICIAL",
          healthResult: "HEALTHY",
        },
      });
      if (!receipt) break;
      await database.$transaction(async (transaction) => {
        await transaction.databasePublication.update({
          where: { id: publication.id },
          data: { state: "LIVE_VERIFIED", healthReceiptId: receipt.id },
        });
        await appendRollbackEvent(
          transaction,
          request.id,
          target.id,
          "rollback.live-verified",
          "ROLLBACK_LIVE_VERIFIED",
          { snapshotId: selected.id, receiptId: receipt.id },
        );
        await transaction.databasePublication.update({
          where: { id: publication.id },
          data: { state: "RECONCILED", terminalOutcome: "PUBLISHED" },
        });
        await transaction.rollbackRequest.update({
          where: { id: request.id },
          data: { state: "RECONCILED", currentStep: "RECONCILED" },
        });
        await appendRollbackEvent(
          transaction,
          request.id,
          target.id,
          "rollback.reconciled",
          "ROLLBACK_RECONCILED",
          { snapshotId: selected.id, receiptId: receipt.id },
        );
      });
    } else if (publication.state === "RESTORING_PREVIOUS") {
      if (
        !(await finishAutomaticRollbackRestoration(
          database,
          request.id,
          publication.id,
        ))
      )
        break;
    } else break;
    publication = await database.databasePublication.findUniqueOrThrow({
      where: { id: publication.id },
    });
  }
  return {
    requestId: request.id,
    publicationId: publication.id,
    state: publication.state,
    snapshotId: publication.candidateSnapshotId,
    snapshotHash: selected.manifestHash,
  };
}

export async function failDatabaseRollbackBeforeConfirmation(
  database: DatabaseClient,
  rollbackRequestId: string,
  reason: string,
) {
  const request = await database.rollbackRequest.findUniqueOrThrow({
    where: { id: rollbackRequestId },
    include: { publicationTarget: true, targetContentSnapshot: true },
  });
  const target = request.publicationTarget;
  if (!target)
    throw new Error("Rollback request has no database publication target.");
  const publication = await database.databasePublication.findUnique({
    where: { rollbackRequestId },
  });
  if (publication?.state === "FAILED_PREVIEW") return publication;
  if (
    publication &&
    ![
      "REQUESTED",
      "SNAPSHOT_MATERIALIZED",
      "SNAPSHOT_VALIDATED",
      "CANDIDATE_AVAILABLE",
      "CANDIDATE_VERIFIED",
      "AWAITING_CONFIRMATION",
    ].includes(publication.state)
  )
    throw new Error(
      `Cannot record a pre-confirmation rollback failure from ${publication.state}.`,
    );
  await database.$transaction(
    async (transaction) => {
      await transaction.$queryRaw`
        SELECT id FROM publication_targets
        WHERE id = ${target.id}::uuid FOR UPDATE
      `;
      if (publication)
        await transaction.databasePublication.update({
          where: { id: publication.id },
          data: {
            state: "FAILED_PREVIEW",
            terminalOutcome: "FAILED_BEFORE_CONFIRMATION",
          },
        });
      const lockedTarget =
        await transaction.publicationTarget.findUniqueOrThrow({
          where: { id: target.id },
        });
      if (lockedTarget.candidateRollbackRequestId === rollbackRequestId) {
        await transaction.publicationTarget.update({
          where: { id: target.id },
          data: {
            candidateSnapshotId: null,
            candidateRollbackRequestId: null,
            generation: { increment: 1 },
          },
        });
      }
      await transaction.candidateAuthorization.updateMany({
        where: { rollbackRequestId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await transaction.rollbackRequest.update({
        where: { id: rollbackRequestId },
        data: {
          state: "FAILED_PREVIEW",
          currentStep: publication?.state ?? request.state,
          errorClass: "DATABASE_ROLLBACK_FAILURE",
          reconciliationReason: reason.slice(0, 500),
        },
      });
      await releasePublisherCheckout(
        transaction,
        rollbackRequestId,
        "DATABASE_ROLLBACK_FAILED_BEFORE_CONFIRMATION",
      );
      await appendRollbackEvent(
        transaction,
        rollbackRequestId,
        target.id,
        "rollback.failed-before-confirmation",
        "ROLLBACK_FAILED_BEFORE_CONFIRMATION",
        { reason },
      );
    },
    { isolationLevel: "Serializable" },
  );
  return publication
    ? database.databasePublication.findUniqueOrThrow({
        where: { id: publication.id },
      })
    : null;
}

export async function processDatabaseRollback(
  database: DatabaseClient,
  rollbackRequestId: string,
): Promise<DatabasePublicationResult> {
  try {
    return await processDatabaseRollbackAttempt(database, rollbackRequestId);
  } catch (error) {
    const publication = await database.databasePublication.findUnique({
      where: { rollbackRequestId },
    });
    if (
      !publication ||
      [
        "REQUESTED",
        "SNAPSHOT_MATERIALIZED",
        "SNAPSHOT_VALIDATED",
        "CANDIDATE_AVAILABLE",
        "CANDIDATE_VERIFIED",
        "AWAITING_CONFIRMATION",
      ].includes(publication.state)
    ) {
      const failed = await failDatabaseRollbackBeforeConfirmation(
        database,
        rollbackRequestId,
        error instanceof Error ? error.message : "Database rollback failed.",
      );
      const request = await database.rollbackRequest.findUniqueOrThrow({
        where: { id: rollbackRequestId },
      });
      return {
        requestId: rollbackRequestId,
        publicationId: failed?.id ?? null,
        state: "FAILED_PREVIEW",
        snapshotId: failed?.candidateSnapshotId ?? null,
        snapshotHash: request.targetContentSnapshotHash,
      };
    }
    throw error;
  }
}
