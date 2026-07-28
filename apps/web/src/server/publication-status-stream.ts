import { z } from "zod";
import {
  isTerminalPublicationState,
  publicationStatusSnapshotSchema,
  PUBLICATION_STATUS_EVENT_NAME,
  type PublicationStatusSnapshot,
} from "@/publication-status-contract";

export const PUBLICATION_STATUS_POLL_INTERVAL_MS = 750;
export const PUBLICATION_STATUS_HEARTBEAT_INTERVAL_MS = 15_000;
export const PUBLICATION_STATUS_STREAM_LIFETIME_MS = 2 * 60_000;
export const PUBLICATION_STATUS_RECONNECT_DELAY_MS = 2_000;

type StreamTimer = ReturnType<typeof setTimeout>;

export type PublicationStatusStreamOptions = {
  authenticated: boolean;
  publicationJobId: string;
  loadSnapshot: () => Promise<PublicationStatusSnapshot | null>;
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

function eventFrame(snapshot: PublicationStatusSnapshot) {
  return [
    `id: ${snapshot.snapshotId}`,
    `event: ${PUBLICATION_STATUS_EVENT_NAME}`,
    `data: ${JSON.stringify(snapshot)}`,
    "",
    "",
  ].join("\n");
}

function unref(timer: StreamTimer) {
  if (typeof timer === "object" && "unref" in timer) timer.unref();
}

export async function publicationStatusEventsResponse(
  request: Request,
  options: PublicationStatusStreamOptions,
) {
  if (!options.authenticated) return jsonError("Authentication required.", 401);
  if (!z.uuid().safeParse(options.publicationJobId).success)
    return jsonError("Invalid publication job.", 400);

  let initialSnapshot: PublicationStatusSnapshot | null;
  try {
    const loaded = await options.loadSnapshot();
    initialSnapshot = loaded
      ? publicationStatusSnapshotSchema.parse(loaded)
      : null;
  } catch {
    return jsonError("Publication status is temporarily unavailable.", 503);
  }
  if (!initialSnapshot) return jsonError("Publication job not found.", 404);

  const encoder = new TextEncoder();
  let cancelStream = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const pollInterval =
        options.pollIntervalMs ?? PUBLICATION_STATUS_POLL_INTERVAL_MS;
      const heartbeatInterval =
        options.heartbeatIntervalMs ?? PUBLICATION_STATUS_HEARTBEAT_INTERVAL_MS;
      const maximumLifetime =
        options.maximumLifetimeMs ?? PUBLICATION_STATUS_STREAM_LIFETIME_MS;
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
            enqueue(": publication unavailable; reconnecting\n\n");
            cleanup(true);
            return;
          }
          const snapshot = publicationStatusSnapshotSchema.parse(loaded);
          if (snapshot.snapshotId !== lastSnapshotId) {
            lastSnapshotId = snapshot.snapshotId;
            enqueue(eventFrame(snapshot));
          }
          if (isTerminalPublicationState(snapshot.state)) {
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
        `retry: ${PUBLICATION_STATUS_RECONNECT_DELAY_MS}\n${eventFrame(initialSnapshot)}`,
      );
      if (isTerminalPublicationState(initialSnapshot.state)) {
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
