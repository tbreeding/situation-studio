import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { safeReturnTo } from "@/server/auth/return-to";
import { LOGIN_CSRF_COOKIE, currentSession } from "@/server/auth/sessions";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; returnTo?: string }>;
}) {
  const existing = await currentSession();
  const query = await searchParams;
  const returnTo = safeReturnTo(query.returnTo);
  if (existing) redirect(returnTo);
  const csrfToken = (await cookies()).get(LOGIN_CSRF_COOKIE)?.value;
  if (!csrfToken) {
    const suffix =
      returnTo !== "/" ? `?returnTo=${encodeURIComponent(returnTo)}` : "";
    redirect(`/auth/login/begin${suffix}`);
  }
  const message =
    query.error === "invalid"
      ? "That username and password did not match."
      : query.error === "blocked"
        ? "Sign-in is temporarily paused. Try again in 15 minutes."
        : query.error === "verification"
          ? "The sign-in page expired. Please try again."
          : null;
  return (
    <main className="loginPage">
      <section className="loginPanel" aria-labelledby="login-title">
        <div className="brandMark" aria-hidden="true">
          SS
        </div>
        <p className="eyebrow">Situation Studio</p>
        <h1 id="login-title">Sign in to edit with care.</h1>
        <p className="loginIntro">
          Check out one situation, shape the guidance, and make a deliberate
          production change.
        </p>
        {message ? (
          <p className="formError" role="alert">
            {message}
          </p>
        ) : null}
        <form className="loginForm" action="/auth/login" method="post">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <label>
            <span>Username</span>
            <input
              name="username"
              type="text"
              autoComplete="username"
              required
              maxLength={64}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={1024}
            />
          </label>
          <button className="primaryButton" type="submit">
            Sign in
          </button>
        </form>
        <p className="quietNote">
          Accounts are created by an administrator.{" "}
          <Link href="/health/live">System status</Link>
        </p>
      </section>
      <aside className="loginAside" aria-label="Studio principles">
        <p>Fast enough for real editorial work.</p>
        <ul>
          <li>One editor per situation</li>
          <li>Every production version retained</li>
          <li>Agent review stays optional</li>
        </ul>
      </aside>
    </main>
  );
}
