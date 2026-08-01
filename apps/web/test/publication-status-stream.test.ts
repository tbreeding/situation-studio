import { describe, expect, it } from "vitest";
import { publicationStatusEventsResponse } from "../src/server/publication-status-stream";
import {
  buildPublicationStatusSnapshot,
  type PublicationStatusRecord,
} from "../src/server/publication-status";

const publicationJobId = "22222222-2222-4222-8222-222222222222";

function record(
  state: PublicationStatusRecord["state"],
  events: PublicationStatusRecord["events"],
): PublicationStatusRecord {
  return {
    id: publicationJobId,
    state,
    failureCode: null,
    events,
  };
}

describe("publication-status SSE transport", () => {
  it("rejects unauthenticated access before loading publication state", async () => {
    let loads = 0;
    const response = await publicationStatusEventsResponse(
      new Request(
        `http://studio.test/api/publications/${publicationJobId}/events`,
      ),
      {
        authenticated: false,
        publicationJobId,
        loadSnapshot: async () => {
          loads += 1;
          return buildPublicationStatusSnapshot(
            record("REQUESTED", [{ sequence: 1, kind: "REQUESTED" }]),
          );
        },
      },
    );
    expect(response.status).toBe(401);
    expect(loads).toBe(0);
  });

  it("opens with the full current snapshot and hardened streaming headers", async () => {
    const response = await publicationStatusEventsResponse(
      new Request(
        `http://studio.test/api/publications/${publicationJobId}/events`,
      ),
      {
        authenticated: true,
        publicationJobId,
        loadSnapshot: async () =>
          buildPublicationStatusSnapshot(
            record("REQUESTED", [{ sequence: 1, kind: "REQUESTED" }]),
          ),
        maximumLifetimeMs: 1_000,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toContain("no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const reader = response.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("retry: 2000");
    expect(text).toContain("event: publication-status");
    expect(text).toContain('"displayName":"Starting publication"');
    await reader.cancel();
  });

  it("streams only allowlisted verification evidence from a terminal event", async () => {
    const response = await publicationStatusEventsResponse(
      new Request(
        `http://studio.test/api/publications/${publicationJobId}/events`,
      ),
      {
        authenticated: true,
        publicationJobId,
        loadSnapshot: async () =>
          buildPublicationStatusSnapshot(
            record("RESTORED", [
              { sequence: 1, kind: "REQUESTED" },
              { sequence: 2, kind: "POINTER_OBSERVED" },
              { sequence: 3, kind: "SNAPSHOT_BUILT" },
              { sequence: 4, kind: "VALIDATED" },
              { sequence: 5, kind: "POINTER_ADVANCED" },
              {
                sequence: 6,
                kind: "RESTORE_STARTED",
                payload: {
                  failureDetail: {
                    schemaVersion: "publication-failure-detail-v1",
                    phase: "RUNTIME_IDENTITY",
                    source: "LEADERSHIP_CONTENT_HEALTH",
                    reason: "HTTP_STATUS",
                    attempts: 24,
                    elapsedMs: 11_750,
                    lastHttpStatus: 503,
                    lastObservedReleaseId: null,
                    lastObservedManifestHash: null,
                  },
                  rawError: "password=secret publisher stderr",
                },
              },
              { sequence: 7, kind: "RESTORED" },
            ]),
          ),
      },
    );
    const text = await response.text();
    expect(text).toContain('"source":"LEADERSHIP_CONTENT_HEALTH"');
    expect(text).toContain('"lastHttpStatus":503');
    expect(text).not.toMatch(/password|secret|stderr|rawError/iu);
  });

  it("keeps recovery verification evidence distinct and redacted", async () => {
    const detail = {
      schemaVersion: "publication-failure-detail-v1",
      phase: "RUNTIME_IDENTITY",
      source: "LEADERSHIP_CONTENT_HEALTH",
      reason: "UNAVAILABLE",
      attempts: 9,
      elapsedMs: 4_500,
      lastHttpStatus: null,
      lastObservedReleaseId: null,
      lastObservedManifestHash: null,
    } as const;
    const response = await publicationStatusEventsResponse(
      new Request(
        `http://studio.test/api/publications/${publicationJobId}/events`,
      ),
      {
        authenticated: true,
        publicationJobId,
        loadSnapshot: async () =>
          buildPublicationStatusSnapshot(
            record("RECOVERY_REQUIRED", [
              { sequence: 1, kind: "REQUESTED" },
              { sequence: 2, kind: "POINTER_OBSERVED" },
              { sequence: 3, kind: "SNAPSHOT_BUILT" },
              { sequence: 4, kind: "VALIDATED" },
              { sequence: 5, kind: "POINTER_ADVANCED" },
              {
                sequence: 6,
                kind: "RECOVERY_REQUIRED",
                payload: {
                  failureDetail: { ...detail, reason: "HTTP_STATUS" },
                  recoveryFailureDetail: detail,
                  rawError: "password=private recovery stderr",
                },
              },
            ]),
          ),
      },
    );
    const text = await response.text();
    expect(text).toContain('"state":"RECOVERY_REQUIRED"');
    expect(text).toContain('"recoveryFailure"');
    expect(text).toContain('"reason":"UNAVAILABLE"');
    expect(text).not.toMatch(/password|private|stderr|rawError/iu);
  });

  it("emits only changed durable snapshots and closes at success", async () => {
    const requested = buildPublicationStatusSnapshot(
      record("REQUESTED", [{ sequence: 1, kind: "REQUESTED" }]),
    );
    const activating = buildPublicationStatusSnapshot(
      record("PROMOTING", [
        { sequence: 1, kind: "REQUESTED" },
        { sequence: 2, kind: "POINTER_OBSERVED" },
        { sequence: 3, kind: "SNAPSHOT_BUILT" },
        { sequence: 4, kind: "VALIDATED" },
      ]),
    );
    const succeeded = buildPublicationStatusSnapshot(
      record("SUCCEEDED", [
        { sequence: 1, kind: "REQUESTED" },
        { sequence: 2, kind: "POINTER_OBSERVED" },
        { sequence: 3, kind: "SNAPSHOT_BUILT" },
        { sequence: 4, kind: "VALIDATED" },
        { sequence: 5, kind: "POINTER_ADVANCED" },
        { sequence: 6, kind: "VERIFIED" },
        { sequence: 7, kind: "SUCCEEDED" },
      ]),
    );
    const sequence = [requested, requested, activating, succeeded];
    let call = 0;
    const response = await publicationStatusEventsResponse(
      new Request(
        `http://studio.test/api/publications/${publicationJobId}/events`,
      ),
      {
        authenticated: true,
        publicationJobId,
        loadSnapshot: async () =>
          sequence[Math.min(call++, sequence.length - 1)]!,
        pollIntervalMs: 3,
        maximumLifetimeMs: 1_000,
      },
    );
    const text = await response.text();
    expect(text.match(/event: publication-status/gu)).toHaveLength(3);
    expect(text).toContain('"displayName":"Starting publication"');
    expect(text).toContain('"displayName":"Activating in Leadership"');
    expect(text).toContain('"title":"Published"');
  });

  it("closes safely on a database error without exposing error text", async () => {
    let call = 0;
    const response = await publicationStatusEventsResponse(
      new Request(
        `http://studio.test/api/publications/${publicationJobId}/events`,
      ),
      {
        authenticated: true,
        publicationJobId,
        loadSnapshot: async () => {
          call += 1;
          if (call === 1)
            return buildPublicationStatusSnapshot(
              record("REQUESTED", [{ sequence: 1, kind: "REQUESTED" }]),
            );
          throw new Error("password=secret publisher stderr");
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
