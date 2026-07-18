import { NextResponse, type NextRequest } from "next/server";
import { database } from "@/server/database";
import { environment, isSecureOrigin } from "@/server/environment";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/server/auth/password";
import {
  canonicalUsername,
  clearUsernameFailure,
  isBlocked,
  recordFailure,
  throttleKeys,
} from "@/server/auth/throttle";
import {
  createSession,
  LOGIN_CSRF_COOKIE,
  SESSION_COOKIE,
} from "@/server/auth/sessions";
import { equalText } from "@/server/auth/crypto";
import { audit } from "@/server/audit";

function redirect(error = false) {
  return NextResponse.redirect(
    new URL(
      error ? "/login?error=1" : "/",
      environment().SITUATION_STUDIO_ORIGIN,
    ),
    303,
  );
}

export async function POST(request: NextRequest) {
  const configured = environment();
  if (request.headers.get("host") !== configured.SITUATION_STUDIO_HOST)
    return redirect(true);
  const requestOrigin = request.headers.get("origin");
  const localNavigationWithoutOrigin =
    configured.SITUATION_STUDIO_ORIGIN.startsWith("http://") &&
    (requestOrigin === null || requestOrigin === "null");
  if (
    requestOrigin !== configured.SITUATION_STUDIO_ORIGIN &&
    !localNavigationWithoutOrigin
  )
    return redirect(true);
  const form = await request.formData();
  const username = canonicalUsername(String(form.get("username") ?? ""));
  const password = String(form.get("password") ?? "");
  const presentedCsrf = String(form.get("loginCsrf") ?? "");
  const cookieCsrf = request.cookies.get(LOGIN_CSRF_COOKIE)?.value ?? "";
  if (!presentedCsrf || !equalText(presentedCsrf, cookieCsrf))
    return redirect(true);
  const forwarded =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const keys = throttleKeys(username, forwarded);
  const blocked = await isBlocked(keys);
  const user = await database().user.findUnique({ where: { username } });
  const passwordOkay = await verifyPassword(
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    password,
  );
  if (blocked || !user || user.state !== "ACTIVE" || !passwordOkay) {
    await recordFailure(keys);
    await audit({
      actorId: user?.id ?? null,
      action: "auth.login",
      targetType: "user",
      targetId: user?.id ?? null,
      outcome: "DENIED",
      reason: blocked ? "THROTTLED" : "GENERIC_FAILURE",
    });
    return redirect(true);
  }
  const session = await createSession(user);
  await database().user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  await clearUsernameFailure(keys.username);
  await audit({
    actorId: user.id,
    action: "auth.login",
    targetType: "session",
    targetId: session.row.id,
    outcome: "SUCCEEDED",
  });
  const response = redirect(false);
  response.cookies.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
  response.cookies.set(LOGIN_CSRF_COOKIE, "", {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
