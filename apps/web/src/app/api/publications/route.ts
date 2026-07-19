import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@situation-studio/db";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { audit } from "@/server/audit";

const schema = z.object({
  bundleId: z.string().uuid(),
  approvalId: z.string().uuid(),
  target: z.literal("protected-beta"),
});

export async function POST(request: NextRequest) {
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
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const key = request.headers.get("idempotency-key");
  if (!key || key.length > 120)
    return NextResponse.json(
      { error: "idempotency key required" },
      { status: 400 },
    );
  const bundle = await database().proposedBundle.findUnique({
    where: { id: parsed.data.bundleId },
    include: {
      approvals: { where: { id: parsed.data.approvalId, invalidatedAt: null } },
      validations: true,
      comments: { where: { status: "OPEN", blocking: true } },
    },
  });
  const approval = bundle?.approvals[0];
  const databaseBackend = environment().PUBLICATION_BACKEND === "database";
  const publicationTarget = databaseBackend
    ? await database().publicationTarget.findUnique({
        where: { code: "leadership-production" },
        include: { officialSnapshot: true },
      })
    : null;
  if (
    !bundle ||
    !approval ||
    bundle.state !== "APPROVED" ||
    approval.bundleHash !== bundle.canonicalHash ||
    approval.baseCommit !== bundle.baseCommit ||
    !approval.repositoryReviewerId ||
    !approval.contentReviewDate ||
    bundle.comments.length ||
    bundle.validations.some(
      (item) =>
        item.state !== "PASSED" || item.bundleHash !== bundle.canonicalHash,
    ) ||
    !bundle.validations.some(
      (item) =>
        item.validator === "human-review-provenance" &&
        item.state === "PASSED" &&
        item.bundleHash === bundle.canonicalHash,
    ) ||
    (databaseBackend &&
      (!publicationTarget?.officialSnapshot ||
        approval.baseContentSnapshotId !==
          publicationTarget.officialSnapshot.id ||
        approval.baseContentSnapshotHash !==
          publicationTarget.officialSnapshot.manifestHash ||
        bundle.baseContentSnapshotId !== publicationTarget.officialSnapshot.id))
  )
    return NextResponse.json(
      { error: "publication preconditions failed" },
      { status: 409 },
    );
  const existing = await database().publicationRequest.findUnique({
    where: {
      requestedById_idempotencyKey: {
        requestedById: auth.session.userId,
        idempotencyKey: key,
      },
    },
  });
  if (existing)
    return NextResponse.json({
      publicationRequestId: existing.id,
      state: existing.state,
      reused: true,
    });
  const fake =
    !databaseBackend && environment().PROVIDER_EXECUTION_MODE === "fake";
  const publicationUuid = randomUUID();
  let publicationRequest;
  let checkoutAcquired = false;
  try {
    publicationRequest = await database().$transaction(
      async (transaction) => {
        await transaction.$executeRaw`SELECT id FROM situations WHERE id = ${bundle.situationId}::uuid FOR UPDATE`;
        const now = new Date();
        let checkout = await transaction.situationCheckout.findFirst({
          where: { situationId: bundle.situationId, releasedAt: null },
        });
        if (
          checkout &&
          checkout.custody === "USER" &&
          checkout.expiresAt <= now
        ) {
          await transaction.situationCheckout.update({
            where: { id: checkout.id },
            data: { releasedAt: now, releaseReason: "LEASE_EXPIRED" },
          });
          await transaction.checkoutResource.updateMany({
            where: { checkoutId: checkout.id, releasedAt: null },
            data: { releasedAt: now },
          });
          checkout = null;
        }
        if (
          checkout &&
          (checkout.draftId !== bundle.draftId ||
            checkout.holderUserId !== auth.session.userId ||
            checkout.custody !== "USER" ||
            checkout.expiresAt <= now)
        )
          throw new Error("ACTIVE_PUBLISHER_CHECKOUT_UNAVAILABLE");
        const situation = await transaction.situation.update({
          where: { id: bundle.situationId },
          data: { fence: { increment: 1 } },
        });
        const row = await transaction.publicationRequest.create({
          data: {
            publicationUuid,
            idempotencyKey: key,
            targetEnvironment: parsed.data.target,
            bundleId: bundle.id,
            bundleHash: bundle.canonicalHash,
            approvalId: approval.id,
            baseCommit: bundle.baseCommit,
            publicationTargetId: publicationTarget?.id ?? null,
            baseContentSnapshotId:
              publicationTarget?.officialSnapshot?.id ?? null,
            baseContentSnapshotHash:
              publicationTarget?.officialSnapshot?.manifestHash ?? null,
            targetGeneration: publicationTarget?.generation ?? null,
            state: fake ? "AWAITING_CONFIRMATION" : "REQUESTED",
            currentStep: fake ? "PREVIEW_VERIFIED" : "REQUESTED",
            requestedById: auth.session.userId,
          },
        });
        const publisherLease = {
          custody: "PUBLISHER" as const,
          custodyReference: row.id,
          mode: "PUBLISHING" as const,
          fencingToken: situation.fence,
          transferReason: "PUBLICATION_STAGED",
          renewedAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        };
        if (checkout) {
          const transferred = await transaction.situationCheckout.updateMany({
            where: {
              id: checkout.id,
              fencingToken: checkout.fencingToken,
              custody: "USER",
              releasedAt: null,
            },
            data: publisherLease,
          });
          if (transferred.count !== 1)
            throw new Error("PUBLISHER_CHECKOUT_TRANSFER_LOST");
        } else {
          checkoutAcquired = true;
          const acquired = await transaction.situationCheckout.create({
            data: {
              situationId: bundle.situationId,
              holderUserId: auth.session.userId,
              draftId: bundle.draftId,
              acquiredAt: now,
              ...publisherLease,
            },
          });
          await transaction.checkoutResource.create({
            data: {
              checkoutId: acquired.id,
              situationId: bundle.situationId,
              resourceKey: `situation:${bundle.situationId}`,
              purpose: "PUBLISHING",
            },
          });
        }
        if (fake)
          for (const [index, step] of [
            "WORKTREE_READY",
            "APPLIED",
            "VALIDATED",
            "COMMITTED",
            "PUSHED",
            "PREVIEW_BUILT",
            "PREVIEW_VERIFIED",
          ].entries())
            await transaction.publicationStep.create({
              data: {
                requestId: row.id,
                step,
                attempt: 1,
                fence: BigInt(index + 1),
                externalId: `fake:${publicationUuid}:${step}`,
                state: "SUCCEEDED",
                inputHash: bundle.canonicalHash,
                outputHash: bundle.canonicalHash,
                finishedAt: new Date(),
              },
            });
        await transaction.draft.update({
          where: { id: bundle.draftId },
          data: { state: "PUBLISHING" },
        });
        return row;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await database().publicationRequest.findUnique({
        where: {
          requestedById_idempotencyKey: {
            requestedById: auth.session.userId,
            idempotencyKey: key,
          },
        },
      });
      if (raced)
        return NextResponse.json({
          publicationRequestId: raced.id,
          state: raced.state,
          reused: true,
        });
      return NextResponse.json(
        { error: "another publication is already being staged" },
        { status: 423 },
      );
    }
    if (
      error instanceof Error &&
      [
        "ACTIVE_PUBLISHER_CHECKOUT_UNAVAILABLE",
        "PUBLISHER_CHECKOUT_TRANSFER_LOST",
      ].includes(error.message)
    )
      return NextResponse.json(
        {
          error:
            error.message === "ACTIVE_PUBLISHER_CHECKOUT_UNAVAILABLE"
              ? "another checkout owns this situation"
              : "publisher checkout transfer failed",
        },
        {
          status:
            error.message === "ACTIVE_PUBLISHER_CHECKOUT_UNAVAILABLE"
              ? 423
              : 409,
        },
      );
    throw error;
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "publication.stage",
    targetType: "publication_request",
    targetId: publicationRequest.id,
    targetVersion: bundle.canonicalHash,
    outcome: "SUCCEEDED",
    after: {
      target: parsed.data.target,
      backend: databaseBackend ? "database" : "git",
      fake,
      checkoutAcquired,
    },
  });
  return NextResponse.json(
    {
      publicationRequestId: publicationRequest.id,
      state: publicationRequest.state,
    },
    { status: 201 },
  );
}
