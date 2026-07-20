import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Prisma } from "@situation-studio/db";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";
import { createReviewComment } from "@/server/workflows/review-comments";

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
  let result;
  try {
    result = await createReviewComment(database(), {
      bundleId: id,
      authorId: auth.session.userId,
      body: parsed.data.body,
      blocking: parsed.data.blocking,
    });
  } catch (error) {
    if (
      (error instanceof Error && error.message === "BUNDLE_NOT_REVIEWABLE") ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034")
    )
      return NextResponse.json(
        { error: "bundle not reviewable" },
        { status: 409 },
      );
    throw error;
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "comment.create",
    targetType: "comment",
    targetId: result.comment.id,
    targetVersion: result.bundle.canonicalHash,
    outcome: "SUCCEEDED",
    after: { blocking: result.comment.blocking },
  });
  return NextResponse.json({ id: result.comment.id }, { status: 201 });
}
