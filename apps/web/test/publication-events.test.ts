import { describe, expect, test } from "vitest";
import {
  encodePublicationEvent,
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
});
