import { AppShell } from "@/components/app-shell";
import { NewSituationForm } from "@/components/new-situation-form";
import { requireSession } from "@/server/auth/request";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function NewSituationPage() {
  const session = await requireSession("/situations/new");
  return (
    <AppShell
      active="situations"
      csrfToken={session.csrfToken}
      user={{
        displayName: session.user.displayName,
        isAdmin: session.roles.has("ADMIN"),
      }}
    >
      <main className="focusedPage">
        <Link className="backLink" href="/">
          ← All situations
        </Link>
        <header className="focusedIntro">
          <p className="eyebrow">New situation</p>
          <h1>Begin with the real moment.</h1>
          <p>
            Studio will create a validated guidance template and check it out to
            you immediately.
          </p>
        </header>
        <NewSituationForm csrfToken={session.csrfToken} />
      </main>
    </AppShell>
  );
}
