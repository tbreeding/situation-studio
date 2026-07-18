import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "ai.run");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const { id } = await params;
  const job = await database().aiJob.findUnique({ where: { id } });
  if (
    !job ||
    (job.ownerId !== auth.session.userId &&
      !auth.session.permissions.has("system.admin"))
  )
    return NextResponse.json({ error: "not found" }, { status: 404 });
  if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.state))
    return NextResponse.json({ jobId: job.id, state: job.state, reused: true });

  if (job.state === "RUNNING" || job.state === "CANCELLING") {
    const updated = await database().aiJob.update({
      where: { id: job.id },
      data: {
        state: "CANCELLING",
        stage: "Cancellation requested; stopping the active provider attempt",
        cancellationReason: "USER_REQUESTED",
      },
    });
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "ai.full_review.cancel_request",
      targetType: "ai_job",
      targetId: job.id,
      outcome: "SUCCEEDED",
    });
    return NextResponse.json({ jobId: updated.id, state: updated.state });
  }

  const updated = await database().$transaction(
    async (transaction) => {
      const cancelled = await transaction.aiJob.updateMany({
        where: {
          id: job.id,
          state: { in: ["QUEUED", "RETRY_SCHEDULED"] },
        },
        data: {
          state: "CANCELLED",
          stage: "Cancelled before provider execution",
          cancellationReason: "USER_REQUESTED",
          finishedAt: new Date(),
        },
      });
      if (cancelled.count !== 1) throw new Error("JOB_STATE_CHANGED");
      await transaction.$executeRaw`SELECT id FROM situations WHERE id = ${job.situationId}::uuid FOR UPDATE`;
      const situation = await transaction.situation.update({
        where: { id: job.situationId },
        data: { fence: { increment: 1 } },
      });
      const checkout = await transaction.situationCheckout.updateMany({
        where: {
          situationId: job.situationId,
          custody: "AI_JOB",
          custodyReference: job.id,
          releasedAt: null,
        },
        data: {
          holderUserId: job.ownerId,
          custody: "USER",
          custodyReference: null,
          mode: "EDITING",
          fencingToken: situation.fence,
          transferReason: "AI_JOB_CANCELLED",
          renewedAt: new Date(),
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
      if (checkout.count !== 1) throw new Error("AI_CHECKOUT_CUSTODY_LOST");
      await transaction.draft.update({
        where: { id: job.draftId },
        data: { state: "DRAFTING" },
      });
      return transaction.aiJob.findUniqueOrThrow({ where: { id: job.id } });
    },
    { isolationLevel: "Serializable" },
  );
  await database().auditEvent.create({
    data: {
      actorType: "HUMAN",
      actorId: auth.session.userId,
      permissionSnapshot: [...auth.session.permissions],
      action: "ai.full_review.cancel",
      targetType: "ai_job",
      targetId: job.id,
      correlationId: randomUUID(),
      outcome: "SUCCEEDED",
    },
  });
  return NextResponse.json({ jobId: updated.id, state: updated.state });
}
