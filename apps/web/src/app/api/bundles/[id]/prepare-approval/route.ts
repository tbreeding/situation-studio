import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/server/audit";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { prepareBundleForHumanApproval } from "@/server/workflows/review-provenance";

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
  try {
    const result = await prepareBundleForHumanApproval(database(), {
      bundleId: id,
      userId: auth.session.userId,
      repositoryReviewerId,
    });
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "bundle.prepare_human_approval",
      targetType: "bundle",
      targetId: result.bundle.id,
      targetVersion: result.bundle.canonicalHash,
      outcome: "SUCCEEDED",
      before: { parentBundleId: id },
      after: {
        repositoryReviewerId,
        reviewDate: result.provenance.reviewDate,
        created: result.created,
      },
    });
    return NextResponse.json(
      {
        bundleId: result.bundle.id,
        bundleHash: result.bundle.canonicalHash,
        reviewDate: result.provenance.reviewDate,
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
      { error: "approval preparation preconditions failed" },
      { status: 409 },
    );
  }
}
