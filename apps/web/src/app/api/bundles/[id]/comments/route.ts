import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";

const schema = z.object({
  body: z.string().trim().min(3).max(4000),
  blocking: z.boolean(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "proposal.review");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "invalid comment" }, { status: 400 });
  const { id } = await params;
  const bundle = await database().proposedBundle.findUnique({ where: { id } });
  if (!bundle || !["HUMAN_REVIEW", "APPROVED"].includes(bundle.state))
    return NextResponse.json(
      { error: "bundle not reviewable" },
      { status: 409 },
    );
  const comment = await database().$transaction(
    async (transaction) => {
      const row = await transaction.comment.create({
        data: {
          bundleId: id,
          authorId: auth.session.userId,
          body: parsed.data.body,
          blocking: parsed.data.blocking,
        },
      });
      if (parsed.data.blocking && bundle.state === "APPROVED") {
        await transaction.approval.updateMany({
          where: { bundleId: id, invalidatedAt: null },
          data: {
            invalidatedAt: new Date(),
            invalidationReason: "BLOCKING_COMMENT_ADDED",
          },
        });
        await transaction.proposedBundle.update({
          where: { id },
          data: { state: "HUMAN_REVIEW" },
        });
        await transaction.draft.update({
          where: { id: bundle.draftId },
          data: { state: "HUMAN_REVIEW" },
        });
      }
      return row;
    },
    { isolationLevel: "Serializable" },
  );
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "comment.create",
    targetType: "comment",
    targetId: comment.id,
    targetVersion: bundle.canonicalHash,
    outcome: "SUCCEEDED",
    after: { blocking: comment.blocking },
  });
  return NextResponse.json({ id: comment.id }, { status: 201 });
}
