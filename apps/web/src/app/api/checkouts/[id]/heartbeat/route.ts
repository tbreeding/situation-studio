import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { renewCheckout } from "@/server/workflows/checkouts";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request);
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const { id } = await params;
  const parsed = z
    .object({ fencingToken: z.string().regex(/^\d+$/u) })
    .safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const renewed = await renewCheckout(database(), {
    checkoutId: id,
    userId: auth.session.userId,
    fencingToken: BigInt(parsed.data.fencingToken),
  });
  return renewed
    ? NextResponse.json({ renewed: true })
    : NextResponse.json({ error: "locked" }, { status: 423 });
}
