import { cookies } from "next/headers";
import { database } from "@/server/database";
import { environment, isSecureOrigin } from "@/server/environment";
import { keyedHash, opaqueToken, sha256 } from "@/server/auth/crypto";
import { permissionsForUser } from "@/server/auth/rbac";

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
      csrfSecretHash: sha256(csrfToken),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now.getTime() + 12 * 60 * 60 * 1000),
      reauthenticatedAt: now,
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

export async function currentSession(now = new Date()) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const tokenHash = sha256(token);
  const session = await database().session.findUnique({
    where: { tokenHash },
    include: { user: true },
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
  const permissions = await permissionsForUser(session.userId);
  return {
    ...session,
    permissions,
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
