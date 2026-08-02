import { describe, expect, it } from "vitest";
import {
  backupAttemptHealth,
  publicationRecoveryHealth,
  safeOperationsFailureCode,
} from "../src/server/operations-health";

describe("Operations publication health", () => {
  it("keeps historical terminal jobs separate from actionable recovery", () => {
    expect(
      publicationRecoveryHealth({
        recoveryRequired: 0,
        historicalTerminal: 10,
      }),
    ).toEqual({
      value: "0 active",
      detail: "10 historical restored or failed publications.",
      tone: "healthy",
    });
  });

  it("warns only when a publication is fenced for recovery", () => {
    expect(
      publicationRecoveryHealth({
        recoveryRequired: 2,
        historicalTerminal: 0,
      }),
    ).toEqual({
      value: "2 active",
      detail: "No historical restored or failed publications.",
      tone: "warning",
    });
  });
});

describe("Operations backup health", () => {
  it("identifies a deferred queued request as pending verification", () => {
    expect(
      backupAttemptHealth({
        state: "QUEUED",
        verifiedAtLabel: null,
        readinessMode: "deferred",
      }),
    ).toEqual({
      value: "Deferred",
      detail:
        "The request is queued until backup execution resumes; verification is still pending.",
      tone: "pending",
    });
  });

  it("does not present queued or running attempts as verified", () => {
    expect(
      backupAttemptHealth({
        state: "QUEUED",
        verifiedAtLabel: null,
        readinessMode: "required",
      }),
    ).toEqual({
      value: "Queued",
      detail: "Waiting to run; verification is still pending.",
      tone: "pending",
    });
    expect(
      backupAttemptHealth({
        state: "RUNNING",
        verifiedAtLabel: null,
        readinessMode: "required",
      }),
    ).toEqual({
      value: "Running",
      detail: "Backup is in progress; verification is still pending.",
      tone: "pending",
    });
  });

  it("requires a verification time before displaying a verified state", () => {
    expect(
      backupAttemptHealth({
        state: "VERIFIED",
        verifiedAtLabel: null,
        readinessMode: "required",
      }),
    ).toEqual({
      value: "Unverified",
      detail: "The receipt is missing its verification time.",
      tone: "warning",
    });
    expect(
      backupAttemptHealth({
        state: "VERIFIED",
        verifiedAtLabel: "7/29/2026, 10:30:00 AM",
        readinessMode: "required",
      }),
    ).toEqual({
      value: "Verified",
      detail: "Verified 7/29/2026, 10:30:00 AM.",
      tone: "healthy",
    });
  });

  it("makes missing and failed backup attempts explicit", () => {
    expect(
      backupAttemptHealth({
        state: null,
        verifiedAtLabel: null,
        readinessMode: "deferred",
      }),
    ).toEqual({
      value: "Deferred",
      detail:
        "Backup execution is deferred; no verified receipt has been recorded.",
      tone: "pending",
    });
    expect(
      backupAttemptHealth({
        state: "FAILED",
        verifiedAtLabel: null,
        readinessMode: "required",
        failureCode: "DEPLOYMENT_BACKUP_FAILED",
      }),
    ).toEqual({
      value: "Failed",
      detail:
        "The deployment backup command failed before a verified artifact was recorded for this receipt.",
      tone: "warning",
    });
  });
});

describe("Operations receipt diagnostics", () => {
  it("shows only bounded publisher and backup failure codes", () => {
    expect(
      safeOperationsFailureCode(
        "publication",
        "RUNTIME_IDENTITY_MISMATCH_RESTORED",
      ),
    ).toBe("RUNTIME_IDENTITY_MISMATCH_RESTORED");
    expect(
      safeOperationsFailureCode("backup", "DEPLOYMENT_BACKUP_FAILED"),
    ).toBe("DEPLOYMENT_BACKUP_FAILED");
    expect(
      safeOperationsFailureCode(
        "publication",
        "password=secret publisher stderr",
      ),
    ).toBe("LEGACY_OR_UNSTRUCTURED_FAILURE");
    expect(safeOperationsFailureCode("backup", "s3 secret access key")).toBe(
      "LEGACY_OR_UNSTRUCTURED_FAILURE",
    );
  });
});
