import { NextResponse, type NextRequest } from "next/server";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { equalText, sha256 } from "@/server/auth/crypto";
import { hashPassword } from "@/server/auth/password";
import { LOGIN_CSRF_COOKIE } from "@/server/auth/sessions";
import { audit } from "@/server/audit";

function destination(path: string) {
  return NextResponse.redirect(
    new URL(path, environment().SITUATION_STUDIO_ORIGIN),
    303,
  );
}

export async function POST(request: NextRequest) {
  const configured = environment();
  const origin = request.headers.get("origin");
  const localOpaqueOrigin =
    configured.SITUATION_STUDIO_ORIGIN.startsWith("http://") &&
    (origin === null || origin === "null");
  if (
    request.headers.get("host") !== configured.SITUATION_STUDIO_HOST ||
    (origin !== configured.SITUATION_STUDIO_ORIGIN && !localOpaqueOrigin)
  )
    return destination("/login?error=1");
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  const confirmation = String(form.get("confirmation") ?? "");
  const presentedCsrf = String(form.get("loginCsrf") ?? "");
  const cookieCsrf = request.cookies.get(LOGIN_CSRF_COOKIE)?.value ?? "";
  if (
    !presentedCsrf ||
    !equalText(presentedCsrf, cookieCsrf) ||
    password !== confirmation ||
    password.length < 12 ||
    password.length > 1024
  )
    return destination(`/activate/${encodeURIComponent(token)}?error=1`);
  const tokenHash = sha256(token);
  const row = await database().activationToken.findUnique({
    where: { tokenHash },
  });
  if (!row || row.consumedAt || row.expiresAt <= new Date())
    return destination("/login?error=1");
  const passwordHash = await hashPassword(password);
  const now = new Date();
  await database().$transaction(
    async (transaction) => {
      const consumed = await transaction.activationToken.updateMany({
        where: { id: row.id, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1)
        throw new Error("ACTIVATION_TOKEN_ALREADY_USED");
      await transaction.user.update({
        where: { id: row.userId },
        data: {
          passwordHash,
          state: "ACTIVE",
          passwordVersion: { increment: 1 },
        },
      });
      await transaction.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: "ACCOUNT_ACTIVATED" },
      });
    },
    { isolationLevel: "Serializable" },
  );
  await audit({
    actorId: row.userId,
    action: "user.activate",
    targetType: "user",
    targetId: row.userId,
    outcome: "SUCCEEDED",
  });
  return destination("/login?activated=1");
}
