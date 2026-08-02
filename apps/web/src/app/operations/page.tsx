import { AppShell } from "@/components/app-shell";
import { OperationsDashboard } from "@/components/operations-dashboard";
import { OperationsEvidence } from "@/components/operations-evidence";
import { requireSession } from "@/server/auth/request";
import { database } from "@/server/database";
import { publicationBackupStatus } from "@/server/health/publication-backup-policy";
import {
  backupAttemptHealth,
  publicationRecoveryHealth,
  safeOperationsFailureCode,
} from "@/server/operations-health";
import {
  buildPublicationStatusSnapshot,
  type PublicationStatusRecord,
} from "@/server/publication-status";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const session = await requireSession("/operations");
  if (!session.roles.has("ADMIN")) redirect("/");
  const [
    users,
    checkouts,
    reviewQueue,
    reviewHeartbeat,
    recoveryRequired,
    historicalTerminalPublications,
    terminalPublicationReceipts,
    sync,
    backupReceipts,
    latestVerifiedBackup,
    latestRestoreDrill,
  ] = await Promise.all([
    database().user.findMany({
      orderBy: { displayName: "asc" },
      include: { roles: true },
    }),
    database().situationCheckout.findMany({
      where: { releasedAt: null },
      orderBy: { acquiredAt: "asc" },
      include: { holder: true, situation: true },
    }),
    database().reviewJob.count({
      where: { state: { in: ["QUEUED", "RUNNING"] } },
    }),
    database().processHeartbeat.findUnique({
      where: { id: "review-worker" },
    }),
    database().publicationJob.count({
      where: { state: "RECOVERY_REQUIRED" },
    }),
    database().publicationJob.count({
      where: { state: { in: ["FAILED", "RESTORED"] } },
    }),
    database().publicationJob.findMany({
      where: { state: { in: ["FAILED", "RESTORED", "RECOVERY_REQUIRED"] } },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        state: true,
        failureCode: true,
        createdAt: true,
        finishedAt: true,
        situation: { select: { title: true } },
        events: {
          orderBy: { sequence: "asc" },
          select: {
            sequence: true,
            kind: true,
            createdAt: true,
            payload: true,
          },
        },
      },
    }),
    database().leadershipSyncCursor.findUnique({ where: { id: "official" } }),
    database().backupReceipt.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    database().backupReceipt.findFirst({
      where: { state: "VERIFIED" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    database().backupReceipt.findFirst({
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
    }),
  ]);
  const publicationHealth = publicationRecoveryHealth({
    recoveryRequired,
    historicalTerminal: historicalTerminalPublications,
  });
  const backup = backupReceipts[0] ?? null;
  const backupHealth = backupAttemptHealth({
    state: backup?.state ?? null,
    verifiedAtLabel: backup?.verifiedAt?.toLocaleString() ?? null,
    readinessMode: process.env.SITUATION_STUDIO_BACKUP_READINESS_MODE,
    failureCode: backup?.failureCode ?? null,
  });
  const backupReadiness = publicationBackupStatus({
    latestVerifiedBackup,
    latestRestoreDrill,
  });
  const publicationEvidence = terminalPublicationReceipts.map((publication) => {
    const snapshot = buildPublicationStatusSnapshot(
      publication as PublicationStatusRecord,
    );
    return {
      id: publication.id,
      subject: publication.situation.title,
      state: snapshot.state,
      diagnosticCode: safeOperationsFailureCode(
        "publication",
        publication.failureCode,
      ),
      detail:
        snapshot.terminal?.message ??
        "The publisher did not record a safe terminal explanation.",
      recordedAtLabel: (
        publication.finishedAt ?? publication.createdAt
      ).toLocaleString(),
    };
  });
  const backupEvidence = backupReceipts.map((receipt) => ({
    id: receipt.id,
    subject: receipt.publicationJobId
      ? `Publication ${receipt.publicationJobId}`
      : "Scheduled or deployment backup",
    state: receipt.state,
    diagnosticCode: safeOperationsFailureCode("backup", receipt.failureCode),
    detail: backupAttemptHealth({
      state: receipt.state,
      verifiedAtLabel: receipt.verifiedAt?.toLocaleString() ?? null,
      readinessMode: process.env.SITUATION_STUDIO_BACKUP_READINESS_MODE,
      failureCode: receipt.failureCode,
    }).detail,
    recordedAtLabel: receipt.createdAt.toLocaleString(),
  }));
  return (
    <AppShell
      active="operations"
      csrfToken={session.csrfToken}
      user={{ displayName: session.user.displayName, isAdmin: true }}
    >
      <main className="operationsPage">
        <header className="pageIntro">
          <div>
            <p className="eyebrow">Administration</p>
            <h1>Keep the workbench healthy.</h1>
            <p>
              Access, durable ownership, queue health, publication recovery,
              synchronization, and backups—without editorial lifecycle noise.
            </p>
          </div>
        </header>
        <section className="healthStrip" aria-label="Operational health">
          <article
            className={
              reviewHeartbeat?.status.startsWith("PROVIDER_")
                ? "healthWarning"
                : ""
            }
          >
            <span>Review queue</span>
            <strong>{reviewQueue}</strong>
            <small>
              {reviewHeartbeat?.status.startsWith("PROVIDER_")
                ? reviewHeartbeat.status.toLowerCase().replaceAll("_", " ")
                : "one running globally"}
            </small>
          </article>
          <article
            className={
              publicationHealth.tone === "warning" ? "healthWarning" : ""
            }
          >
            <span>Publication recovery</span>
            <strong>{publicationHealth.value}</strong>
            <small>{publicationHealth.detail}</small>
          </article>
          <article>
            <span>Leadership observation</span>
            <strong>{sync?.lastSuccessfulAt ? "Current" : "Waiting"}</strong>
            <small>
              {sync?.lastSuccessfulAt
                ? sync.lastSuccessfulAt.toLocaleString()
                : "not yet synchronized"}
            </small>
          </article>
          <article className={backupReadiness.ready ? "" : "healthWarning"}>
            <span>Backup readiness</span>
            <strong>{backupReadiness.ready ? "Ready" : "Paused"}</strong>
            <small>{backupReadiness.message}</small>
          </article>
          <article
            className={
              backupHealth.tone === "warning"
                ? "healthWarning"
                : backupHealth.tone === "pending"
                  ? "healthPending"
                  : ""
            }
          >
            <span>Latest backup attempt</span>
            <strong>{backupHealth.value}</strong>
            <small>{backupHealth.detail}</small>
          </article>
        </section>
        <OperationsEvidence
          publications={publicationEvidence}
          backups={backupEvidence}
        />
        <OperationsDashboard
          csrfToken={session.csrfToken}
          users={users.map((user) => ({
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            state: user.state,
            roles: user.roles.map((role) => role.role),
            lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
          }))}
          checkouts={checkouts.map((checkout) => ({
            id: checkout.id,
            situationId: checkout.situationId,
            situationTitle: checkout.situation.title,
            holderName: checkout.holder.displayName,
            acquiredAt: checkout.acquiredAt.toISOString(),
          }))}
        />
      </main>
    </AppShell>
  );
}
