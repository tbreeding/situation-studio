import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import { WorkflowError, cancelReview } from "@/server/workflows/situations";

const inputSchema = z.object({
  revisionId: z.uuid(),
  bundleHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reason: z.string().min(1).max(500).optional(),
});

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
    const payload = inputSchema.parse(await request.json());
    const job = await cancelReview({
      actorId: auth.session.userId,
      jobId: id,
      revisionId: payload.revisionId,
      bundleHash: payload.bundleHash,
      ...(payload.reason ? { reason: payload.reason } : {}),
    });
    return NextResponse.json({ jobId: job.id, state: job.state });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Invalid review cancellation command." },
        { status: 422 },
      );
    throw error;
  }
}
