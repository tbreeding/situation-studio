import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { audit } from "@/server/audit";
import { database } from "@/server/database";
import { releaseCheckout } from "@/server/workflows/checkouts";

const schema = z.object({
  fencingToken: z.string().regex(/^\d+$/u),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request);
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const { id } = await params;
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });

  const result = await releaseCheckout(database(), {
    checkoutId: id,
    userId: auth.session.userId,
    fencingToken: BigInt(parsed.data.fencingToken),
  });
  if (!result.ok) {
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "checkout.release",
      targetType: "checkout",
      targetId: id,
      targetVersion: parsed.data.fencingToken,
      outcome: "DENIED",
      reason: "CHECKOUT_NOT_OWNED_OR_STALE",
    });
    return NextResponse.json({ error: "locked" }, { status: 423 });
  }

  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "checkout.release",
    targetType: "checkout",
    targetId: id,
    targetVersion: parsed.data.fencingToken,
    outcome: "SUCCEEDED",
    reason: "USER_CHECK_IN",
    after: {
      situationId: result.checkout.situationId,
      draftId: result.checkout.draftId,
      savedDraftPreserved: true,
    },
  });
  return NextResponse.json({ released: true });
}
