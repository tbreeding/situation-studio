import { AppShell } from "@/components/app-shell";
import { OperationsDashboard } from "@/components/operations-dashboard";
import { requireSession } from "@/server/auth/request";
import { database } from "@/server/database";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OperationsPage() {
  const session = await requireSession("/operations");
  if (!session.roles.has("ADMIN")) redirect("/");
  const [users, checkouts, reviewQueue, failedPublications, sync, backup] =
    await Promise.all([
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
      database().publicationJob.count({
        where: { state: { in: ["FAILED", "RESTORED", "RECOVERY_REQUIRED"] } },
      }),
      database().leadershipSyncCursor.findUnique({ where: { id: "official" } }),
      database().backupReceipt.findFirst({ orderBy: { createdAt: "desc" } }),
    ]);
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
        <div className="healthStrip">
          <article>
            <span>Review queue</span>
            <strong>{reviewQueue}</strong>
            <small>one running globally</small>
          </article>
          <article className={failedPublications ? "healthWarning" : ""}>
            <span>Publisher failures</span>
            <strong>{failedPublications}</strong>
            <small>{failedPublications ? "attention needed" : "clear"}</small>
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
          <article
            className={backup?.state === "FAILED" ? "healthWarning" : ""}
          >
            <span>Latest backup</span>
            <strong>{backup?.state ?? "Waiting"}</strong>
            <small>
              {backup?.verifiedAt
                ? backup.verifiedAt.toLocaleString()
                : "no verified receipt yet"}
            </small>
          </article>
        </div>
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
