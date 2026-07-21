import { randomBytes } from "node:crypto";
import { sha256 } from "@situation-studio/domain";
import type { DatabaseClient } from "@situation-studio/db";

export type CandidateRequestKind = "publication" | "rollback";

export class CandidateUnavailableError extends Error {
  constructor() {
    super("candidate is unavailable");
    this.name = "CandidateUnavailableError";
  }
}

const reviewableStates = new Set([
  "CANDIDATE_AVAILABLE",
  "CANDIDATE_VERIFIED",
  "AWAITING_CONFIRMATION",
]);

export async function createCandidateAuthorization(
  database: DatabaseClient,
  input: {
    requestId: string;
    requestKind: CandidateRequestKind;
    reviewerId: string;
    audience: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
  const exchangeToken = randomBytes(32).toString("hex");

  const authorization = await database.$transaction(async (transaction) => {
    // Serialize retries and double-clicks for one reviewer and request. The
    // newest authorization revokes an older, unexchanged token before a new
    // token is issued.
    await transaction.$queryRaw<Array<{ acquired: string }>>`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`${input.requestKind}:${input.requestId}:${input.reviewerId}`},
            0
          )
        )::text AS acquired
      `;

    if (input.requestKind === "publication") {
      const request = await transaction.publicationRequest.findUnique({
        where: { id: input.requestId },
        include: {
          candidateContentSnapshot: true,
          databasePublication: true,
          publicationTarget: true,
        },
      });
      const publication = request?.databasePublication;
      const target = request?.publicationTarget;
      const snapshot = request?.candidateContentSnapshot;
      if (
        !request ||
        !publication?.candidateSnapshotId ||
        !request.candidateContentSnapshotHash ||
        !target ||
        !snapshot ||
        request.state !== publication.state ||
        !reviewableStates.has(publication.state) ||
        request.candidateContentSnapshotId !==
          publication.candidateSnapshotId ||
        snapshot.id !== publication.candidateSnapshotId ||
        snapshot.validationState !== "VALIDATED" ||
        snapshot.manifestHash !== request.candidateContentSnapshotHash ||
        target.candidateSnapshotId !== publication.candidateSnapshotId ||
        target.candidatePublicationRequestId !== request.id ||
        target.candidateRollbackRequestId !== null ||
        target.currentDatabasePublicationId !== publication.id
      )
        throw new CandidateUnavailableError();

      await transaction.candidateAuthorization.updateMany({
        where: {
          publicationRequestId: request.id,
          reviewerId: input.reviewerId,
          cookieTokenHash: null,
          exchangedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
      return transaction.candidateAuthorization.create({
        data: {
          publicationRequestId: request.id,
          targetId: target.id,
          snapshotId: snapshot.id,
          snapshotHash: snapshot.manifestHash,
          reviewerId: input.reviewerId,
          exchangeTokenHash: sha256(exchangeToken),
          audience: input.audience,
          expiresAt,
        },
      });
    }

    const request = await transaction.rollbackRequest.findUnique({
      where: { id: input.requestId },
      include: {
        databasePublication: {
          include: { candidateSnapshot: true },
        },
        publicationTarget: true,
      },
    });
    const publication = request?.databasePublication;
    const target = request?.publicationTarget;
    const snapshot = publication?.candidateSnapshot;
    if (
      !request ||
      !publication?.candidateSnapshotId ||
      !request.targetContentSnapshotHash ||
      !target ||
      !snapshot ||
      request.state !== publication.state ||
      !reviewableStates.has(publication.state) ||
      snapshot.id !== publication.candidateSnapshotId ||
      snapshot.validationState !== "VALIDATED" ||
      snapshot.manifestHash !== request.targetContentSnapshotHash ||
      target.candidateSnapshotId !== publication.candidateSnapshotId ||
      target.candidateRollbackRequestId !== request.id ||
      target.candidatePublicationRequestId !== null ||
      target.currentDatabasePublicationId !== publication.id
    )
      throw new CandidateUnavailableError();

    await transaction.candidateAuthorization.updateMany({
      where: {
        rollbackRequestId: request.id,
        reviewerId: input.reviewerId,
        cookieTokenHash: null,
        exchangedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: now },
    });
    return transaction.candidateAuthorization.create({
      data: {
        rollbackRequestId: request.id,
        targetId: target.id,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.manifestHash,
        reviewerId: input.reviewerId,
        exchangeTokenHash: sha256(exchangeToken),
        audience: input.audience,
        expiresAt,
      },
    });
  });

  return { authorization, exchangeToken };
}
