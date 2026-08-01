import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backupReceiptFindFirst: vi.fn(),
  heartbeatFindMany: vi.fn(),
  leadershipCursorFindUnique: vi.fn(),
  publicationJobCount: vi.fn(),
  queryRaw: vi.fn(),
  requireCompatibleLeadershipRuntime: vi.fn(),
}));

vi.mock("@/server/database", () => ({
  database: () => ({
    $queryRaw: mocks.queryRaw,
    backupReceipt: {
      findFirst: mocks.backupReceiptFindFirst,
    },
    leadershipSyncCursor: {
      findUnique: mocks.leadershipCursorFindUnique,
    },
    processHeartbeat: {
      findMany: mocks.heartbeatFindMany,
    },
    publicationJob: {
      count: mocks.publicationJobCount,
    },
  }),
}));

vi.mock("@/server/leadership-compatibility", () => ({
  requireCompatibleLeadershipRuntime: mocks.requireCompatibleLeadershipRuntime,
}));

import { GET } from "../src/app/health/ready/route";

const now = new Date("2026-07-29T12:00:00.000Z");

describe("readiness backup and restore-drill evidence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.stubEnv("SITUATION_STUDIO_BACKUP_READINESS_MODE", "required");
    mocks.queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    mocks.requireCompatibleLeadershipRuntime.mockResolvedValue({
      capabilityDigest: "capability-digest",
      database: { predicate: "typed-predicate" },
      deployment: { commit: "leadership-commit" },
    });
    mocks.leadershipCursorFindUnique.mockResolvedValue({
      id: "official",
      lastErrorCode: null,
      lastManifestHash: "manifest-hash",
      lastPointerGeneration: 15n,
      lastReleaseId: "release-id",
      lastSuccessfulAt: new Date(now.getTime() - 10_000),
    });
    mocks.heartbeatFindMany.mockResolvedValue([
      {
        id: "publisher",
        lastSeenAt: new Date(now.getTime() - 5_000),
        status: "RUNNING",
      },
      {
        id: "review-worker",
        lastSeenAt: new Date(now.getTime() - 5_000),
        status: "RUNNING",
      },
    ]);
    mocks.publicationJobCount.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("keeps prior passed drill evidence when a newer nightly backup is verified", async () => {
    const latestBackup = {
      destinationId: `offsite-verified:${"f".repeat(64)}`,
      encrypted: true,
      objectKey: "situation-studio-20260729T115900Z.dump.gpg",
      checksum: "a".repeat(64),
      byteLength: 4_096n,
      verifiedAt: new Date(now.getTime() - 60_000),
    };
    const priorPassedRestoreDrill = {
      ...latestBackup,
      objectKey: "situation-studio-20260728T115900Z.dump.gpg",
      verifiedAt: new Date(now.getTime() - 86_460_000),
      createdAt: new Date(now.getTime() - 86_460_000),
      restoreDrillAt: new Date(now.getTime() - 86_400_000),
      restoreDrillResult: "PASSED",
    };
    mocks.backupReceiptFindFirst.mockImplementation(
      async (query: { where: { OR?: unknown[] } }) =>
        query.where.OR ? priorPassedRestoreDrill : latestBackup,
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.backup).toEqual({
      state: "verified",
      publicationReady: true,
      evidenceState: "READY",
      ageSeconds: 60,
      encrypted: true,
      restoreDrill: "passed",
      restoreDrillAgeSeconds: 86_400,
    });
    expect(mocks.backupReceiptFindFirst).toHaveBeenNthCalledWith(1, {
      where: { state: "VERIFIED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        destinationId: true,
        encrypted: true,
        objectKey: true,
        checksum: true,
        byteLength: true,
        verifiedAt: true,
      },
    });
    expect(mocks.backupReceiptFindFirst).toHaveBeenNthCalledWith(2, {
      where: {
        state: "VERIFIED",
        OR: [
          { restoreDrillAt: { not: null } },
          { restoreDrillResult: { not: null } },
        ],
      },
      orderBy: [
        { restoreDrillAt: { sort: "desc", nulls: "first" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      select: {
        destinationId: true,
        encrypted: true,
        objectKey: true,
        checksum: true,
        byteLength: true,
        verifiedAt: true,
        createdAt: true,
        restoreDrillAt: true,
        restoreDrillResult: true,
      },
    });
  });

  it("preserves the existing not-yet-passed state and reports a null drill age", async () => {
    mocks.backupReceiptFindFirst.mockImplementation(
      async (query: { where: { OR?: unknown[] } }) =>
        query.where.OR
          ? null
          : {
              destinationId: `offsite-verified:${"f".repeat(64)}`,
              encrypted: true,
              objectKey: "situation-studio-20260729T115900Z.dump.gpg",
              checksum: "a".repeat(64),
              byteLength: 4_096n,
              verifiedAt: new Date(now.getTime() - 60_000),
            },
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.backup).toMatchObject({
      state: "not-yet-verified",
      publicationReady: false,
      evidenceState: "RESTORE_DRILL_MISSING",
      restoreDrill: "not-yet-passed",
      restoreDrillAgeSeconds: null,
    });
  });

  it("reports a newer failed drill instead of hiding it behind an older pass", async () => {
    mocks.backupReceiptFindFirst.mockImplementation(
      async (query: { where: { OR?: unknown[] } }) =>
        query.where.OR
          ? {
              destinationId: `offsite-verified:${"f".repeat(64)}`,
              encrypted: true,
              objectKey: "situation-studio-20260729T115700Z.dump.gpg",
              checksum: "b".repeat(64),
              byteLength: 4_096n,
              verifiedAt: new Date(now.getTime() - 180_000),
              createdAt: new Date(now.getTime() - 180_000),
              restoreDrillAt: new Date(now.getTime() - 120_000),
              restoreDrillResult: "FAILED",
            }
          : {
              destinationId: `offsite-verified:${"f".repeat(64)}`,
              encrypted: true,
              objectKey: "situation-studio-20260729T115900Z.dump.gpg",
              checksum: "a".repeat(64),
              byteLength: 4_096n,
              verifiedAt: new Date(now.getTime() - 60_000),
            },
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.backup).toMatchObject({
      state: "not-yet-verified",
      publicationReady: false,
      evidenceState: "RESTORE_DRILL_FAILED",
      restoreDrill: "not-yet-passed",
      restoreDrillAgeSeconds: 120,
    });
  });

  it("fails closed when the latest recorded drill attempt is partial", async () => {
    mocks.backupReceiptFindFirst.mockImplementation(
      async (query: { where: { OR?: unknown[] } }) =>
        query.where.OR
          ? {
              destinationId: `offsite-verified:${"f".repeat(64)}`,
              encrypted: true,
              objectKey: "situation-studio-20260729T115700Z.dump.gpg",
              checksum: "b".repeat(64),
              byteLength: 4_096n,
              verifiedAt: new Date(now.getTime() - 180_000),
              createdAt: new Date(now.getTime() - 180_000),
              restoreDrillAt: new Date(now.getTime() - 120_000),
              restoreDrillResult: null,
            }
          : {
              destinationId: `offsite-verified:${"f".repeat(64)}`,
              encrypted: true,
              objectKey: "situation-studio-20260729T115900Z.dump.gpg",
              checksum: "a".repeat(64),
              byteLength: 4_096n,
              verifiedAt: new Date(now.getTime() - 60_000),
            },
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.backup).toMatchObject({
      state: "not-yet-verified",
      publicationReady: false,
      evidenceState: "RESTORE_DRILL_INCOMPLETE",
      restoreDrill: "not-yet-passed",
      restoreDrillAgeSeconds: 120,
    });
  });
});
