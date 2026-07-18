import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { database } from "@/server/database";
import { sha256 } from "@/server/auth/crypto";
import { LOGIN_CSRF_COOKIE } from "@/server/auth/sessions";

export default async function ActivatePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; complete?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const row = await database().activationToken.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!row || row.consumedAt || row.expiresAt <= new Date()) notFound();
  const csrf = (await cookies()).get(LOGIN_CSRF_COOKIE)?.value ?? "";
  return (
    <main className="loginShell" id="main-content">
      <section className="loginStory">
        <div className="wordmark">
          <span className="mark">S</span> Situation Studio
        </div>
        <div>
          <p className="eyebrow">Private invitation</p>
          <h1>Choose your own Studio password.</h1>
          <p>
            The administrator who invited you cannot see it. This link works
            once and expires after 24 hours.
          </p>
        </div>
        <p>Use a unique passphrase of at least 12 characters.</p>
      </section>
      <section className="loginPanel" aria-labelledby="activation-title">
        <div className="loginCard">
          <p className="eyebrow">Activate {row.user.displayName}</p>
          <h2 id="activation-title">Set password</h2>
          {query.error && (
            <p className="alert" role="alert">
              The passwords did not match or did not meet the password policy.
            </p>
          )}
          <form className="stack" action="/auth/activate" method="post">
            <input type="hidden" name="loginCsrf" value={csrf} />
            <input type="hidden" name="token" value={token} />
            <label className="field">
              Password
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={1024}
                required
              />
            </label>
            <label className="field">
              Confirm password
              <input
                name="confirmation"
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={1024}
                required
              />
            </label>
            <button className="button" type="submit">
              Activate account
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
