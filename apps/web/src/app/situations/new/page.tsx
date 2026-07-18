import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { NewSituationForm } from "@/components/new-situation-form";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";

export default async function NewSituationPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  if (!session.permissions.has("situation.create")) redirect("/");
  const relatedSituations = await database().situation.findMany({
    where: { lifecycle: "ACTIVE" },
    select: { slug: true, title: true },
    orderBy: { title: "asc" },
  });
  return (
    <AppShell user={session.user} csrfToken={session.csrfToken}>
      <section className="pageIntro">
        <div>
          <p className="eyebrow">
            Grilling-based discovery · human confirmation
          </p>
          <h1>Start with a rule worth teaching.</h1>
        </div>
        <p className="muted">
          Resolve the context, constraints, unknowns, safety boundary, and
          learning objective before any candidate guidance or AI review exists.
        </p>
      </section>
      <div className="policyBanner">
        <span>
          <strong>Do not enter:</strong> names, emails, credentials, health
          information, customer secrets, or details that identify an employee.
        </span>
        <span className="badge rust">Sensitive-data gate</span>
      </div>
      <NewSituationForm
        csrfToken={session.csrfToken}
        relatedSituations={relatedSituations}
      />
    </AppShell>
  );
}
