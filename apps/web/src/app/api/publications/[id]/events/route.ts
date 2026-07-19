import type { NextRequest } from "next/server";
import { z } from "zod";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import {
  encodePublicationEvent,
  publicationReplaySequence,
} from "@/lib/publication-events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await currentSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await params);
  if (!parsed.success) return new Response("Not found", { status: 404 });
  const publication = await database().publicationRequest.findUnique({
    where: { id: parsed.data.id },
  });
  if (
    !publication ||
    (publication.requestedById !== session.userId &&
      !session.permissions.has("system.admin"))
  )
    return new Response("Not found", { status: 404 });
  const encoder = new TextEncoder();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sequence = publicationReplaySequence(
    request.headers.get("last-event-id"),
  );
  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          /* Client closed first. */
        }
      };
      request.signal.addEventListener("abort", stop, { once: true });
      const emit = async () => {
        if (stopped) return;
        try {
          const events = await database().publicationEvent.findMany({
            where: {
              publicationRequestId: publication.id,
              sequence: { gt: sequence },
            },
            orderBy: { sequence: "asc" },
            take: 100,
          });
          if (!events.length)
            controller.enqueue(
              encoder.encode(`: heartbeat ${new Date().toISOString()}\n\n`),
            );
          for (const event of events) {
            sequence = event.sequence;
            controller.enqueue(encoder.encode(encodePublicationEvent(event)));
          }
          if (Date.now() - startedAt >= 60_000) return stop();
          timer = setTimeout(emit, 1_000);
        } catch (error) {
          stopped = true;
          controller.error(error);
        }
      };
      void emit();
    },
    cancel() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
