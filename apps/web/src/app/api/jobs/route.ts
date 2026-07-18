import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { runDeterministicReview } from "@/server/workflows/fake-review";
import { audit } from "@/server/audit";
import {
  LEADERSHIP_REVIEW_WORKFLOW_VERSION,
  MODEL_POLICY,
  sha256,
} from "@situation-studio/domain";

const schema = z.object({
  situationId: z.string().uuid(),
  draftId: z.string().uuid(),
  checkoutId: z.string().uuid(),
  fencingToken: z.string().regex(/^\d+$/u),
});

export async function POST(request: NextRequest) {
  const auth = await authenticateMutation(request, "ai.run");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 120)
    return NextResponse.json(
      { error: "idempotency key required" },
      { status: 400 },
    );
  const checkout = await database().situationCheckout.findUnique({
    where: { id: parsed.data.checkoutId },
  });
  if (
    !checkout ||
    checkout.releasedAt ||
    checkout.expiresAt <= new Date() ||
    checkout.holderUserId !== auth.session.userId ||
    checkout.fencingToken !== BigInt(parsed.data.fencingToken) ||
    checkout.draftId !== parsed.data.draftId ||
    checkout.situationId !== parsed.data.situationId
  )
    return NextResponse.json({ error: "locked" }, { status: 423 });
  if (environment().PROVIDER_EXECUTION_MODE === "disabled")
    return NextResponse.json(
      { error: "provider execution disabled pending service API credentials" },
      { status: 503 },
    );
  if (environment().PROVIDER_EXECUTION_MODE === "fake") {
    const existing = await database().aiJob.findUnique({
      where: {
        ownerId_idempotencyKey: {
          ownerId: auth.session.userId,
          idempotencyKey,
        },
      },
    });
    if (existing)
      return NextResponse.json({ jobId: existing.id, reused: true });
    const result = await runDeterministicReview(database(), {
      draftId: parsed.data.draftId,
      situationId: parsed.data.situationId,
      userId: auth.session.userId,
      idempotencyKey,
    });
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "ai.full_review.complete",
      targetType: "ai_job",
      targetId: result.job.id,
      targetVersion: result.bundle.canonicalHash,
      outcome: "SUCCEEDED",
    });
    return NextResponse.json(
      { jobId: result.job.id, bundleId: result.bundle.id },
      { status: 201 },
    );
  }
  const existing = await database().aiJob.findUnique({
    where: {
      ownerId_idempotencyKey: { ownerId: auth.session.userId, idempotencyKey },
    },
  });
  if (existing) return NextResponse.json({ jobId: existing.id, reused: true });
  const draft = await database().draft.findUniqueOrThrow({
    where: { id: parsed.data.draftId },
    include: {
      baseSnapshot: true,
      revisions: { orderBy: { revision: "desc" }, take: 1 },
    },
  });
  const revision = draft.revisions[0];
  if (!revision)
    return NextResponse.json(
      { error: "draft has no revision" },
      { status: 409 },
    );
  const job = await database().$transaction(
    async (transaction) => {
      const row = await transaction.aiJob.create({
        data: {
          kind: "FULL_REVIEW",
          ownerId: auth.session.userId,
          situationId: parsed.data.situationId,
          draftId: parsed.data.draftId,
          inputBundleHash: revision.manifestHash,
          graphHash: sha256(JSON.stringify(draft.baseSnapshot.manifest)),
          workflowVersion: LEADERSHIP_REVIEW_WORKFLOW_VERSION,
          modelPolicyVersion: MODEL_POLICY.version,
          state: "QUEUED",
          stage: "Waiting for complete-review capacity",
          idempotencyKey,
        },
      });
      await transaction.draft.update({
        where: { id: draft.id },
        data: { state: "AI_REVIEW_QUEUED" },
      });
      const situation = await transaction.situation.update({
        where: { id: parsed.data.situationId },
        data: { fence: { increment: 1 } },
      });
      await transaction.situationCheckout.update({
        where: { id: checkout.id },
        data: {
          holderUserId: null,
          mode: "AI_QUEUED",
          custody: "AI_JOB",
          custodyReference: row.id,
          fencingToken: situation.fence,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      return row;
    },
    { isolationLevel: "Serializable" },
  );
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "ai.full_review.enqueue",
    targetType: "ai_job",
    targetId: job.id,
    outcome: "SUCCEEDED",
  });
  return NextResponse.json(
    { jobId: job.id, state: job.state },
    { status: 202 },
  );
}
