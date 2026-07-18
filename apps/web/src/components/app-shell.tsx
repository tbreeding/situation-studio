import Link from "next/link";
import { PrimaryNavigation } from "@/components/primary-navigation";

export function AppShell({
  user,
  csrfToken,
  canAccessAdministration,
  children,
}: {
  user: { displayName: string };
  csrfToken: string;
  canAccessAdministration?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="appHeader">
        <Link className="wordmark" href="/">
          <span className="mark">S</span> Situation Studio
        </Link>
        <PrimaryNavigation
          canAccessAdministration={canAccessAdministration ?? false}
        />
        <div className="account">
          <span>{user.displayName}</span>
          <form action="/auth/logout" method="post">
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <button className="textButton" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="appMain" id="main-content">
        {children}
      </main>
    </>
  );
}
