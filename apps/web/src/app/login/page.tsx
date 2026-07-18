import { cookies } from "next/headers";
import { LOGIN_CSRF_COOKIE } from "@/server/auth/sessions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    expired?: string;
    activated?: string;
  }>;
}) {
  const params = await searchParams;
  const csrf = (await cookies()).get(LOGIN_CSRF_COOKIE)?.value ?? "";
  return (
    <main className="loginShell" id="main-content">
      <section className="loginStory">
        <div className="wordmark">
          <span className="mark">S</span> Situation Studio
        </div>
        <div>
          <p className="eyebrow">Private beta · two gates</p>
          <h1>Make the rule teach the same thing everywhere.</h1>
          <p>
            Create, challenge, rehearse, and publish leadership guidance as one
            coherent learning bundle—with human judgment at the center.
          </p>
        </div>
        <p>
          Do not enter personal data, credentials, health information, customer
          secrets, or identifiable employee details.
        </p>
      </section>
      <section className="loginPanel" aria-labelledby="login-title">
        <div className="loginCard">
          <p className="eyebrow">Studio authentication</p>
          <h2 id="login-title">Sign in</h2>
          <p className="muted">
            The TimsPrototypes access gate is separate from this Studio account.
          </p>
          {params.error && (
            <p className="alert" role="alert">
              The username or password was not accepted. Try again later if
              attempts are limited.
            </p>
          )}
          {params.expired && (
            <p className="alert" role="alert">
              Your session ended. Sign in again.
            </p>
          )}
          {params.activated && (
            <p className="success" role="status">
              Account activated. Sign in with your new password.
            </p>
          )}
          <form className="stack" action="/auth/login" method="post">
            <input type="hidden" name="loginCsrf" value={csrf} />
            <label className="field">
              Username
              <input
                name="username"
                autoComplete="username"
                required
                maxLength={64}
              />
            </label>
            <label className="field">
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                minLength={12}
                maxLength={1024}
              />
            </label>
            <button className="button" type="submit">
              Enter Situation Studio
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
