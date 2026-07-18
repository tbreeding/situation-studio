import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import { UserAdministration } from "@/components/user-administration";

export default async function AdministrationPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  if (!session.permissions.has("system.admin")) redirect("/");
  const [users, audits, incidents] = await Promise.all([
    database().user.findMany({
      orderBy: { username: "asc" },
      include: { roleAssignments: { include: { role: true } } },
    }),
    database().auditEvent.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    database().systemIncident.findMany({
      where: { state: { not: "RESOLVED" } },
      orderBy: { detectedAt: "desc" },
    }),
  ]);
  return (
    <AppShell user={session.user} csrfToken={session.csrfToken}>
      <section className="pageIntro administrationIntro">
        <div>
          <p className="eyebrow">Restricted operations</p>
          <h1>Administration</h1>
        </div>
        <p className="muted">
          Access, provider, audit, checkout, and incident controls are visible
          only to permitted administrators.
        </p>
      </section>
      <div className="administrationGrid">
        <UserAdministration
          csrfToken={session.csrfToken}
          users={users.map((user) => ({
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            state: user.state,
            roles: user.roleAssignments.map((item) => item.role.code),
            isSelf: user.id === session.userId,
          }))}
        />
        <section className="panel administrationAudit">
          <div className="panelHeader">
            <h2>Audit trail</h2>
          </div>
          <div className="panelBody">
            <ul className="timeline auditTimeline">
              {audits.map((event) => (
                <li key={event.id}>
                  <div>
                    <strong>{event.action}</strong> ·{" "}
                    {event.outcome.toLowerCase()}
                    <br />
                    <span className="muted auditMetadata">
                      {event.targetType} {event.targetId ?? ""} ·{" "}
                      {event.createdAt.toISOString()}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <aside className="panel administrationIncidents">
          <div className="panelHeader">
            <h2>Open incidents</h2>
          </div>
          <div className="panelBody">
            {incidents.length ? (
              incidents.map((incident) => (
                <p key={incident.id} className="alert">
                  {incident.severity}: {incident.type}
                </p>
              ))
            ) : (
              <p className="statusLine">
                <span className="dot" />
                No open incidents
              </p>
            )}
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
