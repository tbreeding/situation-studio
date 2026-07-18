import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";

const schema = z.object({ state: z.enum(["ACTIVE", "DEACTIVATED"]) });

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
      { error: "invalid state request" },
      { status: 400 },
    );
  const { id } = await params;
  if (id === auth.session.userId)
    return NextResponse.json(
      { error: "self state changes are not allowed" },
      { status: 409 },
    );
  const before = await database().user.findUnique({ where: { id } });
  if (!before)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const now = new Date();
  await database().$transaction(async (transaction) => {
    await transaction.user.update({
      where: { id },
      data: {
        state: parsed.data.state,
        deactivatedAt: parsed.data.state === "DEACTIVATED" ? now : null,
        deactivatedById:
          parsed.data.state === "DEACTIVATED" ? auth.session.userId : null,
      },
    });
    if (parsed.data.state === "DEACTIVATED")
      await transaction.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now, revokedReason: "USER_DEACTIVATED" },
      });
  });
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: `user.${parsed.data.state === "ACTIVE" ? "reactivate" : "deactivate"}`,
    targetType: "user",
    targetId: id,
    outcome: "SUCCEEDED",
    before: { state: before.state },
    after: { state: parsed.data.state },
  });
  return NextResponse.json({ state: parsed.data.state });
}
