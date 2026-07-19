import { describe, expect, test } from "vitest";
import {
  encodeReviewHeartbeat,
  encodeReviewProgressEvent,
} from "../src/lib/review-events";
import type { ReviewJobSnapshot } from "../src/lib/review-presentation";

const snapshot: ReviewJobSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  state: "RUNNING",
  stage: "1 of 22: map learning surfaces",
  createdAt: "2026-07-19T09:59:00.000Z",
  startedAt: "2026-07-19T09:59:01.000Z",
  finishedAt: null,
  observedAt: "2026-07-19T10:00:00.000Z",
  steps: [
    {
      role: "MAP_LEARNING_SURFACES",
      state: "RUNNING",
      updatedAt: "2026-07-19T09:59:59.000Z",
    },
  ],
};

describe("complete-review server-sent events", () => {
  test("encodes retry, event type, durable id, and one JSON data record", () => {
    const event = encodeReviewProgressEvent(snapshot);
    expect(event.startsWith("retry: 3000\nevent: progress\n")).toBe(true);
    expect(event).toContain(`id: ${snapshot.observedAt}\n`);
    expect(event.endsWith("\n\n")).toBe(true);
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data: "));
    expect(dataLines).toHaveLength(1);
    expect(JSON.parse(dataLines[0]!.slice(6))).toEqual(snapshot);
  });

  test("escapes stage newlines inside JSON instead of creating SSE fields", () => {
    const event = encodeReviewProgressEvent({
      ...snapshot,
      stage: "first line\nsecond line",
    });
    expect(
      event.split("\n").filter((line) => line.startsWith("data: ")),
    ).toHaveLength(1);
    expect(event).toContain("first line\\nsecond line");
  });

  test("encodes unchanged observations as SSE comments", () => {
    expect(encodeReviewHeartbeat(snapshot.observedAt)).toBe(
      `: review progress observed ${snapshot.observedAt}\n\n`,
    );
  });
});
