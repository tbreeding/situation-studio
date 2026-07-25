import Image from "next/image";
import Link from "next/link";

export function AppShell({
  user,
  csrfToken,
  active,
  children,
}: {
  user: { displayName: string; isAdmin: boolean };
  csrfToken: string;
  active: "situations" | "operations";
  children: React.ReactNode;
}) {
  return (
    <div className="appFrame">
      <header className="topBar">
        <Link className="brand" href="/">
          <span className="brandMark" aria-hidden="true">
            <Image
              src="/icon.svg"
              alt=""
              width={35}
              height={35}
              priority
              unoptimized
            />
          </span>
          <span>
            <strong>Situation Studio</strong>
            <small>Leadership editorial workbench</small>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          <Link
            href="/"
            className={active === "situations" ? "active" : undefined}
            aria-current={active === "situations" ? "page" : undefined}
          >
            Situations
          </Link>
          {user.isAdmin ? (
            <Link
              href="/operations"
              className={active === "operations" ? "active" : undefined}
              aria-current={active === "operations" ? "page" : undefined}
            >
              Operations
            </Link>
          ) : null}
        </nav>
        <div className="accountMenu">
          <span className="avatar" aria-hidden="true">
            {user.displayName
              .split(/\s+/u)
              .map((word) => word[0])
              .join("")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <span className="accountName">{user.displayName}</span>
          <form action="/auth/logout" method="post">
            <input type="hidden" name="csrf" value={csrfToken} />
            <button className="textButton" type="submit">
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
