import { NextResponse } from "next/server";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { keyedHash } from "@/server/auth/crypto";
import { publicUrl } from "@/server/auth/public-url";
import { safeReturnTo } from "@/server/auth/return-to";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/server/auth/password";
import {
  evaluateLoginAttempt,
  throttleKeys,
  canonicalUsername,
} from "@/server/auth/throttle";
import {
  createSession,
  setSessionCookie,
  verifyLoginCsrf,
} from "@/server/auth/sessions";

function errorRedirect(code: string, returnTo: string) {
  const destination = publicUrl("/login");
  destination.searchParams.set("error", code);
  const safeDestination = safeReturnTo(returnTo);
  if (safeDestination !== "/")
    destination.searchParams.set("returnTo", safeDestination);
  return NextResponse.redirect(destination, 303);
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(environment().SITUATION_STUDIO_ORIGIN);
  const opaqueSameOrigin =
    origin === "null" &&
    request.headers.get("sec-fetch-site") === "same-origin" &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("host") === expected.host;
  if (origin !== expected.origin && !opaqueSameOrigin)
    return errorRedirect("verification", "/");
  const form = await request.formData();
  const username = canonicalUsername(String(form.get("username") ?? ""));
  const password = String(form.get("password") ?? "");
  const csrf = String(form.get("csrf") ?? "");
  const returnTo = safeReturnTo(String(form.get("returnTo") ?? "/"));
  if (!(await verifyLoginCsrf(csrf)))
    return errorRedirect("verification", returnTo);
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  const ip = forwarded || "unknown";
  const keys = throttleKeys(username, ip);
  const attempt = await evaluateLoginAttempt(keys, async (transaction) => {
    const user = await transaction.user.findUnique({
      where: { username },
      include: { roles: true },
    });
    const valid = await verifyPassword(
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      password,
    );
    return valid && user?.state === "ACTIVE" ? user : null;
  });
  if (attempt.blocked) return errorRedirect("blocked", returnTo);
  const user = attempt.value;
  if (!user) return errorRedirect("invalid", returnTo);
  const ipHash = keyedHash(environment().SESSION_SECRET, "session-ip", ip);
  const session = await createSession(user, ipHash);
  await setSessionCookie(session.token);
  await database().user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
  await database().auditEvent.create({
    data: {
      actorId: user.id,
      action: "USER_LOGGED_IN",
      subjectType: "SESSION",
      subjectId: session.row.id,
      payload: {},
    },
  });
  return NextResponse.redirect(publicUrl(returnTo), 303);
}
