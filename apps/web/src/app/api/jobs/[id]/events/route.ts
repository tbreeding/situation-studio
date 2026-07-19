import type { NextRequest } from "next/server";
import { z } from "zod";
import { currentSession } from "@/server/auth/sessions";
import { reviewJobSnapshotById } from "@/server/review-progress";
import {
  encodeReviewHeartbeat,
  encodeReviewProgressEvent,
} from "@/lib/review-events";
import { terminalReviewStates } from "@/lib/review-presentation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const paramsSchema = z.object({ id: z.string().uuid() });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await currentSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) return new Response("Not found", { status: 404 });
  const initial = await reviewJobSnapshotById(parsed.data.id);
  if (
    !initial ||
    (initial.ownerId !== session.userId &&
      !session.permissions.has("system.admin"))
  )
    return new Response("Not found", { status: 404 });

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lastProgress = "";
  const streamStartedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const stop = () => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // The browser may already have closed its side of the stream.
        }
      };
      request.signal.addEventListener("abort", stop, { once: true });

      const emit = async () => {
        if (stopped) return;
        try {
          const current = await reviewJobSnapshotById(parsed.data.id);
          if (!current || current.ownerId !== initial.ownerId) {
            stop();
            return;
          }
          const progressIdentity = JSON.stringify({
            state: current.snapshot.state,
            stage: current.snapshot.stage,
            startedAt: current.snapshot.startedAt,
            finishedAt: current.snapshot.finishedAt,
            steps: current.snapshot.steps,
          });
          controller.enqueue(
            encoder.encode(
              progressIdentity === lastProgress
                ? encodeReviewHeartbeat(current.snapshot.observedAt)
                : encodeReviewProgressEvent(current.snapshot),
            ),
          );
          lastProgress = progressIdentity;
          if (terminalReviewStates.has(current.snapshot.state)) {
            stop();
            return;
          }
          if (Date.now() - streamStartedAt >= 10 * 60 * 1000) {
            stop();
            return;
          }
          timer = setTimeout(emit, 1_500);
        } catch (error) {
          stopped = true;
          if (timer) clearTimeout(timer);
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
