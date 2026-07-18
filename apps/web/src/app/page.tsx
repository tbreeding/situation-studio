import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";

export default async function SituationsPage() {
  const session = await currentSession();
  if (!session) redirect("/login?expired=1");
  const situations = await database().situation.findMany({
    orderBy: { title: "asc" },
    include: {
      checkouts: {
        where: { releasedAt: null },
        include: { holder: true },
        take: 1,
      },
      drafts: { where: { active: true }, take: 1 },
      currentPublication: true,
    },
  });
  return (
    <AppShell user={session.user} csrfToken={session.csrfToken}>
      <section className="pageIntro">
        <div>
          <p className="eyebrow">Leadership content operations</p>
          <h1>One rule. Every learning surface.</h1>
        </div>
        <p className="muted">
          Work from the exact published baseline, see the complete blast radius,
          and move one immutable bundle through challenge, human review,
          validation, preview, and publication.
        </p>
      </section>
      <div className="policyBanner">
        <span>
          <strong>Sensitive-data boundary:</strong> use synthetic or anonymized
          workplace context only. Never enter PII, credentials, customer
          secrets, health data, or identifiable employee details.
        </span>
        <span className="badge rust">Private beta</span>
      </div>
      <div className="inventoryToolbar">
        <div className="badges">
          <span className="badge">{situations.length} situations</span>
          <span className="badge gold">
            {situations.filter((item) => item.checkouts.length).length} checked
            out
          </span>
        </div>
        {session.permissions.has("situation.create") && (
          <Link className="button" href="/situations/new">
            New situation
          </Link>
        )}
      </div>
      <div className="situationGrid">
        {situations.map((situation) => {
          const checkout = situation.checkouts[0];
          const draft = situation.drafts[0];
          return (
            <Link
              className="situationCard"
              href={`/situations/${situation.slug}`}
              key={situation.id}
            >
              <div className="badges">
                <span className="badge ink">
                  {situation.publicationState.replaceAll("_", " ")}
                </span>
                {draft && (
                  <span className="badge gold">
                    {draft.state.replaceAll("_", " ")}
                  </span>
                )}
                {checkout && <span className="badge rust">Checked out</span>}
              </div>
              <h2>{situation.title}</h2>
              <p>
                {checkout
                  ? `Exclusive ${checkout.mode.toLowerCase().replaceAll("_", " ")} checkout held by ${checkout.holder?.displayName ?? "a server job"}.`
                  : "Available for an exclusive editing or review checkout."}
              </p>
              <div className="cardFoot">
                <span>{situation.lifecycle.toLowerCase()}</span>
                <span>
                  {checkout
                    ? `Active ${checkout.renewedAt.toISOString().slice(0, 10)}`
                    : "Open workspace →"}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </AppShell>
  );
}
