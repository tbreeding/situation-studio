export const PUBLICATION_BACKUP_MAX_AGE_SECONDS = 26 * 60 * 60;
export const PUBLICATION_BACKUP_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
export const PUBLICATION_RESTORE_DRILL_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const PUBLICATION_BACKUP_NOT_READY_CODE =
  "PUBLICATION_BACKUP_NOT_READY" as const;

type VerifiedBackupEvidence = {
  destinationId: string;
  encrypted: boolean;
  objectKey: string | null;
  checksum: string | null;
  byteLength: bigint | null;
  verifiedAt: Date | null;
};

type RestoreDrillEvidence = VerifiedBackupEvidence & {
  createdAt: Date | null;
  restoreDrillAt: Date | null;
  restoreDrillResult: string | null;
};

export type PublicationBackupStatus =
  | {
      ready: true;
      state: "READY";
      message: string;
    }
  | {
      ready: false;
      state:
        | "BACKUP_MISSING"
        | "BACKUP_INCOMPLETE"
        | "BACKUP_TIMESTAMP_INVALID"
        | "BACKUP_STALE"
        | "RESTORE_DRILL_MISSING"
        | "RESTORE_DRILL_INCOMPLETE"
        | "RESTORE_DRILL_TIMESTAMP_INVALID"
        | "RESTORE_DRILL_STALE"
        | "RESTORE_DRILL_FAILED";
      message: string;
    };

function completeVerifiedBackup(
  backup: VerifiedBackupEvidence | null,
): backup is VerifiedBackupEvidence & { verifiedAt: Date } {
  return Boolean(
    backup &&
    /^offsite-verified:[a-f0-9]{64}$/u.test(backup.destinationId) &&
    backup.encrypted === true &&
    backup.objectKey &&
    /^[a-zA-Z0-9._-]+$/u.test(backup.objectKey) &&
    backup.checksum &&
    /^[a-f0-9]{64}$/u.test(backup.checksum) &&
    backup.byteLength !== null &&
    backup.byteLength > 0n &&
    backup.verifiedAt &&
    Number.isFinite(backup.verifiedAt.getTime()),
  );
}

export function publicationBackupStatus(input: {
  latestVerifiedBackup: VerifiedBackupEvidence | null;
  latestRestoreDrill: RestoreDrillEvidence | null;
  now?: Date;
}): PublicationBackupStatus {
  const { latestVerifiedBackup, latestRestoreDrill } = input;
  if (!latestVerifiedBackup)
    return {
      ready: false,
      state: "BACKUP_MISSING",
      message:
        "Production submission is paused until a recent encrypted backup is verified.",
    };
  if (!completeVerifiedBackup(latestVerifiedBackup))
    return {
      ready: false,
      state: "BACKUP_INCOMPLETE",
      message:
        "Production submission is paused because the latest verified backup receipt is incomplete.",
    };

  const now = input.now ?? new Date();
  const backupAgeMilliseconds =
    now.getTime() - latestVerifiedBackup.verifiedAt.getTime();
  if (
    backupAgeMilliseconds <
    -PUBLICATION_BACKUP_MAX_FUTURE_SKEW_SECONDS * 1_000
  )
    return {
      ready: false,
      state: "BACKUP_TIMESTAMP_INVALID",
      message:
        "Production submission is paused because the latest backup receipt has an invalid future verification time.",
    };
  if (backupAgeMilliseconds > PUBLICATION_BACKUP_MAX_AGE_SECONDS * 1_000)
    return {
      ready: false,
      state: "BACKUP_STALE",
      message:
        "Production submission is paused because the latest verified encrypted backup is more than 26 hours old.",
    };

  if (!latestRestoreDrill)
    return {
      ready: false,
      state: "RESTORE_DRILL_MISSING",
      message:
        "Production submission is paused until a restore drill has passed.",
    };
  if (
    !latestRestoreDrill.restoreDrillAt ||
    !latestRestoreDrill.restoreDrillResult ||
    !latestRestoreDrill.createdAt ||
    !Number.isFinite(latestRestoreDrill.createdAt.getTime()) ||
    !completeVerifiedBackup(latestRestoreDrill)
  )
    return {
      ready: false,
      state: "RESTORE_DRILL_INCOMPLETE",
      message:
        "Production submission is paused because the latest restore drill is not tied to a complete verified off-site backup receipt.",
    };
  const restoreDrillTime = latestRestoreDrill.restoreDrillAt.getTime();
  const restoreDrillAgeMilliseconds = now.getTime() - restoreDrillTime;
  if (
    !Number.isFinite(restoreDrillTime) ||
    restoreDrillTime < latestRestoreDrill.verifiedAt.getTime() ||
    restoreDrillTime < latestRestoreDrill.createdAt.getTime() ||
    restoreDrillAgeMilliseconds <
      -PUBLICATION_BACKUP_MAX_FUTURE_SKEW_SECONDS * 1_000
  )
    return {
      ready: false,
      state: "RESTORE_DRILL_TIMESTAMP_INVALID",
      message:
        "Production submission is paused because the latest restore drill time is invalid relative to its backup receipt.",
    };
  if (
    restoreDrillAgeMilliseconds >
    PUBLICATION_RESTORE_DRILL_MAX_AGE_SECONDS * 1_000
  )
    return {
      ready: false,
      state: "RESTORE_DRILL_STALE",
      message:
        "Production submission is paused because the latest restore drill is more than 30 days old.",
    };
  if (latestRestoreDrill.restoreDrillResult !== "PASSED")
    return {
      ready: false,
      state: "RESTORE_DRILL_FAILED",
      message:
        "Production submission is paused because the most recent restore drill did not pass.",
    };

  return {
    ready: true,
    state: "READY",
    message: "Encrypted backup and restore-drill evidence is ready.",
  };
}
