import { redirect } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import { MODEL_POLICY } from "@situation-studio/domain";

export default async function CapacityPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  const providers = (
    await database().providerAccount.findMany({
      orderBy: { label: "asc" },
    })
  ).sort((left, right) => {
    const leftPriority = MODEL_POLICY.priority.indexOf(
      left.provider as (typeof MODEL_POLICY.priority)[number],
    );
    const rightPriority = MODEL_POLICY.priority.indexOf(
      right.provider as (typeof MODEL_POLICY.priority)[number],
    );
    return (
      (leftPriority < 0 ? MODEL_POLICY.priority.length : leftPriority) -
      (rightPriority < 0 ? MODEL_POLICY.priority.length : rightPriority)
    );
  });
  return (
    <AppShell
      user={session.user}
      csrfToken={session.csrfToken}
      canAccessAdministration={session.permissions.has("system.admin")}
    >
      <section className="pageIntro compactIntro">
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
              <span className="badge gold">
                {provider.provider === MODEL_POLICY.priority[0]
                  ? "Primary · Codex"
                  : provider.provider === MODEL_POLICY.priority[1]
                    ? "Fallback · Claude"
                    : "Acceptance fixture"}
              </span>
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
        <section className="panel emptyState">
          <p className="eyebrow">Safe disabled state</p>
          <h2>AI review providers are disabled</h2>
          <p>
            No provider account is configured, so AI-assisted review cannot be
            started. Manual editing remains available to permitted operators.
          </p>
          <Link className="button secondary" href="/">
            Continue with situations
          </Link>
          <details className="technicalDisclosure">
            <summary>Technical details</summary>
            <p>
              Provider capability: disabled. Deterministic adapter runs are
              restricted to the local acceptance environment and are not a
              production provider.
            </p>
            <p>
              Last checked: <time>{new Date().toISOString()}</time>
            </p>
          </details>
        </section>
      )}
    </AppShell>
  );
}
