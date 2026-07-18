import { NextResponse, type NextRequest } from "next/server";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { sha256 } from "@situation-studio/domain";
import { audit } from "@/server/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "publication.publish");
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
  const { id } = await params;
  const publicationRequest = await database().publicationRequest.findUnique({
    where: { id },
    include: {
      publication: true,
      bundle: { include: { draft: true, artifacts: true } },
    },
  });
  if (
    publicationRequest?.state === "RECONCILED" &&
    publicationRequest.requestedById === auth.session.userId &&
    publicationRequest.publication
  )
    return NextResponse.json({
      state: "RECONCILED",
      publicationId: publicationRequest.publication.id,
      commitSha: publicationRequest.publication.commitSha,
      reused: true,
    });
  if (
    !publicationRequest ||
    publicationRequest.state !== "AWAITING_CONFIRMATION" ||
    publicationRequest.requestedById !== auth.session.userId
  )
    return NextResponse.json(
      { error: "confirmation preconditions failed" },
      { status: 409 },
    );
  if (environment().PROVIDER_EXECUTION_MODE !== "fake") {
    await database().publicationRequest.update({
      where: { id },
      data: { finalConfirmedAt: new Date() },
    });
    return NextResponse.json({ state: "AWAITING_PUBLISHER" });
  }
  const now = new Date();
  const commitSha = sha256(publicationRequest.publicationUuid).slice(0, 40);
  let publication;
  try {
    publication = await database().$transaction(
      async (transaction) => {
        const previous = await transaction.situation.findUniqueOrThrow({
          where: { id: publicationRequest.bundle.situationId },
        });
        const version = await transaction.situationVersion.create({
          data: {
            situationId: publicationRequest.bundle.situationId,
            sourceKind: "PUBLICATION",
            snapshotId: publicationRequest.bundle.snapshotId,
            manifestHash: publicationRequest.bundleHash,
            bundleHash: publicationRequest.bundleHash,
            actorId: auth.session.userId,
            aiJobId: publicationRequest.bundle.aiJobId,
          },
        });
        for (const artifact of publicationRequest.bundle.artifacts.filter(
          (item) => item.changeKind !== "DELETE",
        )) {
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
        }
        const row = await transaction.publication.create({
          data: {
            situationId: publicationRequest.bundle.situationId,
            bundleId: publicationRequest.bundleId,
            requestId: publicationRequest.id,
            versionId: version.id,
            kind: "STUDIO_PUBLICATION",
            commitSha,
            manifestHash: publicationRequest.bundleHash,
            releaseId: `fake-release:${publicationRequest.publicationUuid}`,
            previewReleaseId: `fake-preview:${publicationRequest.publicationUuid}`,
            previousPublicationId: previous.currentPublicationId,
            publishedById: auth.session.userId,
            cutoverAt: now,
            healthState: "VERIFIED_FAKE_ACCEPTANCE",
          },
        });
        await transaction.situation.update({
          where: { id: publicationRequest.bundle.situationId },
          data: {
            currentPublicationId: row.id,
            publicationState: "PUBLISHED",
            lifecycle: "ACTIVE",
          },
        });
        await transaction.publicationRequest.update({
          where: { id },
          data: {
            state: "RECONCILED",
            currentStep: "RECONCILED",
            finalConfirmedAt: now,
          },
        });
        await transaction.proposedBundle.update({
          where: { id: publicationRequest.bundleId },
          data: { state: "PUBLISHED" },
        });
        await transaction.draft.update({
          where: { id: publicationRequest.bundle.draftId },
          data: { state: "PUBLISHED", active: false },
        });
        const checkout = await transaction.situationCheckout.findFirst({
          where: {
            situationId: publicationRequest.bundle.situationId,
            releasedAt: null,
          },
        });
        if (checkout) {
          await transaction.situationCheckout.update({
            where: { id: checkout.id },
            data: { releasedAt: now, releaseReason: "PUBLICATION_SUCCEEDED" },
          });
          await transaction.checkoutResource.updateMany({
            where: { checkoutId: checkout.id, releasedAt: null },
            data: { releasedAt: now },
          });
        }
        return row;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const concurrentReplay = await database().publicationRequest.findUnique({
      where: { id },
      include: { publication: true },
    });
    if (
      concurrentReplay?.state === "RECONCILED" &&
      concurrentReplay.requestedById === auth.session.userId &&
      concurrentReplay.publication
    )
      return NextResponse.json({
        state: "RECONCILED",
        publicationId: concurrentReplay.publication.id,
        commitSha: concurrentReplay.publication.commitSha,
        reused: true,
      });
    throw error;
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "publication.confirm_and_cutover",
    targetType: "publication",
    targetId: publication.id,
    targetVersion: publicationRequest.bundleHash,
    outcome: "SUCCEEDED",
    after: { commitSha, releaseId: publication.releaseId, fake: true },
  });
  return NextResponse.json({
    state: "RECONCILED",
    publicationId: publication.id,
    commitSha,
  });
}
