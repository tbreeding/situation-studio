import { NextResponse, type NextRequest } from "next/server";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import {
  bundleManifestSchema,
  canonicalBundleHash,
  sha256,
} from "@situation-studio/domain";
import { audit } from "@/server/audit";
import {
  exactArtifactsMatchReviewProvenance,
  exactArtifactsMatchStoredHashes,
  readPreparedReviewProvenance,
} from "@/server/workflows/review-provenance";
import { validationPolicyHash as databaseValidationPolicyHash } from "@situation-studio/content-contracts";
import { environment } from "@/server/environment";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "publication.approve");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  if (
    !auth.session.reauthenticatedAt ||
    auth.session.reauthenticatedAt.getTime() < Date.now() - 15 * 60 * 1000
  )
    return NextResponse.json(
      { error: "recent reauthentication required" },
      { status: 403 },
    );
  const repositoryReviewerId = auth.session.user.repositoryReviewerId;
  if (!repositoryReviewerId)
    return NextResponse.json(
      { error: "repository reviewer identity required" },
      { status: 409 },
    );
  const { id } = await params;
  let result;
  try {
    result = await database().$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT id FROM proposed_bundles WHERE id = ${id}::uuid FOR UPDATE`;
        const bundle = await transaction.proposedBundle.findUnique({
          where: { id },
          include: {
            artifacts: { include: { content: true } },
            validations: true,
            comments: { where: { status: "OPEN", blocking: true } },
            draft: true,
          },
        });
        const provenance = readPreparedReviewProvenance(bundle?.decisionLedger);
        const provenanceValidation = bundle?.validations.some(
          (item) =>
            item.validator === "human-review-provenance" &&
            item.state === "PASSED" &&
            item.bundleHash === bundle.canonicalHash,
        );
        const canonicalManifest = bundleManifestSchema.safeParse(
          bundle?.manifest,
        );
        const databaseBackend =
          environment().PUBLICATION_BACKEND === "database";
        const publicationTarget = databaseBackend
          ? await transaction.publicationTarget.findUnique({
              where: { code: "leadership-production" },
              include: { officialSnapshot: true },
            })
          : null;
        if (
          !bundle ||
          bundle.state !== "HUMAN_REVIEW" ||
          bundle.comments.length ||
          !bundle.validations.length ||
          bundle.validations.some(
            (item) =>
              item.state !== "PASSED" ||
              item.bundleHash !== bundle.canonicalHash,
          ) ||
          bundle.draft.staleReason ||
          !provenance ||
          !provenanceValidation ||
          !canonicalManifest.success ||
          canonicalBundleHash(canonicalManifest.data) !==
            bundle.canonicalHash ||
          provenance.repositoryReviewerId !== repositoryReviewerId ||
          provenance.preparedByUserId !== auth.session.userId ||
          provenance.parentBundleId !== bundle.parentBundleId ||
          !exactArtifactsMatchReviewProvenance(bundle.artifacts, provenance) ||
          !exactArtifactsMatchStoredHashes(bundle.artifacts) ||
          (databaseBackend &&
            (!publicationTarget?.officialSnapshot ||
              (bundle.baseContentSnapshotId !== null &&
                bundle.baseContentSnapshotId !==
                  publicationTarget.officialSnapshot.id)))
        )
          throw new Error("APPROVAL_PRECONDITIONS_FAILED");
        const policyHash = databaseBackend
          ? databaseValidationPolicyHash
          : sha256(
              JSON.stringify(
                bundle.validations
                  .map((item) => [
                    item.validator,
                    item.version,
                    item.environmentHash,
                  ])
                  .sort(),
              ),
            );
        if (databaseBackend && !bundle.baseContentSnapshotId)
          await transaction.proposedBundle.update({
            where: { id: bundle.id },
            data: {
              baseContentSnapshotId:
                publicationTarget?.officialSnapshot?.id ?? null,
            },
          });
        const approval = await transaction.approval.create({
          data: {
            bundleId: bundle.id,
            bundleHash: bundle.canonicalHash,
            baseCommit: bundle.baseCommit,
            baseContentSnapshotId:
              publicationTarget?.officialSnapshot?.id ?? null,
            baseContentSnapshotHash:
              publicationTarget?.officialSnapshot?.manifestHash ?? null,
            validationPolicyHash: policyHash,
            approvedById: auth.session.userId,
            repositoryReviewerId,
            contentReviewDate: provenance.reviewDate,
            sessionId: auth.session.id,
            permissionSnapshot: [...auth.session.permissions],
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
        return { approval, bundle, policyHash, provenance };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "APPROVAL_PRECONDITIONS_FAILED";
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "bundle.approve",
      targetType: "bundle",
      targetId: id,
      outcome: "FAILED",
      reason,
    });
    return NextResponse.json(
      { error: "approval preconditions failed" },
      { status: 409 },
    );
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "bundle.approve",
    targetType: "bundle",
    targetId: result.bundle.id,
    targetVersion: result.bundle.canonicalHash,
    outcome: "SUCCEEDED",
    after: {
      approvalId: result.approval.id,
      baseCommit: result.bundle.baseCommit,
      validationPolicyHash: result.policyHash,
      repositoryReviewerId,
      contentReviewDate: result.provenance.reviewDate,
    },
  });
  return NextResponse.json({ approvalId: result.approval.id });
}
