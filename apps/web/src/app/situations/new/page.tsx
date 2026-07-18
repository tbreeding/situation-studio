import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { NewSituationForm } from "@/components/new-situation-form";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";

export default async function NewSituationPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  if (!session.permissions.has("situation.create")) redirect("/");
  const situations = await database().situation.findMany({
    select: { slug: true, title: true, lifecycle: true },
    orderBy: { title: "asc" },
  });
  const relatedSituations = situations.filter(
    (situation) => situation.lifecycle === "ACTIVE",
  );
  return (
    <AppShell
      user={session.user}
      csrfToken={session.csrfToken}
      canAccessAdministration={session.permissions.has("system.admin")}
    >
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <Link href="/">Situations</Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">New situation</span>
      </nav>
      <section className="pageIntro compactIntro">
        <div>
          <p className="eyebrow">
            Discovery brief · deliberate human confirmation
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
        existingSlugs={situations.map((situation) => situation.slug)}
      />
    </AppShell>
  );
}
