import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@situation-studio/db";
import { z } from "zod";
import { audit } from "@/server/audit";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";

const schema = z.object({
  repositoryReviewerId: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{1,99}$/u)
    .nullable(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "user.manage");
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
    return NextResponse.json(
      { error: "invalid repository reviewer identity" },
      { status: 400 },
    );
  const { id } = await params;
  const before = await database().user.findUnique({ where: { id } });
  if (!before)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  try {
    const user = await database().user.update({
      where: { id },
      data: { repositoryReviewerId: parsed.data.repositoryReviewerId },
    });
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "user.map_repository_reviewer",
      targetType: "user",
      targetId: id,
      outcome: "SUCCEEDED",
      before: { repositoryReviewerId: before.repositoryReviewerId },
      after: { repositoryReviewerId: user.repositoryReviewerId },
    });
    return NextResponse.json({
      repositoryReviewerId: user.repositoryReviewerId,
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      return NextResponse.json(
        { error: "repository reviewer identity is already mapped" },
        { status: 409 },
      );
    throw error;
  }
}
