import { redirect } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import { JobActions } from "@/components/job-actions";
import { workflowRoles } from "@situation-studio/domain";

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
    <AppShell
      user={session.user}
      csrfToken={session.csrfToken}
      canAccessAdministration={session.permissions.has("system.admin")}
    >
      <section className="pageIntro compactIntro">
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
                      /{workflowRoles.length} steps ·{" "}
                      {job.state.toLowerCase().replaceAll("_", " ")}
                    </span>
                  </div>
                  {job.ownerId === session.userId ||
                  session.permissions.has("system.admin") ? (
                    <JobActions
                      jobId={job.id}
                      state={job.state}
                      csrfToken={session.csrfToken}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="emptyState">
              <p className="eyebrow">Nothing is waiting</p>
              <h3>No review jobs yet</h3>
              {session.permissions.has("ai.run") ? (
                <>
                  <p>
                    A job appears here after an eligible situation is checked
                    out and its operator starts a complete review. Existing
                    published guidance remains available, and manual editing is
                    unaffected.
                  </p>
                  <Link className="button secondary" href="/">
                    Find an eligible situation
                  </Link>
                </>
              ) : (
                <>
                  <p>
                    Your current permissions can monitor review history but
                    cannot start a review job. A permitted editor creates one
                    from a checked-out situation workspace.
                  </p>
                  <Link className="button secondary" href="/">
                    Return to situations
                  </Link>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
