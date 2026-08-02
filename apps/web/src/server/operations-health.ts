export type OperationsHealthTone = "healthy" | "pending" | "warning";

export type OperationsHealthSummary = {
  value: string;
  detail: string;
  tone: OperationsHealthTone;
};

const SAFE_PUBLICATION_FAILURE_CODES = new Set([
  "AFFECTED_ROUTE_VERIFICATION_FAILED",
  "AFFECTED_ROUTE_VERIFICATION_FAILED_RESTORED",
  "AUTOMATIC_RESTORATION_FAILED",
  "CANONICAL_SNAPSHOT_INVALID",
  "PRACTICE_EMBED_MISMATCH",
  "PREPARED_ACTION_MISMATCH",
  "PROMOTION_STATE_UNVERIFIED",
  "PUBLICATION_AUTHORITY_LOST",
  "PUBLICATION_FAILED",
  "PUBLICATION_RECOVERY_RECONCILED",
  "PUBLISHER_PROCESS_INTERRUPTED",
  "RUNTIME_CAPABILITY_UNAVAILABLE",
  "RUNTIME_CAPABILITY_UNAVAILABLE_RESTORED",
  "RUNTIME_HEALTH_INVALID_RESPONSE",
  "RUNTIME_HEALTH_INVALID_RESPONSE_RESTORED",
  "RUNTIME_HEALTH_UNAVAILABLE",
  "RUNTIME_HEALTH_UNAVAILABLE_RESTORED",
  "RUNTIME_IDENTITY_MISMATCH",
  "RUNTIME_IDENTITY_MISMATCH_RESTORED",
  "TYPED_PROJECTION_INVALID",
  "UNSUPPORTED_CONTRACT_IDENTITY",
  "UNSUPPORTED_CONTRACT_IDENTITY_RESTORED",
  "UNSUPPORTED_VERSION_PAIR",
  "UNSUPPORTED_VERSION_PAIR_RESTORED",
  "VERIFICATION_FAILED_RESTORED",
]);

const SAFE_BACKUP_FAILURE_CODES = new Set([
  "BACKUP_COMMAND_FAILED",
  "BACKUP_RUNNER_STALE",
  "DEPLOYMENT_BACKUP_FAILED",
]);

export function safeOperationsFailureCode(
  kind: "publication" | "backup",
  failureCode: string | null,
) {
  if (!failureCode) return null;
  const codes =
    kind === "publication"
      ? SAFE_PUBLICATION_FAILURE_CODES
      : SAFE_BACKUP_FAILURE_CODES;
  return codes.has(failureCode)
    ? failureCode
    : "LEGACY_OR_UNSTRUCTURED_FAILURE";
}

export function publicationRecoveryHealth(input: {
  recoveryRequired: number;
  historicalTerminal: number;
}): OperationsHealthSummary {
  const historicalDetail =
    input.historicalTerminal === 0
      ? "No historical restored or failed publications."
      : `${input.historicalTerminal} historical restored or failed ${
          input.historicalTerminal === 1 ? "publication" : "publications"
        }.`;

  return {
    value: `${input.recoveryRequired} active`,
    detail: historicalDetail,
    tone: input.recoveryRequired > 0 ? "warning" : "healthy",
  };
}

type BackupAttemptState = "QUEUED" | "RUNNING" | "VERIFIED" | "FAILED";

export function backupAttemptHealth(input: {
  state: BackupAttemptState | null;
  verifiedAtLabel: string | null;
  readinessMode: string | undefined;
  failureCode?: string | null;
}): OperationsHealthSummary {
  if (input.state === "VERIFIED") {
    if (!input.verifiedAtLabel)
      return {
        value: "Unverified",
        detail: "The receipt is missing its verification time.",
        tone: "warning",
      };

    return {
      value: "Verified",
      detail: `Verified ${input.verifiedAtLabel}.`,
      tone: "healthy",
    };
  }

  if (input.state === "FAILED") {
    const detail =
      input.failureCode === "DEPLOYMENT_BACKUP_FAILED"
        ? "The deployment backup command failed before a verified artifact was recorded for this receipt."
        : input.failureCode === "BACKUP_RUNNER_STALE"
          ? "A stale running backup receipt was failed closed before a verified artifact was recorded."
          : input.failureCode === "BACKUP_COMMAND_FAILED"
            ? "The backup command failed before a verified artifact was recorded for this receipt."
            : "The latest attempt failed; no new verified receipt was recorded.";
    return {
      value: "Failed",
      detail,
      tone: "warning",
    };
  }

  if (input.state === "RUNNING")
    return {
      value: "Running",
      detail: "Backup is in progress; verification is still pending.",
      tone: "pending",
    };

  if (input.state === "QUEUED") {
    if (input.readinessMode === "deferred")
      return {
        value: "Deferred",
        detail:
          "The request is queued until backup execution resumes; verification is still pending.",
        tone: "pending",
      };

    return {
      value: "Queued",
      detail: "Waiting to run; verification is still pending.",
      tone: "pending",
    };
  }

  if (input.readinessMode === "deferred")
    return {
      value: "Deferred",
      detail:
        "Backup execution is deferred; no verified receipt has been recorded.",
      tone: "pending",
    };

  return {
    value: "Not started",
    detail: "No backup attempt or verified receipt has been recorded.",
    tone: "pending",
  };
}
