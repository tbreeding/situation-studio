import { describe, expect, it } from "vitest";
import {
  PUBLICATION_BACKUP_MAX_AGE_SECONDS,
  PUBLICATION_RESTORE_DRILL_MAX_AGE_SECONDS,
  publicationBackupStatus,
} from "../src/server/health/publication-backup-policy";

const now = new Date("2026-08-01T12:00:00.000Z");
const completeBackup = {
  destinationId: `offsite-verified:${"f".repeat(64)}`,
  encrypted: true,
  objectKey: "situation-studio-20260801T110000Z.dump.gpg",
  checksum: "a".repeat(64),
  byteLength: 4_096n,
  verifiedAt: new Date(now.getTime() - 60_000),
};
const passedDrill = {
  ...completeBackup,
  objectKey: "situation-studio-20260712T115900Z.dump.gpg",
  verifiedAt: new Date(now.getTime() - 20 * 86_400_000 - 60_000),
  createdAt: new Date(now.getTime() - 20 * 86_400_000 - 60_000),
  restoreDrillAt: new Date(now.getTime() - 20 * 86_400_000),
  restoreDrillResult: "PASSED",
};

describe("publication backup policy", () => {
  it("accepts a complete recent encrypted receipt and the latest passed drill", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toEqual({
      ready: true,
      state: "READY",
      message: "Encrypted backup and restore-drill evidence is ready.",
    });
  });

  it("fails closed when verified backup evidence is missing or incomplete", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: null,
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: false, state: "BACKUP_MISSING" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: { ...completeBackup, encrypted: false },
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: false, state: "BACKUP_INCOMPLETE" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: {
          ...completeBackup,
          destinationId: "local-only",
        },
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: false, state: "BACKUP_INCOMPLETE" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: { ...completeBackup, checksum: null },
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: false, state: "BACKUP_INCOMPLETE" });
  });

  it("rejects materially future backup and restore-drill timestamps", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: {
          ...completeBackup,
          verifiedAt: new Date(now.getTime() + 5 * 60_000 + 1_000),
        },
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: false, state: "BACKUP_TIMESTAMP_INVALID" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: {
          ...completeBackup,
          verifiedAt: new Date(Number.NaN),
        },
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: false, state: "BACKUP_INCOMPLETE" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          restoreDrillAt: new Date(now.getTime() + 5 * 60_000 + 1_000),
        },
        now,
      }),
    ).toMatchObject({
      ready: false,
      state: "RESTORE_DRILL_TIMESTAMP_INVALID",
    });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          restoreDrillAt: new Date(Number.NaN),
        },
        now,
      }),
    ).toMatchObject({
      ready: false,
      state: "RESTORE_DRILL_TIMESTAMP_INVALID",
    });
  });

  it("uses the readiness freshness boundary and rejects an older receipt", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: {
          ...completeBackup,
          verifiedAt: new Date(
            now.getTime() - PUBLICATION_BACKUP_MAX_AGE_SECONDS * 1_000,
          ),
        },
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: true, state: "READY" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: {
          ...completeBackup,
          verifiedAt: new Date(
            now.getTime() - (PUBLICATION_BACKUP_MAX_AGE_SECONDS + 1) * 1_000,
          ),
        },
        latestRestoreDrill: passedDrill,
        now,
      }),
    ).toMatchObject({ ready: false, state: "BACKUP_STALE" });
  });

  it("requires the most recent recorded restore drill to pass", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: null,
        now,
      }),
    ).toMatchObject({ ready: false, state: "RESTORE_DRILL_MISSING" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          restoreDrillAt: new Date(now.getTime() - 30_000),
          restoreDrillResult: "FAILED",
        },
        now,
      }),
    ).toMatchObject({ ready: false, state: "RESTORE_DRILL_FAILED" });
  });

  it("requires the drill receipt itself to carry complete off-site evidence", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          destinationId: "local-only",
        },
        now,
      }),
    ).toMatchObject({ ready: false, state: "RESTORE_DRILL_INCOMPLETE" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: { ...passedDrill, byteLength: null },
        now,
      }),
    ).toMatchObject({ ready: false, state: "RESTORE_DRILL_INCOMPLETE" });
  });

  it("rejects a drill timestamp before its receipt was verified", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          restoreDrillAt: new Date(passedDrill.verifiedAt.getTime() - 1),
        },
        now,
      }),
    ).toMatchObject({
      ready: false,
      state: "RESTORE_DRILL_TIMESTAMP_INVALID",
    });
  });

  it("rejects a copied drill timestamp from before an attestation receipt existed", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          createdAt: new Date(passedDrill.restoreDrillAt.getTime() + 1),
        },
        now,
      }),
    ).toMatchObject({
      ready: false,
      state: "RESTORE_DRILL_TIMESTAMP_INVALID",
    });
  });

  it("classifies partial recorded drill attempts as incomplete", () => {
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          restoreDrillResult: null,
        },
        now,
      }),
    ).toMatchObject({ ready: false, state: "RESTORE_DRILL_INCOMPLETE" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          restoreDrillAt: null,
        },
        now,
      }),
    ).toMatchObject({ ready: false, state: "RESTORE_DRILL_INCOMPLETE" });
  });

  it("uses the restore-drill freshness boundary and rejects an older drill", () => {
    const verifiedAt = new Date(
      now.getTime() -
        PUBLICATION_RESTORE_DRILL_MAX_AGE_SECONDS * 1_000 -
        60_000,
    );
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          verifiedAt,
          createdAt: verifiedAt,
          restoreDrillAt: new Date(
            now.getTime() - PUBLICATION_RESTORE_DRILL_MAX_AGE_SECONDS * 1_000,
          ),
        },
        now,
      }),
    ).toMatchObject({ ready: true, state: "READY" });
    expect(
      publicationBackupStatus({
        latestVerifiedBackup: completeBackup,
        latestRestoreDrill: {
          ...passedDrill,
          verifiedAt,
          createdAt: verifiedAt,
          restoreDrillAt: new Date(
            now.getTime() -
              (PUBLICATION_RESTORE_DRILL_MAX_AGE_SECONDS + 1) * 1_000,
          ),
        },
        now,
      }),
    ).toMatchObject({ ready: false, state: "RESTORE_DRILL_STALE" });
  });
});
