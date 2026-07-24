import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import {
  WorkflowError,
  forceCheckInSituation,
} from "@/server/workflows/situations";

const inputSchema = z.object({ reason: z.string().min(3).max(500) });

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
  try {
    const { id } = await params;
    const input = inputSchema.parse(await request.json());
    await forceCheckInSituation({
      adminId: auth.session.userId,
      situationId: id,
      reason: input.reason,
    });
    return NextResponse.json({ status: "checked-in" });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "A short reason is required." },
        { status: 422 },
      );
    throw error;
  }
}
