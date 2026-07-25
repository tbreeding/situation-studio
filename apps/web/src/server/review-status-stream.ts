import { z } from "zod";
import {
  isTerminalReviewState,
  reviewStatusSnapshotSchema,
  REVIEW_STATUS_EVENT_NAME,
  type ReviewStatusSnapshot,
} from "@/review-status-contract";

export const REVIEW_STATUS_POLL_INTERVAL_MS = 1_500;
export const REVIEW_STATUS_HEARTBEAT_INTERVAL_MS = 15_000;
export const REVIEW_STATUS_STREAM_LIFETIME_MS = 2 * 60_000;
export const REVIEW_STATUS_RECONNECT_DELAY_MS = 3_000;

type StreamTimer = ReturnType<typeof setTimeout>;

export type ReviewStatusStreamOptions = {
  authenticated: boolean;
  reviewJobId: string;
  loadSnapshot: () => Promise<ReviewStatusSnapshot | null>;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maximumLifetimeMs?: number;
  now?: () => Date;
  onCleanup?: () => void;
};

function jsonError(error: string, status: number) {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
      },
    },
  );
}

function eventFrame(snapshot: ReviewStatusSnapshot) {
  return [
    `id: ${snapshot.snapshotId}`,
    `event: ${REVIEW_STATUS_EVENT_NAME}`,
    `data: ${JSON.stringify(snapshot)}`,
    "",
    "",
  ].join("\n");
}

function unref(timer: StreamTimer) {
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export async function reviewStatusEventsResponse(
  request: Request,
  options: ReviewStatusStreamOptions,
) {
  if (!options.authenticated) return jsonError("Authentication required.", 401);
  if (!z.uuid().safeParse(options.reviewJobId).success)
    return jsonError("Invalid review job.", 400);

  let initialSnapshot: ReviewStatusSnapshot | null;
  try {
    const loaded = await options.loadSnapshot();
    initialSnapshot = loaded ? reviewStatusSnapshotSchema.parse(loaded) : null;
  } catch {
    return jsonError("Review status is temporarily unavailable.", 503);
  }
  if (!initialSnapshot) return jsonError("Review job not found.", 404);

  const encoder = new TextEncoder();
  let cancelStream = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const pollInterval =
        options.pollIntervalMs ?? REVIEW_STATUS_POLL_INTERVAL_MS;
      const heartbeatInterval =
        options.heartbeatIntervalMs ?? REVIEW_STATUS_HEARTBEAT_INTERVAL_MS;
      const maximumLifetime =
        options.maximumLifetimeMs ?? REVIEW_STATUS_STREAM_LIFETIME_MS;
      const now = options.now ?? (() => new Date());
      let closed = false;
      let pollTimer: StreamTimer | null = null;
      let heartbeatTimer: StreamTimer | null = null;
      let lifetimeTimer: StreamTimer | null = null;
      let lastSnapshotId = initialSnapshot.snapshotId;

      const enqueue = (value: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(value));
        } catch {
          cleanup(false);
        }
      };
      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearTimeout(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (lifetimeTimer) clearTimeout(lifetimeTimer);
        request.signal.removeEventListener("abort", abort);
        options.onCleanup?.();
        if (closeController)
          try {
            controller.close();
          } catch {
            // The browser may already have cancelled its reader.
          }
      };
      const abort = () => cleanup(false);
      const schedulePoll = () => {
        if (closed) return;
        pollTimer = setTimeout(() => void poll(), pollInterval);
        unref(pollTimer);
      };
      const poll = async () => {
        if (closed) return;
        try {
          const loaded = await options.loadSnapshot();
          if (closed) return;
          if (!loaded) {
            enqueue(": review unavailable; reconnecting\n\n");
            cleanup(true);
            return;
          }
          const snapshot = reviewStatusSnapshotSchema.parse(loaded);
          if (snapshot.snapshotId !== lastSnapshotId) {
            lastSnapshotId = snapshot.snapshotId;
            enqueue(eventFrame(snapshot));
          }
          if (isTerminalReviewState(snapshot.state)) {
            cleanup(true);
            return;
          }
          schedulePoll();
        } catch {
          enqueue(": snapshot unavailable; reconnecting\n\n");
          cleanup(true);
        }
      };

      cancelStream = () => cleanup(false);
      request.signal.addEventListener("abort", abort, { once: true });
      if (request.signal.aborted) {
        cleanup(true);
        return;
      }
      enqueue(
        `retry: ${REVIEW_STATUS_RECONNECT_DELAY_MS}\n${eventFrame(initialSnapshot)}`,
      );
      if (isTerminalReviewState(initialSnapshot.state)) {
        cleanup(true);
        return;
      }
      schedulePoll();
      heartbeatTimer = setInterval(
        () => enqueue(`: heartbeat ${now().toISOString()}\n\n`),
        heartbeatInterval,
      );
      unref(heartbeatTimer);
      lifetimeTimer = setTimeout(() => {
        enqueue(": stream lifetime reached; reconnecting\n\n");
        cleanup(true);
      }, maximumLifetime);
      unref(lifetimeTimer);
    },
    cancel() {
      cancelStream();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "private, no-cache, no-store, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
