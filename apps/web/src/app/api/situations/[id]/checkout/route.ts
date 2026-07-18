import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { acquireCheckout } from "@/server/workflows/checkouts";
import { audit } from "@/server/audit";

const schema = z.object({
  mode: z.enum([
    "EDITING",
    "HUMAN_REVIEW",
    "APPROVED",
    "ARCHIVING",
    "RESTORING",
  ]),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "draft.update");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const { id } = await params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const result = await acquireCheckout(database(), {
    situationId: id,
    userId: auth.session.userId,
    mode: parsed.data.mode,
  });
  if (!result.ok) {
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "checkout.acquire",
      targetType: "situation",
      targetId: id,
      outcome: "DENIED",
      reason: "ALREADY_HELD",
    });
    return NextResponse.json(
      {
        error: "locked",
        holder: result.checkout.holder?.displayName,
        mode: result.checkout.mode,
        renewedAt: result.checkout.renewedAt,
      },
      { status: 423 },
    );
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "checkout.acquire",
    targetType: "situation",
    targetId: id,
    targetVersion: result.checkout.fencingToken.toString(),
    outcome: "SUCCEEDED",
  });
  return NextResponse.json({
    checkoutId: result.checkout.id,
    fencingToken: result.checkout.fencingToken.toString(),
    draftId: result.draft.id,
  });
}
