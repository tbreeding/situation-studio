import { NextResponse } from "next/server";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import { WorkflowError, cancelReview } from "@/server/workflows/situations";

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
    const payload = (await request.json().catch(() => ({}))) as {
      reason?: string;
    };
    const job = await cancelReview({
      actorId: auth.session.userId,
      jobId: id,
      ...(payload.reason ? { reason: payload.reason } : {}),
    });
    return NextResponse.json({ jobId: job.id, state: job.state });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    throw error;
  }
}
