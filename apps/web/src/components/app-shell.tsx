import Link from "next/link";

export function AppShell({
  user,
  csrfToken,
  children,
}: {
  user: { displayName: string };
  csrfToken: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="appHeader">
        <Link className="wordmark" href="/">
          <span className="mark">S</span> Situation Studio
        </Link>
        <nav aria-label="Primary">
          <Link href="/">Situations</Link>
          <Link href="/jobs">Jobs</Link>
          <Link href="/capacity">Capacity</Link>
          <Link href="/administration">Administration</Link>
        </nav>
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
