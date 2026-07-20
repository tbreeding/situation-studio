import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "@situation-studio/db";
import {
  canonicalBundleHash,
  finalizeHumanReviewProvenance,
  sha256,
  type BundleManifest,
} from "@situation-studio/domain";
import { createReviewComment } from "../../../apps/web/src/server/workflows/review-comments";
import { prepareBundleForHumanApproval } from "../../../apps/web/src/server/workflows/review-provenance";

const databaseUrl = process.env.DATABASE_URL;
if (
  !databaseUrl ||
  !/situation_studio_(?:migration_test|full_validation|playwright)_/u.test(
    databaseUrl,
  )
)
  throw new Error(
    "Refusing failed-preview recovery acceptance outside a disposable database.",
  );

const database = createDatabaseClient(databaseUrl, 6);
const concurrentDatabase = createDatabaseClient(databaseUrl, 2);
const targetCode = "leadership-production";
const bootstrapManifestHash =
  "cb57e75893b6852d58b5ce9d2d82c4954e455bdaa09defde5e2b0cb6bc54ea8e";

type Fixture = {
  userId: string;
  reviewerId: string;
  reviewDate: string;
  draftId: string;
  parentBundleId: string;
  sourceBundleId: string;
  checkoutId: string | null;
  requestId: string;
};

async function ensureAcceptanceTarget() {
  const existing = await database.publicationTarget.findUnique({
    where: { code: targetCode },
    include: { officialSnapshot: true },
  });
  if (existing) {
    if (
      !existing.officialSnapshot ||
      existing.officialSnapshot.validationState !== "VALIDATED" ||
      existing.candidateSnapshotId ||
      existing.candidatePublicationRequestId ||
      existing.candidateRollbackRequestId
    )
      throw new Error("Recovery acceptance target is not clean.");
    return;
  }
  const officialSnapshot = await database.contentSnapshot.findUniqueOrThrow({
    where: { manifestHash: bootstrapManifestHash },
  });
  if (officialSnapshot.validationState !== "VALIDATED")
    throw new Error("Recovery acceptance snapshot is not validated.");
  await database.$transaction(async (transaction) => {
    const target = await transaction.publicationTarget.create({
      data: { code: targetCode },
    });
    await transaction.publicationTarget.update({
      where: { id: target.id },
      data: {
        officialSnapshotId: officialSnapshot.id,
        bootstrappedAt: new Date(),
        generation: { increment: 1 },
      },
    });
  });
}

async function seedFixture(input?: {
  mismatchedBase?: boolean;
  withCheckout?: boolean;
}): Promise<Fixture> {
  const target = await database.publicationTarget.findUniqueOrThrow({
    where: { code: targetCode },
    include: { officialSnapshot: true },
  });
  if (
    !target.officialSnapshot ||
    target.officialSnapshot.validationState !== "VALIDATED" ||
    target.candidateSnapshotId ||
    target.candidatePublicationRequestId ||
    target.candidateRollbackRequestId
  )
    throw new Error("Recovery acceptance target is not at a clean boundary.");
  const situation = await database.situation.findFirstOrThrow({
    where: { drafts: { none: { active: true } } },
  });
  const repository = await database.repositorySnapshot.findFirstOrThrow({
    orderBy: { createdAt: "desc" },
  });
  const officialArtifact =
    await database.contentSnapshotArtifact.findFirstOrThrow({
      where: {
        snapshotId: target.officialSnapshot.id,
        logicalId: `situation:${situation.slug}`,
      },
      include: { content: true },
    });
  const now = new Date();
  const reviewDate = now.toISOString().slice(0, 10);
  const reviewerId = `recovery-acceptance-${randomUUID()}`;
  const candidateBody = `${finalizeHumanReviewProvenance(
    officialArtifact.content.body,
    { reviewer: reviewerId, lastReviewed: reviewDate },
  )}\n\n## Recovery acceptance\n\nDescribe observable behavior and impact before assigning a label.`;
  const candidateHash = sha256(candidateBody);
  const baseHash = input?.mismatchedBase
    ? sha256(`mismatched-base:${randomUUID()}`)
    : officialArtifact.contentHash;
  const latestRevision =
    (
      await database.proposedBundle.aggregate({
        where: { situationId: situation.id },
        _max: { revision: true },
      })
    )._max.revision ?? 0;
  const parentRevision = latestRevision + 1;
  const sourceRevision = latestRevision + 2;
  const graphHash = sha256(`recovery-acceptance-graph:${randomUUID()}`);
  const sourceManifest: BundleManifest = {
    schemaVersion: "1",
    situationId: situation.id,
    revision: sourceRevision,
    baseCommit: repository.commitSha,
    baseManifestHash: repository.manifestHash,
    briefHash: null,
    graphHash,
    artifacts: [
      {
        logicalId: officialArtifact.logicalId,
        type: officialArtifact.artifactType,
        path: officialArtifact.canonicalPath,
        baseHash,
        candidateHash,
        changeKind: "MODIFY",
        noChangeRationale: null,
      },
    ],
    relationshipChanges: [],
  };
  const parentManifest: BundleManifest = {
    ...sourceManifest,
    revision: parentRevision,
  };
  const sourceHash = canonicalBundleHash(sourceManifest);
  const user = await database.user.create({
    data: {
      username: `recovery-${randomUUID().slice(0, 12)}`,
      displayName: "Failed Preview Recovery Acceptance",
      repositoryReviewerId: reviewerId,
      identityType: "HUMAN",
      state: "ACTIVE",
    },
  });
  const session = await database.session.create({
    data: {
      tokenHash: sha256(`recovery-token:${randomUUID()}`),
      userId: user.id,
      passwordVersion: user.passwordVersion,
      csrfSecretHash: sha256(`recovery-csrf:${randomUUID()}`),
      reauthenticatedAt: now,
      idleExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    },
  });
  return database.$transaction(
    async (transaction) => {
      await transaction.contentBlob.upsert({
        where: { hash: candidateHash },
        create: {
          hash: candidateHash,
          body: candidateBody,
          byteLength: Buffer.byteLength(candidateBody),
        },
        update: {},
      });
      const draft = await transaction.draft.create({
        data: {
          situationId: situation.id,
          baseSnapshotId: repository.id,
          state: "APPROVED",
        },
      });
      const parent = await transaction.proposedBundle.create({
        data: {
          situationId: situation.id,
          revision: parentRevision,
          snapshotId: repository.id,
          draftId: draft.id,
          baseCommit: repository.commitSha,
          baseManifestHash: repository.manifestHash,
          graphHash,
          canonicalHash: canonicalBundleHash(parentManifest),
          manifest: parentManifest,
          state: "STALE",
        },
      });
      const source = await transaction.proposedBundle.create({
        data: {
          situationId: situation.id,
          parentBundleId: parent.id,
          revision: sourceRevision,
          snapshotId: repository.id,
          draftId: draft.id,
          baseCommit: repository.commitSha,
          baseManifestHash: repository.manifestHash,
          graphHash,
          canonicalHash: sourceHash,
          manifest: sourceManifest,
          decisionLedger: {
            humanReviewProvenance: {
              repositoryReviewerId: reviewerId,
              reviewDate,
              preparedByUserId: user.id,
              preparedAt: now.toISOString(),
              parentBundleId: parent.id,
            },
          },
          state: "APPROVED",
        },
      });
      await transaction.bundleArtifact.create({
        data: {
          bundleId: source.id,
          artifactId: officialArtifact.artifactId,
          path: officialArtifact.canonicalPath,
          type: officialArtifact.artifactType,
          baseHash,
          candidateHash,
          contentHash: candidateHash,
          changeKind: "MODIFY",
        },
      });
      const environmentHash = sha256(`recovery-acceptance:${sourceHash}`);
      for (const validator of [
        "required-role-completion",
        "candidate-safety",
        "contradiction-audit",
        "human-review-provenance",
      ])
        await transaction.validationRun.create({
          data: {
            bundleId: source.id,
            bundleHash: sourceHash,
            validator,
            version: "recovery-acceptance-v1",
            environmentHash,
            state: "PASSED",
            summary: "Disposable failed-preview recovery evidence passed.",
            startedAt: now,
            finishedAt: now,
          },
        });
      const approval = await transaction.approval.create({
        data: {
          bundleId: source.id,
          bundleHash: sourceHash,
          baseCommit: repository.commitSha,
          validationPolicyHash: sha256("recovery-acceptance-policy"),
          approvedById: user.id,
          repositoryReviewerId: reviewerId,
          contentReviewDate: reviewDate,
          sessionId: session.id,
          permissionSnapshot: ["publication.approve", "publication.publish"],
        },
      });
      const request = await transaction.publicationRequest.create({
        data: {
          publicationUuid: randomUUID(),
          idempotencyKey: `recovery-${randomUUID()}`,
          targetEnvironment: "protected-beta",
          bundleId: source.id,
          bundleHash: sourceHash,
          approvalId: approval.id,
          baseCommit: repository.commitSha,
          state: "FAILED_PREVIEW",
          currentStep: "FAILED_PREVIEW",
          requestedById: user.id,
        },
      });
      let checkoutId: string | null = null;
      if (input?.withCheckout !== false) {
        const fenced = await transaction.situation.update({
          where: { id: situation.id },
          data: { fence: { increment: 1 } },
        });
        const checkout = await transaction.situationCheckout.create({
          data: {
            situationId: situation.id,
            holderUserId: user.id,
            mode: "EDITING",
            custody: "USER",
            draftId: draft.id,
            fencingToken: fenced.fence,
            expiresAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
          },
        });
        checkoutId = checkout.id;
      }
      return {
        userId: user.id,
        reviewerId,
        reviewDate,
        draftId: draft.id,
        parentBundleId: parent.id,
        sourceBundleId: source.id,
        checkoutId,
        requestId: request.id,
      };
    },
    { isolationLevel: "Serializable" },
  );
}

async function cleanupFixture(fixture: Fixture) {
  if (fixture.checkoutId)
    await database.situationCheckout.updateMany({
      where: { id: fixture.checkoutId, releasedAt: null },
      data: {
        releasedAt: new Date(),
        releaseReason: "RECOVERY_ACCEPTANCE_CLEANUP",
      },
    });
  const bundles = await database.proposedBundle.findMany({
    where: {
      OR: [
        { id: fixture.parentBundleId },
        { id: fixture.sourceBundleId },
        { parentBundleId: fixture.sourceBundleId },
      ],
    },
    select: { id: true },
  });
  await database.proposedBundle.updateMany({
    where: { id: { in: bundles.map((bundle) => bundle.id) } },
    data: { state: "STALE" },
  });
  await database.draft.update({
    where: { id: fixture.draftId },
    data: {
      active: false,
      staleReason: "Disposable failed-preview recovery acceptance completed.",
    },
  });
}

async function mustReject(operation: () => Promise<unknown>, label: string) {
  let rejected = false;
  try {
    await operation();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error(`${label} unexpectedly succeeded.`);
}

async function verifySuccessfulLegacyRecovery() {
  const fixture = await seedFixture();
  try {
    const nextDay = new Date();
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const result = await prepareBundleForHumanApproval(database, {
      bundleId: fixture.sourceBundleId,
      userId: fixture.userId,
      repositoryReviewerId: fixture.reviewerId,
      recoveryTargetCode: targetCode,
      now: nextDay,
    });
    const target = await database.publicationTarget.findUniqueOrThrow({
      where: { code: targetCode },
      include: { officialSnapshot: true },
    });
    const child = await database.proposedBundle.findUniqueOrThrow({
      where: { id: result.bundle.id },
      include: {
        validations: true,
        draft: true,
        artifacts: { orderBy: { artifactId: "asc" } },
      },
    });
    const source = await database.proposedBundle.findUniqueOrThrow({
      where: { id: fixture.sourceBundleId },
      include: {
        publicationRequests: true,
        artifacts: { orderBy: { artifactId: "asc" } },
      },
    });
    const ledger = child.decisionLedger as {
      databaseFailedPreviewRecovery?: {
        recoveredFromRequestId?: string;
        publicationTargetId?: string;
        baseContentSnapshotId?: string;
        baseContentSnapshotHash?: string;
      };
    } | null;
    const recoveryLedger = ledger?.databaseFailedPreviewRecovery;
    const exactArtifactsPreserved =
      child.artifacts.length === source.artifacts.length &&
      child.artifacts.every((artifact, index) => {
        const prior = source.artifacts[index];
        return (
          prior !== undefined &&
          artifact.artifactId === prior.artifactId &&
          artifact.path === prior.path &&
          artifact.type === prior.type &&
          artifact.baseHash === prior.baseHash &&
          artifact.candidateHash === prior.candidateHash &&
          artifact.contentHash === prior.contentHash &&
          artifact.changeKind === prior.changeKind &&
          artifact.noChangeRationale === prior.noChangeRationale
        );
      });
    const exactValidators = child.validations
      .map((validation) => validation.validator)
      .sort();
    if (
      !result.recovered ||
      !result.created ||
      child.state !== "HUMAN_REVIEW" ||
      child.parentBundleId !== fixture.sourceBundleId ||
      result.provenance.parentBundleId !== fixture.sourceBundleId ||
      result.provenance.reviewDate !== fixture.reviewDate ||
      child.baseContentSnapshotId !== target.officialSnapshotId ||
      child.draft.state !== "HUMAN_REVIEW" ||
      child.validations.length !== 5 ||
      exactValidators.join(",") !==
        [
          "candidate-safety",
          "contradiction-audit",
          "database-base-recovery",
          "human-review-provenance",
          "required-role-completion",
        ].join(",") ||
      child.validations.some(
        (validation) =>
          validation.state !== "PASSED" ||
          validation.bundleHash !== child.canonicalHash,
      ) ||
      !exactArtifactsPreserved ||
      source.state !== "STALE" ||
      source.publicationRequests[0]?.id !== fixture.requestId ||
      source.publicationRequests[0]?.state !== "FAILED_PREVIEW" ||
      recoveryLedger?.recoveredFromRequestId !== fixture.requestId ||
      recoveryLedger?.publicationTargetId !== target.id ||
      recoveryLedger?.baseContentSnapshotId !== target.officialSnapshotId ||
      recoveryLedger?.baseContentSnapshotHash !==
        target.officialSnapshot?.manifestHash
    )
      throw new Error("Successful legacy recovery invariants failed.");
    await mustReject(
      () =>
        prepareBundleForHumanApproval(database, {
          bundleId: fixture.sourceBundleId,
          userId: fixture.userId,
          repositoryReviewerId: fixture.reviewerId,
          recoveryTargetCode: targetCode,
        }),
      "Double recovery",
    );
    await mustReject(
      () =>
        createReviewComment(database, {
          bundleId: fixture.sourceBundleId,
          authorId: fixture.userId,
          body: "This stale parent must reject new feedback.",
          blocking: true,
        }),
      "Comment on recovered stale parent",
    );
    return child.id;
  } finally {
    await cleanupFixture(fixture);
  }
}

async function verifyDeterministicCommentFirst() {
  const fixture = await seedFixture();
  try {
    await createReviewComment(database, {
      bundleId: fixture.sourceBundleId,
      authorId: fixture.userId,
      body: "Deterministic comment-first feedback must block recovery.",
      blocking: true,
    });
    await mustReject(
      () =>
        prepareBundleForHumanApproval(database, {
          bundleId: fixture.sourceBundleId,
          userId: fixture.userId,
          repositoryReviewerId: fixture.reviewerId,
          recoveryTargetCode: targetCode,
        }),
      "Comment-first recovery",
    );
    const source = await database.proposedBundle.findUniqueOrThrow({
      where: { id: fixture.sourceBundleId },
      include: {
        comments: { where: { status: "OPEN", blocking: true } },
        approvals: true,
        childBundles: { where: { state: "HUMAN_REVIEW" } },
      },
    });
    if (
      source.state !== "HUMAN_REVIEW" ||
      source.comments.length !== 1 ||
      source.childBundles.length !== 0 ||
      source.approvals.length !== 1 ||
      !source.approvals[0]?.invalidatedAt ||
      source.approvals[0].invalidationReason !== "BLOCKING_COMMENT_ADDED"
    )
      throw new Error("Deterministic comment-first invariants failed.");
  } finally {
    await cleanupFixture(fixture);
  }
}

async function verifyRecoveryCommentRace() {
  const fixture = await seedFixture();
  try {
    const [recovery, comment] = await Promise.allSettled([
      prepareBundleForHumanApproval(database, {
        bundleId: fixture.sourceBundleId,
        userId: fixture.userId,
        repositoryReviewerId: fixture.reviewerId,
        recoveryTargetCode: targetCode,
      }),
      createReviewComment(concurrentDatabase, {
        bundleId: fixture.sourceBundleId,
        authorId: fixture.userId,
        body: "Concurrent blocking review feedback must never be lost.",
        blocking: true,
      }),
    ]);
    if (
      [recovery, comment].filter((result) => result.status === "fulfilled")
        .length !== 1
    )
      throw new Error("Recovery/comment race did not produce one winner.");
    const source = await database.proposedBundle.findUniqueOrThrow({
      where: { id: fixture.sourceBundleId },
      include: {
        comments: { where: { status: "OPEN", blocking: true } },
        approvals: { where: { invalidatedAt: null } },
        childBundles: { where: { state: "HUMAN_REVIEW" } },
      },
    });
    if (recovery.status === "fulfilled") {
      if (
        source.state !== "STALE" ||
        source.comments.length !== 0 ||
        source.childBundles.length !== 1
      )
        throw new Error("Recovery-winning comment race lost invariants.");
      return "recovery";
    }
    if (
      source.state !== "HUMAN_REVIEW" ||
      source.comments.length !== 1 ||
      source.approvals.length !== 0 ||
      source.childBundles.length !== 0
    )
      throw new Error("Comment-winning recovery race lost feedback.");
    return "comment";
  } finally {
    await cleanupFixture(fixture);
  }
}

async function verifyRejectedPreconditions() {
  const mismatched = await seedFixture({ mismatchedBase: true });
  try {
    await mustReject(
      () =>
        prepareBundleForHumanApproval(database, {
          bundleId: mismatched.sourceBundleId,
          userId: mismatched.userId,
          repositoryReviewerId: mismatched.reviewerId,
          recoveryTargetCode: targetCode,
        }),
      "Mismatched affected base",
    );
  } finally {
    await cleanupFixture(mismatched);
  }

  const missingCheckout = await seedFixture({ withCheckout: false });
  try {
    await mustReject(
      () =>
        prepareBundleForHumanApproval(database, {
          bundleId: missingCheckout.sourceBundleId,
          userId: missingCheckout.userId,
          repositoryReviewerId: missingCheckout.reviewerId,
          recoveryTargetCode: targetCode,
        }),
      "Missing checkout",
    );
  } finally {
    await cleanupFixture(missingCheckout);
  }

  const frozen = await seedFixture();
  const freezeOwner = await seedFixture();
  try {
    const target = await database.publicationTarget.findUniqueOrThrow({
      where: { code: targetCode },
    });
    await database.publicationRequest.update({
      where: { id: freezeOwner.requestId },
      data: {
        publicationTargetId: target.id,
        baseContentSnapshotId: target.officialSnapshotId,
        baseContentSnapshotHash: (
          await database.contentSnapshot.findUniqueOrThrow({
            where: { id: target.officialSnapshotId ?? "" },
          })
        ).manifestHash,
        targetGeneration: target.generation,
        state: "RECONCILIATION_REQUIRED",
        currentStep: "RECONCILIATION_REQUIRED",
      },
    });
    await mustReject(
      () =>
        prepareBundleForHumanApproval(database, {
          bundleId: frozen.sourceBundleId,
          userId: frozen.userId,
          repositoryReviewerId: frozen.reviewerId,
          recoveryTargetCode: targetCode,
        }),
      "Reconciliation-frozen target",
    );
  } finally {
    await database.publicationRequest.update({
      where: { id: freezeOwner.requestId },
      data: { state: "FAILED_PREVIEW", currentStep: "ACCEPTANCE_CLEANUP" },
    });
    await cleanupFixture(freezeOwner);
    await cleanupFixture(frozen);
  }
}

try {
  await ensureAcceptanceTarget();
  const recoveredBundleId = await verifySuccessfulLegacyRecovery();
  const raceWinner = await verifyRecoveryCommentRace();
  await verifyDeterministicCommentFirst();
  await verifyRejectedPreconditions();
  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      recoveredBundleId,
      raceWinner,
      deterministicCommentFirst: true,
      preservedLegacyRequest: true,
      doubleRecoveryRejected: true,
      staleParentCommentRejected: true,
      mismatchedBaseRejected: true,
      missingCheckoutRejected: true,
      reconciliationFreezeRejected: true,
    })}\n`,
  );
} finally {
  await Promise.all([database.$disconnect(), concurrentDatabase.$disconnect()]);
}
