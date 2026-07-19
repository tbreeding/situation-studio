import { describe, expect, test } from "vitest";
import {
  observationDeadlineExpired,
  requestLeadershipObservation,
} from "../src/database-observation";

describe("database publisher observation deadlines", () => {
  test("aborts a Leadership request that does not settle", async () => {
    const neverSettles: typeof fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    await expect(
      requestLeadershipObservation(
        {
          url: "https://leadership.example.test/api/content-observation",
          triggerSecret: "x".repeat(32),
          requestTimeoutMilliseconds: 10,
          publicationRequestId: "00000000-0000-4000-8000-000000000000",
          observationKind: "RESTORATION",
        },
        neverSettles,
      ),
    ).rejects.toBeDefined();
  });

  test("uses the publication state's update time as a finite deadline", () => {
    const updatedAt = new Date("2026-07-19T12:00:00.000Z");
    expect(
      observationDeadlineExpired(
        updatedAt,
        120_000,
        Date.parse("2026-07-19T12:01:59.999Z"),
      ),
    ).toBe(false);
    expect(
      observationDeadlineExpired(
        updatedAt,
        120_000,
        Date.parse("2026-07-19T12:02:00.000Z"),
      ),
    ).toBe(true);
  });
});
