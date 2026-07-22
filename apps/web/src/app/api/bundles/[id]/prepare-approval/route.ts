import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import {
  approvalPreparationPublicError,
  prepareBundleForHumanApproval,
} from "@/server/workflows/review-provenance";

const schema = z.object({
  checkoutId: z.string().uuid(),
  fencingToken: z.string().regex(/^\d+$/u),
});

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
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "active checkout required" },
      { status: 409 },
    );
  try {
    const result = await prepareBundleForHumanApproval(database(), {
      bundleId: id,
      userId: auth.session.userId,
      repositoryReviewerId,
      checkoutId: parsed.data.checkoutId,
      fencingToken: BigInt(parsed.data.fencingToken),
      ...(environment().PUBLICATION_BACKEND === "database"
        ? { recoveryTargetCode: "leadership-production" }
        : {}),
    });
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: result.recovered
        ? "bundle.recover_failed_preview"
        : "bundle.prepare_human_approval",
      targetType: "bundle",
      targetId: result.bundle.id,
      targetVersion: result.bundle.canonicalHash,
      outcome: "SUCCEEDED",
      before: { parentBundleId: id },
      after: {
        repositoryReviewerId,
        reviewDate: result.provenance.reviewDate,
        created: result.created,
        recovered: result.recovered,
      },
    });
    return NextResponse.json(
      {
        bundleId: result.bundle.id,
        bundleHash: result.bundle.canonicalHash,
        reviewDate: result.provenance.reviewDate,
        recovered: result.recovered,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "PREPARATION_FAILED";
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "bundle.prepare_human_approval",
      targetType: "bundle",
      targetId: id,
      outcome: "FAILED",
      reason,
    });
    return NextResponse.json(
      { error: approvalPreparationPublicError(reason) },
      { status: 409 },
    );
  }
}
