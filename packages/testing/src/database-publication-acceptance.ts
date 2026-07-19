import { randomBytes, randomUUID } from "node:crypto";
import {
  canonicalArtifactBytes,
  canonicalJson,
  sha256,
  validationPolicyHash,
} from "@situation-studio/content-contracts";
import { createDatabaseClient, Prisma } from "@situation-studio/db";
import {
  beginAutomaticRestoration,
  beginAutomaticRollbackRestoration,
  failDatabaseRollbackBeforeConfirmation,
  markRollbackReconciliationRequired,
  processDatabaseRollback,
  processDatabasePublication,
  recordSyntheticObservation,
} from "../../../apps/publisher/src/database-service";

const databaseUrl = process.env.DATABASE_URL;
if (
  !databaseUrl ||
  !/situation_studio_(?:migration_test|full_validation)_/u.test(databaseUrl)
)
  throw new Error(
    "Refusing database publication acceptance outside a disposable database.",
  );

const database = createDatabaseClient(databaseUrl, 3);
const mode = process.argv[2] ?? "status";
const fixtureKey =
  process.env.ACCEPTANCE_FIXTURE_KEY ?? "database-publication-acceptance-v1";
if (!/^[a-z0-9-]{8,100}$/u.test(fixtureKey))
  throw new Error("Acceptance fixture key is invalid.");
const situationSlug =
  process.env.ACCEPTANCE_SITUATION_SLUG ?? "make-bad-attitude-specific";
if (!/^[a-z0-9-]+$/u.test(situationSlug))
  throw new Error("Acceptance situation slug is invalid.");

function requiredPublicationId(value: { publicationId: string | null }) {
  if (!value.publicationId)
    throw new Error("Acceptance publication identity is missing.");
  return value.publicationId;
}

async function fixtureRequest() {
  return database.publicationRequest.findFirst({
    where: { idempotencyKey: fixtureKey },
    include: {
      databasePublication: true,
      candidateAuthorizations: true,
      confirmations: true,
      approval: true,
      publicationTarget: true,
    },
  });
}

async function seedCandidate(stopAfterState?: string) {
  let request = await fixtureRequest();
  if (!request) {
    const target = await database.publicationTarget.findUniqueOrThrow({
      where: { code: "leadership-production" },
      include: {
        officialSnapshot: {
          include: {
            artifacts: {
              where: { logicalId: `situation:${situationSlug}` },
              include: { content: true, artifact: true },
            },
          },
        },
      },
    });
    const base = target.officialSnapshot;
    const member = base?.artifacts[0];
    if (!base || !member)
      throw new Error("Disposable official snapshot is not bootstrapped.");
    const candidateBody = member.content.body.replace(
      /^(title:\s*[^\n]+)$/mu,
      `$1 — ${fixtureKey}`,
    );
    if (candidateBody === member.content.body)
      throw new Error("Acceptance title fixture could not be applied.");
    const canonical = canonicalArtifactBytes(
      member.canonicalPath,
      new TextEncoder().encode(candidateBody),
    );
    const candidateHash = sha256(canonical.bytes);
    const repository = await database.repositorySnapshot.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    const situation = await database.situation.findUniqueOrThrow({
      where: { slug: situationSlug },
    });
    const revision =
      (
        await database.proposedBundle.aggregate({
          where: { situationId: situation.id },
          _max: { revision: true },
        })
      )._max.revision ?? 0;
    const user = await database.user.create({
      data: {
        username: `acceptance-${randomUUID().slice(0, 8)}`,
        displayName: "Database Publication Acceptance Reviewer",
        repositoryReviewerId: `acceptance-${randomUUID()}`,
        identityType: "HUMAN",
        state: "ACTIVE",
      },
    });
    const reauthenticatedAt = new Date();
    const session = await database.session.create({
      data: {
        tokenHash: sha256(randomUUID()),
        userId: user.id,
        passwordVersion: user.passwordVersion,
        csrfSecretHash: sha256(randomUUID()),
        reauthenticatedAt,
        idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        absoluteExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    });
    await database.contentBlob.create({
      data: {
        hash: candidateHash,
        body: new TextDecoder().decode(canonical.bytes),
        encoding: "UTF8",
        byteLength: canonical.bytes.byteLength,
      },
    });
    const draft = await database.draft.create({
      data: {
        situationId: situation.id,
        baseSnapshotId: repository.id,
        state: "APPROVED",
      },
    });
    const bundleManifest = {
      schemaVersion: "database-publication-acceptance-v1",
      baseSnapshotHash: base.manifestHash,
      changes: [
        {
          logicalId: member.logicalId,
          path: member.canonicalPath,
          baseHash: member.contentHash,
          candidateHash,
          changeKind: "MODIFY",
        },
      ],
    };
    const bundleHash = sha256(canonicalJson(bundleManifest));
    const bundle = await database.proposedBundle.create({
      data: {
        situationId: situation.id,
        revision: revision + 1,
        snapshotId: repository.id,
        draftId: draft.id,
        baseCommit: repository.commitSha,
        baseContentSnapshotId: base.id,
        baseManifestHash: repository.manifestHash,
        graphHash: sha256(`graph:${base.manifestHash}`),
        canonicalHash: bundleHash,
        manifest: bundleManifest,
        state: "APPROVED",
      },
    });
    await database.bundleArtifact.create({
      data: {
        bundleId: bundle.id,
        artifactId: member.artifactId,
        path: member.canonicalPath,
        type: member.artifactType,
        baseHash: member.contentHash,
        candidateHash,
        contentHash: candidateHash,
        changeKind: "MODIFY",
      },
    });
    for (const validator of [
      "shared-content-contract",
      "human-review-provenance",
    ])
      await database.validationRun.create({
        data: {
          bundleId: bundle.id,
          bundleHash,
          validator,
          version: "acceptance-v1",
          environmentHash: sha256(`${validator}:acceptance-v1`),
          state: "PASSED",
          summary: "Disposable acceptance evidence",
          outputHash: sha256(`${validator}:${bundleHash}`),
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
    const approval = await database.approval.create({
      data: {
        bundleId: bundle.id,
        bundleHash,
        baseCommit: repository.commitSha,
        baseContentSnapshotId: base.id,
        baseContentSnapshotHash: base.manifestHash,
        validationPolicyHash,
        approvedById: user.id,
        repositoryReviewerId: user.repositoryReviewerId,
        contentReviewDate: new Date().toISOString().slice(0, 10),
        sessionId: session.id,
        permissionSnapshot: ["publication.approve", "publication.publish"],
      },
    });
    await database.publicationRequest.create({
      data: {
        publicationUuid: randomUUID(),
        idempotencyKey: fixtureKey,
        targetEnvironment: "protected-beta",
        publicationTargetId: target.id,
        bundleId: bundle.id,
        bundleHash,
        approvalId: approval.id,
        baseCommit: repository.commitSha,
        baseContentSnapshotId: base.id,
        baseContentSnapshotHash: base.manifestHash,
        targetGeneration: target.generation,
        requestedById: user.id,
      },
    });
    request = await fixtureRequest();
  }
  if (!request) throw new Error("Acceptance request was not created.");
  const result = await processDatabasePublication(
    database,
    request.id,
    stopAfterState ? { stopAfterState } : {},
  );
  if (stopAfterState && result.state === stopAfterState)
    return { ...result, mode, simulatedCrashBoundary: stopAfterState };
  if (result.state !== "CANDIDATE_AVAILABLE")
    throw new Error(`Expected a candidate, received ${result.state}.`);
  const exchangeToken = randomBytes(32).toString("hex");
  const cookieToken = randomBytes(32).toString("hex");
  const authorization = await database.candidateAuthorization.create({
    data: {
      publicationRequestId: request.id,
      targetId: request.publicationTargetId as string,
      snapshotId: result.snapshotId as string,
      snapshotHash: result.snapshotHash as string,
      reviewerId: request.requestedById,
      exchangeTokenHash: sha256(exchangeToken),
      audience: "https://leadership.timsprototypes.com",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  await database.candidateAuthorization.update({
    where: { id: authorization.id },
    data: {
      cookieTokenHash: sha256(cookieToken),
      exchangedAt: new Date(),
    },
  });
  return {
    mode,
    requestId: request.id,
    publicationId: result.publicationId,
    state: result.state,
    snapshotId: result.snapshotId,
    snapshotHash: result.snapshotHash,
    reviewerId: request.requestedById,
    audience: "https://leadership.timsprototypes.com",
    authorizationId: authorization.id,
  };
}

async function duplicateDelivery() {
  const request = await fixtureRequest();
  if (!request) throw new Error("Acceptance request is unavailable.");
  const results = await Promise.all([
    processDatabasePublication(database, request.id),
    processDatabasePublication(database, request.id),
  ]);
  const snapshotIds = new Set(results.map((result) => result.snapshotId));
  if (snapshotIds.size !== 1)
    throw new Error("Duplicate delivery created divergent candidates.");
  return {
    mode,
    deliveries: results.length,
    snapshotIds: [...snapshotIds],
    state: results[0]?.state,
  };
}

async function attemptConcurrentPublication() {
  let rejected = false;
  try {
    await seedCandidate("REQUESTED");
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      rejected = true;
    else throw error;
  }
  if (!rejected)
    throw new Error("Concurrent target publication was unexpectedly accepted.");
  const winner = await database.publicationRequest.findFirstOrThrow({
    where: {
      publicationTargetId: { not: null },
      state: {
        notIn: ["RECONCILED", "FAILED_PREVIEW", "AUTO_ROLLED_BACK"],
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const result = await processDatabasePublication(database, winner.id);
  const activeCandidates = await database.publicationTarget.count({
    where: {
      code: "leadership-production",
      candidatePublicationRequestId: winner.id,
      candidateSnapshotId: result.snapshotId,
    },
  });
  return {
    mode,
    contention: "DATABASE_UNIQUE_TARGET",
    loser: "REJECTED_BEFORE_MATERIALIZATION",
    winnerRequestId: winner.id,
    winnerState: result.state,
    activeCandidates,
  };
}

async function observeCandidate() {
  const request = await fixtureRequest();
  if (!request?.databasePublication?.candidateSnapshotId)
    throw new Error("Candidate fixture is unavailable.");
  await recordSyntheticObservation(database, {
    publicationId: request.databasePublication.id,
    snapshotId: request.databasePublication.candidateSnapshotId,
    kind: "CANDIDATE",
  });
  return processDatabasePublication(database, request.id);
}

async function confirm() {
  const request = await fixtureRequest();
  const publication = request?.databasePublication;
  const target = request?.publicationTarget;
  if (!request || !publication?.candidateSnapshotId || !target)
    throw new Error("Awaiting-confirmation fixture is unavailable.");
  const session = await database.session.findUniqueOrThrow({
    where: { id: request.approval.sessionId },
  });
  if (!session.reauthenticatedAt)
    throw new Error("Acceptance session is not recently authenticated.");
  const snapshot = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: publication.candidateSnapshotId },
  });
  await database.publicationConfirmation.create({
    data: {
      publicationRequestId: request.id,
      targetId: target.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.manifestHash,
      approvalId: request.approvalId,
      confirmedById: request.requestedById,
      sessionId: session.id,
      validationPolicyHash: request.approval.validationPolicyHash,
      targetGeneration: target.generation,
      recentAuthenticationAt: session.reauthenticatedAt,
    },
  });
  return processDatabasePublication(database, request.id);
}

async function observeOfficial() {
  const request = await fixtureRequest();
  if (!request?.databasePublication?.candidateSnapshotId)
    throw new Error("Committed publication fixture is unavailable.");
  await recordSyntheticObservation(database, {
    publicationId: request.databasePublication.id,
    snapshotId: request.databasePublication.candidateSnapshotId,
    kind: "OFFICIAL",
  });
  return processDatabasePublication(database, request.id);
}

async function restoreAfterLiveFailure() {
  const request = await fixtureRequest();
  if (!request?.databasePublication)
    throw new Error("Committed publication fixture is unavailable.");
  const restored = await beginAutomaticRestoration(
    database,
    request.id,
    "Injected live health failure for disposable acceptance.",
  );
  await recordSyntheticObservation(database, {
    publicationId: restored.id,
    snapshotId: restored.previousOfficialSnapshotId,
    kind: "RESTORATION",
  });
  return processDatabasePublication(database, request.id);
}

async function manualRollback(stopBeforeOfficialObservation = false) {
  const publicationRequest = await fixtureRequest();
  const completed = publicationRequest?.databasePublication;
  const target = publicationRequest?.publicationTarget;
  if (
    !publicationRequest ||
    completed?.state !== "RECONCILED" ||
    !completed.candidateSnapshotId ||
    !target ||
    target.officialSnapshotId !== completed.candidateSnapshotId
  )
    throw new Error(
      "A reconciled database publication is required for rollback.",
    );
  const currentSnapshot = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: completed.candidateSnapshotId },
  });
  const targetSnapshot = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: completed.previousOfficialSnapshotId },
  });
  const bundle = await database.proposedBundle.findUniqueOrThrow({
    where: { id: publicationRequest.bundleId },
  });
  const rollback = await database.rollbackRequest.create({
    data: {
      rollbackUuid: randomUUID(),
      idempotencyKey: `manual-rollback-${fixtureKey}`,
      targetEnvironment: "protected-beta",
      publicationTargetId: target.id,
      targetContentSnapshotId: completed.previousOfficialSnapshotId,
      targetContentSnapshotHash: targetSnapshot.manifestHash,
      expectedCurrentContentSnapshotId: currentSnapshot.id,
      expectedCurrentContentSnapshotHash: currentSnapshot.manifestHash,
      situationId: bundle.situationId,
      requestedById: publicationRequest.requestedById,
      reason: "Disposable acceptance of audited database snapshot rollback.",
    },
  });
  let result = await processDatabaseRollback(database, rollback.id);
  if (result.state !== "CANDIDATE_AVAILABLE")
    throw new Error(`Rollback candidate was not available: ${result.state}.`);
  await recordSyntheticObservation(database, {
    publicationId: requiredPublicationId(result),
    snapshotId: result.snapshotId as string,
    kind: "CANDIDATE",
  });
  result = await processDatabaseRollback(database, rollback.id);
  const session = await database.session.findUniqueOrThrow({
    where: { id: publicationRequest.approval.sessionId },
  });
  if (!session.reauthenticatedAt)
    throw new Error("Rollback confirmation session is not reauthenticated.");
  const selected = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: result.snapshotId as string },
  });
  const currentTarget = await database.publicationTarget.findUniqueOrThrow({
    where: { id: target.id },
  });
  await database.publicationConfirmation.create({
    data: {
      rollbackRequestId: rollback.id,
      targetId: target.id,
      snapshotId: selected.id,
      snapshotHash: selected.manifestHash,
      confirmedById: publicationRequest.requestedById,
      sessionId: session.id,
      validationPolicyHash,
      targetGeneration: currentTarget.generation,
      recentAuthenticationAt: session.reauthenticatedAt,
    },
  });
  result = await processDatabaseRollback(database, rollback.id);
  if (stopBeforeOfficialObservation)
    return { ...result, rollbackRequestId: rollback.id };
  await recordSyntheticObservation(database, {
    publicationId: requiredPublicationId(result),
    snapshotId: result.snapshotId as string,
    kind: "OFFICIAL",
  });
  result = await processDatabaseRollback(database, rollback.id);
  return { ...result, rollbackRequestId: rollback.id };
}

async function restoreRollbackAfterLiveFailure() {
  const rollback = await database.rollbackRequest.findFirstOrThrow({
    where: { idempotencyKey: { startsWith: "manual-rollback-" } },
    include: { databasePublication: true },
    orderBy: { createdAt: "desc" },
  });
  if (rollback.databasePublication?.state !== "OFFICIAL_POINTER_COMMITTED")
    throw new Error(
      "A committed rollback is required for failure restoration.",
    );
  const restored = await beginAutomaticRollbackRestoration(
    database,
    rollback.id,
    "Injected rollback live health failure for disposable acceptance.",
  );
  await recordSyntheticObservation(database, {
    publicationId: restored.id,
    snapshotId: restored.previousOfficialSnapshotId,
    kind: "RESTORATION",
  });
  return processDatabaseRollback(database, rollback.id);
}

async function resumeManualRollback() {
  const rollback = await database.rollbackRequest.findFirstOrThrow({
    where: { idempotencyKey: { startsWith: "manual-rollback-" } },
    orderBy: { createdAt: "desc" },
  });
  return processDatabaseRollback(database, rollback.id);
}

async function createReverseAcceptanceRollback(idempotencyKey: string) {
  const publicationRequest = await fixtureRequest();
  const completed = publicationRequest?.databasePublication;
  const target = publicationRequest?.publicationTarget;
  if (
    !publicationRequest ||
    !completed?.candidateSnapshotId ||
    !target?.officialSnapshotId
  )
    throw new Error("A completed publication history is required.");
  const selected = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: completed.candidateSnapshotId },
  });
  const current = await database.contentSnapshot.findUniqueOrThrow({
    where: { id: target.officialSnapshotId },
  });
  const bundle = await database.proposedBundle.findUniqueOrThrow({
    where: { id: publicationRequest.bundleId },
  });
  const rollback = await database.rollbackRequest.create({
    data: {
      rollbackUuid: randomUUID(),
      idempotencyKey,
      targetEnvironment: "protected-beta",
      publicationTargetId: target.id,
      targetContentSnapshotId: selected.id,
      targetContentSnapshotHash: selected.manifestHash,
      expectedCurrentContentSnapshotId: current.id,
      expectedCurrentContentSnapshotHash: current.manifestHash,
      situationId: bundle.situationId,
      requestedById: publicationRequest.requestedById,
      reason: "Disposable acceptance of rollback failure disposition.",
    },
  });
  return { publicationRequest, rollback, target, selected };
}

async function rollbackFailureCleanupAcceptance() {
  const { publicationRequest, rollback, target, selected } =
    await createReverseAcceptanceRollback(`failure-rollback-${fixtureKey}`);
  const candidate = await processDatabaseRollback(database, rollback.id);
  if (candidate.state !== "CANDIDATE_AVAILABLE")
    throw new Error("Rollback failure fixture did not reach candidate state.");
  const authorization = await database.candidateAuthorization.create({
    data: {
      rollbackRequestId: rollback.id,
      targetId: target.id,
      snapshotId: selected.id,
      snapshotHash: selected.manifestHash,
      reviewerId: publicationRequest.requestedById,
      exchangeTokenHash: sha256(randomBytes(32)),
      audience: "https://leadership.timsprototypes.com",
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  await failDatabaseRollbackBeforeConfirmation(
    database,
    rollback.id,
    "Injected pre-confirmation rollback failure.",
  );
  const [failedRequest, failedPublication, cleanTarget, revoked] =
    await Promise.all([
      database.rollbackRequest.findUniqueOrThrow({
        where: { id: rollback.id },
      }),
      database.databasePublication.findUniqueOrThrow({
        where: { rollbackRequestId: rollback.id },
      }),
      database.publicationTarget.findUniqueOrThrow({
        where: { id: target.id },
      }),
      database.candidateAuthorization.findUniqueOrThrow({
        where: { id: authorization.id },
      }),
    ]);
  if (
    failedRequest.state !== "FAILED_PREVIEW" ||
    failedPublication.state !== "FAILED_PREVIEW" ||
    cleanTarget.candidateSnapshotId ||
    cleanTarget.candidateRollbackRequestId ||
    !revoked.revokedAt
  )
    throw new Error("Rollback failure did not release candidate custody.");
  return { state: failedRequest.state, candidateCustodyReleased: true };
}

async function rollbackReconciliationRequiredAcceptance() {
  const { publicationRequest, rollback, target, selected } =
    await createReverseAcceptanceRollback(
      `reconciliation-rollback-${fixtureKey}`,
    );
  let result = await processDatabaseRollback(database, rollback.id);
  await recordSyntheticObservation(database, {
    publicationId: requiredPublicationId(result),
    snapshotId: selected.id,
    kind: "CANDIDATE",
  });
  result = await processDatabaseRollback(database, rollback.id);
  const session = await database.session.findUniqueOrThrow({
    where: { id: publicationRequest.approval.sessionId },
  });
  if (!session.reauthenticatedAt)
    throw new Error("Reconciliation fixture session is not reauthenticated.");
  const currentTarget = await database.publicationTarget.findUniqueOrThrow({
    where: { id: target.id },
  });
  await database.publicationConfirmation.create({
    data: {
      rollbackRequestId: rollback.id,
      targetId: target.id,
      snapshotId: selected.id,
      snapshotHash: selected.manifestHash,
      confirmedById: publicationRequest.requestedById,
      sessionId: session.id,
      validationPolicyHash,
      targetGeneration: currentTarget.generation,
      recentAuthenticationAt: session.reauthenticatedAt,
    },
  });
  result = await processDatabaseRollback(database, rollback.id);
  if (result.state !== "OFFICIAL_POINTER_COMMITTED")
    throw new Error("Reconciliation fixture did not commit its pointer.");
  const marked = await markRollbackReconciliationRequired(
    database,
    rollback.id,
    "Injected exhausted automatic-restoration deadline.",
  );
  const event = await database.publicationEvent.findUnique({
    where: {
      rollbackRequestId_eventKey: {
        rollbackRequestId: rollback.id,
        eventKey: "rollback.reconciliation-required",
      },
    },
  });
  if (marked.state !== "RECONCILIATION_REQUIRED" || !event)
    throw new Error("Rollback reconciliation receipt was not durable.");
  return { state: marked.state, durableEvent: event.eventType };
}

async function status() {
  const request = await fixtureRequest();
  const target = await database.publicationTarget.findUnique({
    where: { code: "leadership-production" },
  });
  return {
    mode,
    requestId: request?.id ?? null,
    state: request?.databasePublication?.state ?? null,
    candidateSnapshotId: target?.candidateSnapshotId ?? null,
    officialSnapshotId: target?.officialSnapshotId ?? null,
    generation: target?.generation.toString() ?? null,
  };
}

async function fullSuccessAcceptance() {
  let target = await database.publicationTarget.findUnique({
    where: { code: "leadership-production" },
  });
  if (!target) {
    const bootstrap = await database.contentSnapshot.findUniqueOrThrow({
      where: {
        manifestHash:
          "cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e",
      },
    });
    target = await database.$transaction(async (transaction) => {
      const created = await transaction.publicationTarget.create({
        data: { code: "leadership-production" },
      });
      return transaction.publicationTarget.update({
        where: { id: created.id },
        data: {
          officialSnapshotId: bootstrap.id,
          bootstrappedAt: new Date(),
          generation: { increment: 1 },
        },
      });
    });
  }
  if (!target.officialSnapshotId || target.candidateSnapshotId)
    throw new Error("Acceptance target is not at a clean official boundary.");
  const crashed = await seedCandidate("SNAPSHOT_MATERIALIZED");
  const candidate = await seedCandidate();
  const duplicates = await duplicateDelivery();
  await observeCandidate();
  await confirm();
  const published = await observeOfficial();
  const rolledBack = await manualRollback();
  const events = await database.publicationEvent.findMany({
    where: {
      OR: [
        { publicationRequestId: published.requestId },
        { rollbackRequestId: rolledBack.rollbackRequestId },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
  });
  const rollbackEventTypes = events
    .filter((event) => event.rollbackRequestId === rolledBack.rollbackRequestId)
    .map((event) => event.eventType);
  const expectedRollbackEventTypes = [
    "ROLLBACK_SNAPSHOT_SELECTED",
    "ROLLBACK_SNAPSHOT_VALIDATED",
    "ROLLBACK_CANDIDATE_AVAILABLE",
    "ROLLBACK_CANDIDATE_VERIFIED",
    "ROLLBACK_AWAITING_CONFIRMATION",
    "ROLLBACK_OFFICIAL_POINTER_COMMITTED",
    "ROLLBACK_LIVE_VERIFIED",
    "ROLLBACK_RECONCILED",
  ];
  if (
    crashed.state !== "SNAPSHOT_MATERIALIZED" ||
    candidate.state !== "CANDIDATE_AVAILABLE" ||
    duplicates.deliveries !== 2 ||
    published.state !== "RECONCILED" ||
    rolledBack.state !== "RECONCILED" ||
    rollbackEventTypes.join(",") !== expectedRollbackEventTypes.join(",")
  )
    throw new Error("Full database publication acceptance did not reconcile.");
  const failedRollback = await rollbackFailureCleanupAcceptance();
  const reconciliationRequired =
    await rollbackReconciliationRequiredAcceptance();
  return {
    mode,
    publicationState: published.state,
    rollbackState: rolledBack.state,
    duplicateDeliveries: duplicates.deliveries,
    publicationSnapshotHash: published.snapshotHash,
    rollbackSnapshotHash: rolledBack.snapshotHash,
    eventCount: events.length,
    rollbackEventTypes,
    failedRollback,
    reconciliationRequired,
    gitRemoteRequired: false,
  };
}

try {
  const result =
    mode === "full"
      ? await fullSuccessAcceptance()
      : mode === "seed-request"
        ? await seedCandidate("REQUESTED")
        : mode === "attempt-contention"
          ? await attemptConcurrentPublication()
          : mode === "seed-materialized"
            ? await seedCandidate("SNAPSHOT_MATERIALIZED")
            : mode === "seed-candidate"
              ? await seedCandidate()
              : mode === "duplicate-delivery"
                ? await duplicateDelivery()
                : mode === "observe-candidate"
                  ? await observeCandidate()
                  : mode === "confirm"
                    ? await confirm()
                    : mode === "observe-official"
                      ? await observeOfficial()
                      : mode === "restore-live-failure"
                        ? await restoreAfterLiveFailure()
                        : mode === "manual-rollback"
                          ? await manualRollback()
                          : mode === "seed-rollback-committed"
                            ? await manualRollback(true)
                            : mode === "restore-rollback-live-failure"
                              ? await restoreRollbackAfterLiveFailure()
                              : mode === "resume-manual-rollback"
                                ? await resumeManualRollback()
                                : await status();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await database.$disconnect();
}
