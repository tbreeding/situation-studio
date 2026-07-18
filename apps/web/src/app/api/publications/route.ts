import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
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
  if (
    !bundle ||
    !approval ||
    bundle.state !== "APPROVED" ||
    approval.bundleHash !== bundle.canonicalHash ||
    approval.baseCommit !== bundle.baseCommit ||
    bundle.comments.length ||
    bundle.validations.some((item) => item.state !== "PASSED")
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
  const fake = environment().PROVIDER_EXECUTION_MODE === "fake";
  const publicationUuid = randomUUID();
  const publicationRequest = await database().publicationRequest.create({
    data: {
      publicationUuid,
      idempotencyKey: key,
      targetEnvironment: parsed.data.target,
      bundleId: bundle.id,
      bundleHash: bundle.canonicalHash,
      approvalId: approval.id,
      baseCommit: bundle.baseCommit,
      state: fake ? "AWAITING_CONFIRMATION" : "REQUESTED",
      currentStep: fake ? "PREVIEW_VERIFIED" : "REQUESTED",
      requestedById: auth.session.userId,
    },
  });
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
      await database().publicationStep.create({
        data: {
          requestId: publicationRequest.id,
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
  await database().draft.update({
    where: { id: bundle.draftId },
    data: { state: "PUBLISHING" },
  });
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "publication.stage",
    targetType: "publication_request",
    targetId: publicationRequest.id,
    targetVersion: bundle.canonicalHash,
    outcome: "SUCCEEDED",
    after: { target: parsed.data.target, fake },
  });
  return NextResponse.json(
    {
      publicationRequestId: publicationRequest.id,
      state: publicationRequest.state,
    },
    { status: 201 },
  );
}
