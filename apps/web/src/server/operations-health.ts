export type OperationsHealthTone = "healthy" | "pending" | "warning";

export type OperationsHealthSummary = {
  value: string;
  detail: string;
  tone: OperationsHealthTone;
};

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

  if (input.state === "FAILED")
    return {
      value: "Failed",
      detail:
        "The latest attempt failed; no new verified receipt was recorded.",
      tone: "warning",
    };

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
