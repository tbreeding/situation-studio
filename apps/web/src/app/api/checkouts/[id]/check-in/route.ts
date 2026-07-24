import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import { WorkflowError, checkInSituation } from "@/server/workflows/situations";

const inputSchema = z.object({ fence: z.string().regex(/^\d+$/u) });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMutationSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!hasRole(auth.session, "EDITOR"))
    return NextResponse.json(
      { error: "Editor access required." },
      { status: 403 },
    );
  try {
    const { id } = await params;
    const input = inputSchema.parse(await request.json());
    await checkInSituation({
      actorId: auth.session.userId,
      checkoutId: id,
      fence: BigInt(input.fence),
    });
    return NextResponse.json({ status: "checked-in" });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json({ error: "Invalid checkout." }, { status: 422 });
    throw error;
  }
}
