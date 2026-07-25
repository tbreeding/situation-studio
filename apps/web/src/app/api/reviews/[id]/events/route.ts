import { currentSession } from "@/server/auth/sessions";
import { loadReviewStatusSnapshot } from "@/server/review-status";
import { reviewStatusEventsResponse } from "@/server/review-status-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await currentSession();
  const { id } = await params;
  return reviewStatusEventsResponse(request, {
    authenticated: Boolean(session),
    reviewJobId: id,
    loadSnapshot: () => loadReviewStatusSnapshot(id),
  });
}
