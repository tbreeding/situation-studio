import { cookies } from "next/headers";
import { database } from "@/server/database";
import { environment, isSecureOrigin } from "@/server/environment";
import {
  keyedHash,
  opaqueToken,
  safeEqual,
  sha256,
} from "@/server/auth/crypto";

const secureCookieNames =
  process.env.SITUATION_STUDIO_ORIGIN?.startsWith("https://") ?? false;
export const SESSION_COOKIE = secureCookieNames
  ? "__Host-situation_studio"
  : "situation_studio_dev";
export const LOGIN_CSRF_COOKIE = secureCookieNames
  ? "__Host-situation_studio_login_csrf"
  : "situation_studio_login_csrf_dev";

export async function createSession(
  user: { id: string; passwordVersion: number },
  ipHash: string | null,
  now = new Date(),
) {
  const token = opaqueToken();
  const tokenHash = sha256(token);
  const csrfToken = keyedHash(
    environment().CSRF_SECRET,
    "session-csrf",
    `${user.id}:${tokenHash}`,
  );
  const row = await database().session.create({
    data: {
      tokenHash,
      userId: user.id,
      passwordVersion: user.passwordVersion,
      csrfHash: sha256(csrfToken),
      ipHash,
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
    },
  });
  return { row, token, csrfToken };
}

export async function setSessionCookie(token: string) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: 12 * 60 * 60,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function loginCsrfToken(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(LOGIN_CSRF_COOKIE)?.value;
  if (existing) return existing;
  const token = opaqueToken();
  jar.set(LOGIN_CSRF_COOKIE, token, {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "strict",
    path: "/",
    maxAge: 30 * 60,
  });
  return token;
}

export async function verifyLoginCsrf(value: string): Promise<boolean> {
  const expected = (await cookies()).get(LOGIN_CSRF_COOKIE)?.value;
  return Boolean(expected && safeEqual(expected, value));
}

export async function currentSession(now = new Date()) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = sha256(token);
  const session = await database().session.findUnique({
    where: { tokenHash },
    include: { user: { include: { roles: true } } },
  });
  if (
    !session ||
    session.revokedAt ||
    session.idleExpiresAt <= now ||
    session.absoluteExpiresAt <= now ||
    session.user.state !== "ACTIVE" ||
    session.passwordVersion !== session.user.passwordVersion
  ) {
    if (session && !session.revokedAt)
      await database().session.update({
        where: { id: session.id },
        data: { revokedAt: now, revokedReason: "EXPIRED_OR_INVALID" },
      });
    return null;
  }
  if (session.lastSeenAt.getTime() < now.getTime() - 60_000)
    await database().session.update({
      where: { id: session.id },
      data: {
        lastSeenAt: now,
        idleExpiresAt: new Date(
          Math.min(
            now.getTime() + 2 * 60 * 60 * 1000,
            session.absoluteExpiresAt.getTime(),
          ),
        ),
      },
    });
  const roles = new Set(
    session.user.roles.map((assignment) => assignment.role),
  );
  return {
    ...session,
    roles,
    csrfToken: keyedHash(
      environment().CSRF_SECRET,
      "session-csrf",
      `${session.userId}:${tokenHash}`,
    ),
  };
}

export async function revokeSession(sessionId: string, reason: string) {
  await database().session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}
