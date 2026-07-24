import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "@/server/database";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import { hashPassword } from "@/server/auth/password";

const resetSchema = z.object({ password: z.string().min(12).max(1024) });

export async function POST(
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
  const input = resetSchema.parse(await request.json());
  const { id } = await params;
  const passwordHash = await hashPassword(input.password);
  await database().$transaction(async (transaction) => {
    await transaction.user.update({
      where: { id },
      data: { passwordHash, passwordVersion: { increment: 1 } },
    });
    await transaction.session.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: "PASSWORD_RESET" },
    });
    await transaction.auditEvent.create({
      data: {
        actorId: auth.session.userId,
        action: "USER_PASSWORD_RESET",
        subjectType: "USER",
        subjectId: id,
        payload: {},
      },
    });
  });
  return NextResponse.json({ status: "reset" });
}
