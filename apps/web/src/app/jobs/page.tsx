import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";

export default async function JobsPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  const jobs = await database().aiJob.findMany({
    where: session.permissions.has("system.admin")
      ? {}
      : { ownerId: session.userId },
    orderBy: { createdAt: "desc" },
    include: { situation: true, steps: true },
  });
  return (
    <AppShell user={session.user} csrfToken={session.csrfToken}>
      <section className="pageIntro">
        <div>
          <p className="eyebrow">Durable work</p>
          <h1>Review jobs</h1>
        </div>
        <p className="muted">
          Queue place, product stage, and committed role results remain durable
          across browser and worker restarts.
        </p>
      </section>
      <div className="panel">
        <div className="panelHeader">
          <h2>Current and recent jobs</h2>
        </div>
        <div className="panelBody">
          {jobs.length ? (
            <ul className="timeline">
              {jobs.map((job) => (
                <li key={job.id}>
                  <div>
                    <strong>{job.situation.title}</strong>
                    <br />
                    <span className="muted">
                      {job.stage} ·{" "}
                      {
                        job.steps.filter((step) => step.state === "SUCCEEDED")
                          .length
                      }
                      /{job.steps.length} steps ·{" "}
                      {job.state.toLowerCase().replaceAll("_", " ")}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No review jobs yet.</p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
