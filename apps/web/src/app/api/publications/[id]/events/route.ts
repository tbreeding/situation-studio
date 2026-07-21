import type { NextRequest } from "next/server";
import { z } from "zod";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import {
  encodePublicationHeartbeat,
  encodePublicationEvent,
  encodePublicationRetry,
  encodePublicationStreamStatus,
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
  if (request.nextUrl.searchParams.get("snapshot") === "1")
    return Response.json(
      {
        state: publication.state,
        currentStep: publication.currentStep,
        updatedAt: publication.updatedAt.toISOString(),
        finalConfirmed: Boolean(publication.finalConfirmedAt),
        serverTime: new Date().toISOString(),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  const encoder = new TextEncoder();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sequence = publicationReplaySequence(
    request.headers.get("last-event-id"),
  );
  let statusFingerprint = "";
  let lastHeartbeatAt = 0;
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
      controller.enqueue(encoder.encode(encodePublicationRetry(2_000)));
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
          const current = await database().publicationRequest.findUnique({
            where: { id: publication.id },
            select: {
              state: true,
              currentStep: true,
              updatedAt: true,
              finalConfirmedAt: true,
            },
          });
          if (!current) return stop();
          const now = new Date();
          const status = {
            state: current.state,
            currentStep: current.currentStep,
            updatedAt: current.updatedAt.toISOString(),
            finalConfirmed: Boolean(current.finalConfirmedAt),
            serverTime: now.toISOString(),
          };
          const nextFingerprint = JSON.stringify({
            state: status.state,
            currentStep: status.currentStep,
            updatedAt: status.updatedAt,
            finalConfirmed: status.finalConfirmed,
          });
          if (nextFingerprint !== statusFingerprint) {
            statusFingerprint = nextFingerprint;
            controller.enqueue(
              encoder.encode(encodePublicationStreamStatus(status)),
            );
          }
          for (const event of events) {
            sequence = event.sequence;
            controller.enqueue(encoder.encode(encodePublicationEvent(event)));
          }
          if (now.getTime() - lastHeartbeatAt >= 5_000) {
            lastHeartbeatAt = now.getTime();
            controller.enqueue(
              encoder.encode(encodePublicationHeartbeat(status)),
            );
          }
          if (now.getTime() - startedAt >= 5 * 60_000) return stop();
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
