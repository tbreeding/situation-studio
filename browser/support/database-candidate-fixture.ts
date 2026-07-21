import { randomUUID } from "node:crypto";
import {
  canonicalArtifactBytes,
  canonicalJson,
  sha256,
  validationPolicyHash,
} from "../../packages/content-contracts/src/index";
import { createDatabaseClient } from "../../packages/db/src/client";
import {
  failDatabasePublicationBeforeConfirmation,
  processDatabasePublication,
} from "../../apps/publisher/src/database-service";

export const browserCandidateFixtureKey =
  "playwright-private-candidate-handoff-v1";
export const browserCandidateSituationSlug = "make-bad-attitude-specific";
export const browserCandidateFailureReason =
  "No-change artifact practice:feedback-fork changed identity.";

function assertDisposableDatabase(databaseUrl: string) {
  const databaseName = decodeURIComponent(
    new URL(databaseUrl).pathname.slice(1),
  );
  if (!databaseName.startsWith("situation_studio_migration_test_playwright_"))
    throw new Error(
      "Refusing private-candidate fixture outside the Testcontainers database.",
    );
}

export async function seedDatabaseCandidateFixture(databaseUrl: string) {
  assertDisposableDatabase(databaseUrl);

  const database = createDatabaseClient(databaseUrl, 3);
  const materializerUrl = new URL(databaseUrl);
  materializerUrl.searchParams.set(
    "options",
    "-c role=situation_studio_materializer",
  );
  const materializer = createDatabaseClient(materializerUrl.toString(), 3);
  try {
    const existing = await database.publicationRequest.findFirst({
      where: { idempotencyKey: browserCandidateFixtureKey },
      include: {
        databasePublication: true,
        publicationTarget: { include: { officialSnapshot: true } },
      },
    });
    if (existing?.databasePublication?.candidateSnapshotId) {
      return {
        requestId: existing.id,
        candidateSnapshotId: existing.databasePublication.candidateSnapshotId,
        candidateSnapshotHash: existing.candidateContentSnapshotHash as string,
        officialSnapshotId: existing.publicationTarget
          ?.officialSnapshotId as string,
        officialSnapshotHash: existing.publicationTarget?.officialSnapshot
          ?.manifestHash as string,
        situationSlug: browserCandidateSituationSlug,
      };
    }

    const target = await database.publicationTarget.findUniqueOrThrow({
      where: { code: "leadership-production" },
      include: {
        officialSnapshot: {
          include: {
            artifacts: {
              where: {
                logicalId: `situation:${browserCandidateSituationSlug}`,
              },
              include: { artifact: true, content: true },
            },
          },
        },
      },
    });
    const official = target.officialSnapshot;
    const member = official?.artifacts[0];
    if (!official || !member || target.candidateSnapshotId)
      throw new Error("A clean bootstrapped official snapshot is required.");

    const candidateBody = member.content.body.replace(
      /^(title:\s*[^\n]+)$/mu,
      "$1 — private candidate E2E",
    );
    if (candidateBody === member.content.body)
      throw new Error(
        "Candidate fixture could not change the situation title.",
      );
    const canonical = canonicalArtifactBytes(
      member.canonicalPath,
      new TextEncoder().encode(candidateBody),
    );
    const candidateContentHash = sha256(canonical.bytes);
    const repository = await database.repositorySnapshot.findFirstOrThrow({
      orderBy: { createdAt: "desc" },
    });
    const situation = await database.situation.findUniqueOrThrow({
      where: { slug: browserCandidateSituationSlug },
    });
    const admin = await database.user.findUniqueOrThrow({
      where: { username: "studio-admin" },
    });
    if (!admin.repositoryReviewerId)
      throw new Error("The browser administrator lacks reviewer identity.");
    const revision =
      (
        await database.proposedBundle.aggregate({
          where: { situationId: situation.id },
          _max: { revision: true },
        })
      )._max.revision ?? 0;

    await database.contentBlob.upsert({
      where: { hash: candidateContentHash },
      create: {
        hash: candidateContentHash,
        body: new TextDecoder().decode(canonical.bytes),
        encoding: "UTF8",
        byteLength: canonical.bytes.byteLength,
      },
      update: {},
    });
    const draft = await database.draft.create({
      data: {
        situationId: situation.id,
        baseSnapshotId: repository.id,
        state: "APPROVED",
      },
    });
    const manifest = {
      schemaVersion: "private-candidate-browser-e2e-v1",
      baseSnapshotHash: official.manifestHash,
      changes: [
        {
          logicalId: member.logicalId,
          path: member.canonicalPath,
          baseHash: member.contentHash,
          candidateHash: candidateContentHash,
          changeKind: "MODIFY",
        },
      ],
    };
    const bundleHash = sha256(canonicalJson(manifest));
    const bundle = await database.proposedBundle.create({
      data: {
        situationId: situation.id,
        revision: revision + 1,
        snapshotId: repository.id,
        draftId: draft.id,
        baseCommit: repository.commitSha,
        baseContentSnapshotId: official.id,
        baseManifestHash: repository.manifestHash,
        graphHash: sha256(`browser-graph:${official.manifestHash}`),
        canonicalHash: bundleHash,
        manifest,
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
        candidateHash: candidateContentHash,
        contentHash: candidateContentHash,
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
          version: "private-candidate-browser-e2e-v1",
          environmentHash: sha256(`${validator}:browser-e2e`),
          state: "PASSED",
          summary: "Disposable private-candidate browser evidence",
          outputHash: sha256(`${validator}:${bundleHash}`),
          startedAt: new Date(),
          finishedAt: new Date(),
        },
      });
    const approvalSession = await database.session.create({
      data: {
        tokenHash: sha256(randomUUID()),
        userId: admin.id,
        passwordVersion: admin.passwordVersion,
        csrfSecretHash: sha256(randomUUID()),
        reauthenticatedAt: new Date(),
        idleExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        absoluteExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      },
    });
    const approval = await database.approval.create({
      data: {
        bundleId: bundle.id,
        bundleHash,
        baseCommit: repository.commitSha,
        baseContentSnapshotId: official.id,
        baseContentSnapshotHash: official.manifestHash,
        validationPolicyHash,
        approvedById: admin.id,
        repositoryReviewerId: admin.repositoryReviewerId,
        contentReviewDate: new Date().toISOString().slice(0, 10),
        sessionId: approvalSession.id,
        permissionSnapshot: ["publication.approve", "publication.publish"],
      },
    });
    const request = await database.publicationRequest.create({
      data: {
        publicationUuid: randomUUID(),
        idempotencyKey: browserCandidateFixtureKey,
        targetEnvironment: "protected-beta",
        publicationTargetId: target.id,
        bundleId: bundle.id,
        bundleHash,
        approvalId: approval.id,
        baseCommit: repository.commitSha,
        baseContentSnapshotId: official.id,
        baseContentSnapshotHash: official.manifestHash,
        targetGeneration: target.generation,
        requestedById: admin.id,
      },
    });
    const result = await processDatabasePublication(materializer, request.id);
    if (
      result.state !== "CANDIDATE_AVAILABLE" ||
      !result.snapshotId ||
      !result.snapshotHash
    )
      throw new Error(`Candidate fixture stopped at ${result.state}.`);
    return {
      requestId: request.id,
      candidateSnapshotId: result.snapshotId,
      candidateSnapshotHash: result.snapshotHash,
      officialSnapshotId: official.id,
      officialSnapshotHash: official.manifestHash,
      situationSlug: browserCandidateSituationSlug,
    };
  } finally {
    await Promise.all([database.$disconnect(), materializer.$disconnect()]);
  }
}

export async function failBrowserCandidateFixture(databaseUrl: string) {
  assertDisposableDatabase(databaseUrl);
  const database = createDatabaseClient(databaseUrl, 3);
  const materializerUrl = new URL(databaseUrl);
  materializerUrl.searchParams.set(
    "options",
    "-c role=situation_studio_materializer",
  );
  const materializer = createDatabaseClient(materializerUrl.toString(), 3);
  try {
    const request = await database.publicationRequest.findFirstOrThrow({
      where: { idempotencyKey: browserCandidateFixtureKey },
      include: { databasePublication: true },
    });
    if (request.state !== "FAILED_PREVIEW")
      await failDatabasePublicationBeforeConfirmation(
        materializer,
        request.id,
        browserCandidateFailureReason,
      );
    const failed = await database.publicationRequest.findUniqueOrThrow({
      where: { id: request.id },
      include: {
        databasePublication: true,
        publicationTarget: true,
      },
    });
    if (
      failed.state !== "FAILED_PREVIEW" ||
      failed.databasePublication?.state !== "FAILED_PREVIEW" ||
      failed.databasePublication.terminalOutcome !==
        "FAILED_BEFORE_CONFIRMATION" ||
      failed.publicationTarget?.candidateSnapshotId ||
      failed.publicationTarget?.candidatePublicationRequestId
    )
      throw new Error("Failed-preview browser fixture is inconsistent.");
    return {
      requestId: failed.id,
      situationSlug: browserCandidateSituationSlug,
      reason: browserCandidateFailureReason,
    };
  } finally {
    await Promise.all([database.$disconnect(), materializer.$disconnect()]);
  }
}
