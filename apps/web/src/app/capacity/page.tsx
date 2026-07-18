import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";

export default async function CapacityPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  const providers = await database().providerAccount.findMany({
    orderBy: [{ provider: "asc" }, { label: "asc" }],
  });
  return (
    <AppShell user={session.user} csrfToken={session.csrfToken}>
      <section className="pageIntro">
        <div>
          <p className="eyebrow">Provider admission</p>
          <h1>Capacity</h1>
        </div>
        <p className="muted">
          Availability is operational status, not web readiness. Manual editing
          remains available while providers wait.
        </p>
      </section>
      <div className="situationGrid">
        {providers.map((provider) => (
          <article className="situationCard" key={provider.id}>
            <div className="badges">
              <span
                className={`badge ${provider.state === "ENABLED" ? "" : "rust"}`}
              >
                {provider.state}
              </span>
            </div>
            <h2>{provider.label}</h2>
            <p>
              {provider.provider} ·{" "}
              {provider.credentialMode.toLowerCase().replaceAll("_", " ")}
            </p>
            <div className="cardFoot">
              <span>No credentials exposed</span>
              <span>{provider.updatedAt.toISOString()}</span>
            </div>
          </article>
        ))}
      </div>
      {!providers.length && (
        <div className="panel empty">
          No provider account is configured. Deterministic CI reviews remain
          available only in fake mode.
        </div>
      )}
    </AppShell>
  );
}
