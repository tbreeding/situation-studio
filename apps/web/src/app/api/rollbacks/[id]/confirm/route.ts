import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";
import { Prisma } from "@situation-studio/db";

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
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await params);
  if (!parsed.success)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const rollback = await database().rollbackRequest.findUnique({
    where: { id: parsed.data.id },
    include: {
      databasePublication: { include: { confirmation: true } },
      publicationTarget: true,
      targetContentSnapshot: true,
    },
  });
  if (
    rollback?.databasePublication?.confirmation &&
    rollback.requestedById === auth.session.userId
  )
    return NextResponse.json({
      state:
        rollback.state === "RECONCILED" ? "RECONCILED" : "AWAITING_PUBLISHER",
      confirmationId: rollback.databasePublication.confirmation.id,
      reused: true,
    });
  const publication = rollback?.databasePublication;
  const target = rollback?.publicationTarget;
  const snapshot = rollback?.targetContentSnapshot;
  if (
    !rollback ||
    rollback.requestedById !== auth.session.userId ||
    rollback.state !== "AWAITING_CONFIRMATION" ||
    publication?.state !== "AWAITING_CONFIRMATION" ||
    !publication.candidateSnapshotId ||
    !target ||
    !snapshot ||
    target.candidateSnapshotId !== snapshot.id ||
    target.candidateRollbackRequestId !== rollback.id
  )
    return NextResponse.json(
      { error: "confirmation preconditions failed" },
      { status: 409 },
    );
  let confirmation;
  let reused = false;
  try {
    confirmation = await database().publicationConfirmation.create({
      data: {
        rollbackRequestId: rollback.id,
        targetId: target.id,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.manifestHash,
        confirmedById: auth.session.userId,
        sessionId: auth.session.id,
        validationPolicyHash: snapshot.validationPolicyHash,
        targetGeneration: target.generation,
        recentAuthenticationAt: auth.session.reauthenticatedAt,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      confirmation = await database().publicationConfirmation.findUniqueOrThrow(
        {
          where: { rollbackRequestId: rollback.id },
        },
      );
      reused = true;
    } else throw error;
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "rollback.confirm_candidate",
    targetType: "publication_confirmation",
    targetId: confirmation.id,
    targetVersion: snapshot.manifestHash,
    outcome: "SUCCEEDED",
    after: {
      rollbackRequestId: rollback.id,
      targetGeneration: target.generation.toString(),
    },
  });
  return NextResponse.json({
    state: "AWAITING_PUBLISHER",
    confirmationId: confirmation.id,
    reused,
  });
}
