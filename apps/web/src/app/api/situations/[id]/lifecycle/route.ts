import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";

const schema = z.object({
  action: z.enum(["ARCHIVE", "RESTORE"]),
  reason: z.string().trim().min(8).max(500),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "situation.archive");
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
    return NextResponse.json({ error: "reason required" }, { status: 400 });
  const { id } = await params;
  const now = new Date();
  const result = await database()
    .$transaction(
      async (transaction) => {
        const situation = await transaction.situation.findUnique({
          where: { id },
          include: { checkouts: { where: { releasedAt: null }, take: 1 } },
        });
        if (!situation) return null;
        if (situation.checkouts.length) throw new Error("ACTIVE_CHECKOUT");
        if (
          parsed.data.action === "ARCHIVE" &&
          situation.lifecycle === "ARCHIVED"
        )
          return situation;
        if (
          parsed.data.action === "RESTORE" &&
          situation.lifecycle !== "ARCHIVED"
        )
          throw new Error("NOT_ARCHIVED");
        const next =
          parsed.data.action === "ARCHIVE"
            ? "ARCHIVED"
            : (situation.previousLifecycle ?? "UNPUBLISHED");
        await transaction.archiveRecord.create({
          data: {
            situationId: id,
            action: parsed.data.action,
            reason: parsed.data.reason,
            actorId: auth.session.userId,
            previousLifecycle: situation.lifecycle,
            resultLifecycle: next,
          },
        });
        return transaction.situation.update({
          where: { id },
          data:
            parsed.data.action === "ARCHIVE"
              ? {
                  previousLifecycle: situation.lifecycle,
                  lifecycle: "ARCHIVED",
                  archivedAt: now,
                  archivedById: auth.session.userId,
                  archiveReason: parsed.data.reason,
                }
              : {
                  lifecycle: next,
                  previousLifecycle: null,
                  archivedAt: null,
                  archivedById: null,
                  archiveReason: null,
                },
        });
      },
      { isolationLevel: "Serializable" },
    )
    .catch((error: unknown) => {
      if (
        error instanceof Error &&
        ["ACTIVE_CHECKOUT", "NOT_ARCHIVED"].includes(error.message)
      )
        return false as const;
      throw error;
    });
  if (result === null)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  if (result === false)
    return NextResponse.json(
      { error: "lifecycle precondition failed" },
      { status: 409 },
    );
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: `situation.${parsed.data.action.toLowerCase()}`,
    targetType: "situation",
    targetId: id,
    outcome: "SUCCEEDED",
    reason: parsed.data.reason,
    after: { lifecycle: result.lifecycle },
  });
  return NextResponse.json({ lifecycle: result.lifecycle });
}
