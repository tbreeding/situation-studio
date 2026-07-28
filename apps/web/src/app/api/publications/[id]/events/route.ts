import { currentSession } from "@/server/auth/sessions";
import { loadPublicationStatusSnapshot } from "@/server/publication-status";
import { publicationStatusEventsResponse } from "@/server/publication-status-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await currentSession();
  const { id } = await params;
  return publicationStatusEventsResponse(request, {
    authenticated: Boolean(session),
    publicationJobId: id,
    loadSnapshot: () => loadPublicationStatusSnapshot(id),
  });
}
