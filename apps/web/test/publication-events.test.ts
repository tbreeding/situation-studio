import { describe, expect, test } from "vitest";
import {
  encodePublicationHeartbeat,
  encodePublicationEvent,
  encodePublicationRetry,
  encodePublicationStreamStatus,
  parsePublicationActivity,
  parsePublicationStreamStatus,
  publicationReplaySequence,
} from "../src/lib/publication-events";

describe("publication event replay", () => {
  test("accepts a durable Last-Event-ID and rejects malformed input", () => {
    expect(publicationReplaySequence("42")).toBe(42n);
    expect(publicationReplaySequence(null)).toBe(0n);
    expect(publicationReplaySequence("-1")).toBe(0n);
    expect(publicationReplaySequence("not-an-event")).toBe(0n);
  });

  test("encodes one ordered replayable SSE event", () => {
    expect(
      encodePublicationEvent({
        sequence: 7n,
        eventType: "CANDIDATE_VERIFIED",
        payload: { snapshotId: "snapshot-1" },
        createdAt: new Date("2026-07-19T12:00:00.000Z"),
      }),
    ).toBe(
      'id: 7\nevent: publication\ndata: {"type":"CANDIDATE_VERIFIED","payload":{"snapshotId":"snapshot-1"},"createdAt":"2026-07-19T12:00:00.000Z"}\n\n',
    );
  });

  test("encodes explicit status, heartbeat, and reconnect guidance", () => {
    const status = {
      state: "OFFICIAL_POINTER_COMMITTED",
      currentStep: "OFFICIAL_POINTER_COMMITTED",
      updatedAt: "2026-07-21T08:00:00.000Z",
      finalConfirmed: true,
      serverTime: "2026-07-21T08:00:05.000Z",
    };
    expect(encodePublicationStreamStatus(status)).toBe(
      `event: status\ndata: ${JSON.stringify(status)}\n\n`,
    );
    expect(encodePublicationHeartbeat(status)).toBe(
      `event: heartbeat\ndata: ${JSON.stringify(status)}\n\n`,
    );
    expect(encodePublicationRetry(2_000)).toBe("retry: 2000\n\n");
  });

  test("parses only complete live status and activity messages", () => {
    const status = {
      state: "LIVE_VERIFIED",
      currentStep: "LIVE_VERIFIED",
      updatedAt: "2026-07-21T08:00:00.000Z",
      finalConfirmed: true,
      serverTime: "2026-07-21T08:00:05.000Z",
    };
    expect(parsePublicationStreamStatus(JSON.stringify(status))).toEqual(
      status,
    );
    expect(
      parsePublicationStreamStatus('{"state":"LIVE_VERIFIED"}'),
    ).toBeNull();
    expect(parsePublicationStreamStatus("not-json")).toBeNull();
    expect(
      parsePublicationActivity(
        JSON.stringify({
          type: "PUBLICATION_RECONCILED",
          payload: { ignored: true },
          createdAt: "2026-07-21T08:00:06.000Z",
        }),
      ),
    ).toEqual({
      type: "PUBLICATION_RECONCILED",
      createdAt: "2026-07-21T08:00:06.000Z",
    });
    expect(parsePublicationActivity("{}")).toBeNull();
  });
});
