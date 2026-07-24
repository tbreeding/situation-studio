import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "@/server/database";
import { hasRole, requireMutationSession } from "@/server/auth/request";

const stateSchema = z.object({ active: z.boolean() });

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMutationSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!hasRole(auth.session, "ADMIN"))
    return NextResponse.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  const input = stateSchema.parse(await request.json());
  const { id } = await params;
  if (id === auth.session.userId && !input.active)
    return NextResponse.json(
      { error: "You cannot deactivate your own active account." },
      { status: 409 },
    );
  await database().$transaction(async (transaction) => {
    await transaction.user.update({
      where: { id },
      data: {
        state: input.active ? "ACTIVE" : "DEACTIVATED",
        deactivatedAt: input.active ? null : new Date(),
      },
    });
    if (!input.active)
      await transaction.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "USER_DEACTIVATED" },
      });
    await transaction.auditEvent.create({
      data: {
        actorId: auth.session.userId,
        action: input.active ? "USER_REACTIVATED" : "USER_DEACTIVATED",
        subjectType: "USER",
        subjectId: id,
        payload: {},
      },
    });
  });
  return NextResponse.json({ status: input.active ? "ACTIVE" : "DEACTIVATED" });
}
