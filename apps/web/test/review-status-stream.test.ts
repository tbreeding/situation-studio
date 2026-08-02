import { describe, expect, it } from "vitest";
import { reviewStatusEventsResponse } from "../src/server/review-status-stream";
import {
  reviewStatusSnapshotSchema,
  REVIEW_STAGE_TOTAL,
  REVIEW_STATUS_SCHEMA_VERSION,
  type ReviewStatusSnapshot,
} from "../src/review-status-contract";

const reviewJobId = "11111111-1111-4111-8111-111111111111";

function snapshot(
  completedStages: number,
  snapshotCharacter: string,
): ReviewStatusSnapshot {
  const currentOrdinal =
    completedStages === REVIEW_STAGE_TOTAL ? null : completedStages + 1;
  return reviewStatusSnapshotSchema.parse({
    schemaVersion: REVIEW_STATUS_SCHEMA_VERSION,
    reviewJobId,
    state: completedStages === REVIEW_STAGE_TOTAL ? "SUCCEEDED" : "RUNNING",
    completedStages,
    totalStages: REVIEW_STAGE_TOTAL,
    stages: Array.from({ length: REVIEW_STAGE_TOTAL }, (_, index) => ({
      ordinal: index + 1,
      state:
        index < completedStages
          ? "SUCCEEDED"
          : index + 1 === currentOrdinal
            ? "RUNNING"
            : "PENDING",
    })),
    currentStage:
      currentOrdinal === null
        ? null
        : {
            ordinal: currentOrdinal,
            code: `stage-${currentOrdinal}`,
            displayName: `Human stage ${currentOrdinal}`,
            state: "RUNNING",
            attempt: 1,
          },
    laneState: completedStages === REVIEW_STAGE_TOTAL ? "RELEASED" : "FOCUSED",
    retry: null,
    terminal:
      completedStages === REVIEW_STAGE_TOTAL
        ? { state: "SUCCEEDED", failureClass: null }
        : null,
    failure: null,
    proposalReady: completedStages === REVIEW_STAGE_TOTAL,
    snapshotId: snapshotCharacter.repeat(64),
  });
}

describe("review-status SSE transport", () => {
  it("rejects unauthenticated access before reading review state", async () => {
    let loads = 0;
    const response = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`),
      {
        authenticated: false,
        reviewJobId,
        loadSnapshot: async () => {
          loads += 1;
          return snapshot(0, "a");
        },
      },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Authentication required.",
    });
    expect(loads).toBe(0);
  });

  it("opens an authenticated stream with a complete initial snapshot and hardened headers", async () => {
    let cleaned = 0;
    const response = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`),
      {
        authenticated: true,
        reviewJobId,
        loadSnapshot: async () => snapshot(0, "a"),
        pollIntervalMs: 100,
        heartbeatIntervalMs: 100,
        maximumLifetimeMs: 1_000,
        onCleanup: () => {
          cleaned += 1;
        },
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");

    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("retry: 3000");
    expect(text).toContain("event: review-status");
    expect(text).toContain(`"reviewJobId":"${reviewJobId}"`);
    expect(text).toContain('"completedStages":0');
    await reader.cancel();
    expect(cleaned).toBe(1);
  });

  it("emits review events only when the safe snapshot changes", async () => {
    const initial = snapshot(0, "b");
    const advanced = snapshot(1, "c");
    const sequence = [initial, initial, advanced, advanced, advanced];
    let call = 0;
    const response = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`),
      {
        authenticated: true,
        reviewJobId,
        loadSnapshot: async () =>
          sequence[Math.min(call++, sequence.length - 1)]!,
        pollIntervalMs: 3,
        heartbeatIntervalMs: 9,
        maximumLifetimeMs: 28,
      },
    );
    const text = await response.text();
    expect(text.match(/event: review-status/gu)).toHaveLength(2);
    expect(text).toContain('"completedStages":0');
    expect(text).toContain('"completedStages":1');
    expect(text).toContain(": heartbeat ");
  });

  it("sends heartbeats and cleans up timers immediately after disconnect", async () => {
    let loads = 0;
    let cleaned = 0;
    const response = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`),
      {
        authenticated: true,
        reviewJobId,
        loadSnapshot: async () => {
          loads += 1;
          return snapshot(0, "d");
        },
        pollIntervalMs: 4,
        heartbeatIntervalMs: 4,
        maximumLifetimeMs: 1_000,
        onCleanup: () => {
          cleaned += 1;
        },
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await new Promise((resolve) => setTimeout(resolve, 14));
    const heartbeat = await reader.read();
    expect(new TextDecoder().decode(heartbeat.value)).toContain(": heartbeat ");
    await reader.cancel();
    const loadsAtDisconnect = loads;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cleaned).toBe(1);
    expect(loads).toBe(loadsAtDisconnect);
  });

  it("cleans up immediately when the request is aborted", async () => {
    const abortController = new AbortController();
    let loads = 0;
    let cleaned = 0;
    const response = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`, {
        signal: abortController.signal,
      }),
      {
        authenticated: true,
        reviewJobId,
        loadSnapshot: async () => {
          loads += 1;
          return snapshot(0, "8");
        },
        pollIntervalMs: 4,
        heartbeatIntervalMs: 4,
        maximumLifetimeMs: 1_000,
        onCleanup: () => {
          cleaned += 1;
        },
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    abortController.abort();
    const loadsAtAbort = loads;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(cleaned).toBe(1);
    expect(loads).toBe(loadsAtAbort);
    await reader.cancel();
  });

  it("reconnects with a full current snapshot even when Last-Event-ID is present", async () => {
    const firstResponse = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`),
      {
        authenticated: true,
        reviewJobId,
        loadSnapshot: async () => snapshot(0, "e"),
        maximumLifetimeMs: 1_000,
      },
    );
    await firstResponse.body!.cancel();

    const reconnected = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`, {
        headers: { "last-event-id": "e".repeat(64) },
      }),
      {
        authenticated: true,
        reviewJobId,
        loadSnapshot: async () => snapshot(2, "f"),
        maximumLifetimeMs: 1_000,
      },
    );
    const reader = reconnected.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: review-status");
    expect(text).toContain('"completedStages":2');
    await reader.cancel();
  });

  it("closes safely on a database error without streaming raw error text", async () => {
    let call = 0;
    const response = await reviewStatusEventsResponse(
      new Request(`http://studio.test/api/reviews/${reviewJobId}/events`),
      {
        authenticated: true,
        reviewJobId,
        loadSnapshot: async () => {
          call += 1;
          if (call === 1) return snapshot(0, "1");
          throw new Error("password=secret provider stderr");
        },
        pollIntervalMs: 3,
        maximumLifetimeMs: 1_000,
      },
    );
    const text = await response.text();
    expect(text).toContain(": snapshot unavailable; reconnecting");
    expect(text).not.toMatch(/password|secret|stderr/iu);
  });
});
