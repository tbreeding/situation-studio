import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationsEvidence } from "../src/components/operations-evidence";

describe("Operations receipt evidence", () => {
  it("keeps publisher and backup outcomes distinct at receipt level", () => {
    const markup = renderToStaticMarkup(
      createElement(OperationsEvidence, {
        publications: [
          {
            id: "publisher-receipt-id",
            subject: "High performer hurting the team",
            state: "RESTORED",
            diagnosticCode: "RUNTIME_IDENTITY_MISMATCH_RESTORED",
            detail: "The previous verified version was restored.",
            recordedAtLabel: "8/2/2026, 10:00:00 AM",
          },
        ],
        backups: [
          {
            id: "backup-receipt-id",
            subject: "Scheduled or deployment backup",
            state: "FAILED",
            diagnosticCode: "DEPLOYMENT_BACKUP_FAILED",
            detail:
              "The deployment backup command failed before a verified artifact was recorded for this receipt.",
            recordedAtLabel: "8/2/2026, 10:01:00 AM",
          },
        ],
      }),
    );

    expect(markup).toContain("Publisher receipts");
    expect(markup).toContain("publisher-receipt-id");
    expect(markup).toContain("RUNTIME_IDENTITY_MISMATCH_RESTORED");
    expect(markup).toContain("Backup receipts");
    expect(markup).toContain("backup-receipt-id");
    expect(markup).toContain("DEPLOYMENT_BACKUP_FAILED");
  });
});
