import { NextResponse, type NextRequest } from "next/server";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { sha256 } from "@situation-studio/domain";
import { audit } from "@/server/audit";

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
  const { id } = await params;
  const bundle = await database().proposedBundle.findUnique({
    where: { id },
    include: {
      validations: true,
      comments: { where: { status: "OPEN", blocking: true } },
      draft: true,
    },
  });
  if (
    !bundle ||
    bundle.state !== "HUMAN_REVIEW" ||
    bundle.comments.length ||
    !bundle.validations.length ||
    bundle.validations.some(
      (item) =>
        item.state !== "PASSED" || item.bundleHash !== bundle.canonicalHash,
    ) ||
    bundle.draft.staleReason
  )
    return NextResponse.json(
      { error: "approval preconditions failed" },
      { status: 409 },
    );
  const policyHash = sha256(
    JSON.stringify(
      bundle.validations
        .map((item) => [item.validator, item.version, item.environmentHash])
        .sort(),
    ),
  );
  const approval = await database().$transaction(
    async (transaction) => {
      const row = await transaction.approval.create({
        data: {
          bundleId: bundle.id,
          bundleHash: bundle.canonicalHash,
          baseCommit: bundle.baseCommit,
          validationPolicyHash: policyHash,
          approvedById: auth.session.userId,
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
      return row;
    },
    { isolationLevel: "Serializable" },
  );
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "bundle.approve",
    targetType: "bundle",
    targetId: bundle.id,
    targetVersion: bundle.canonicalHash,
    outcome: "SUCCEEDED",
    after: {
      approvalId: approval.id,
      baseCommit: bundle.baseCommit,
      validationPolicyHash: policyHash,
    },
  });
  return NextResponse.json({ approvalId: approval.id });
}
