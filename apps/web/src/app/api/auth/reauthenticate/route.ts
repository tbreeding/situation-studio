import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "@/server/auth/password";
import { authenticateMutation } from "@/server/auth/request";
import {
  clearUsernameFailure,
  isBlocked,
  recordFailure,
  throttleKeys,
} from "@/server/auth/throttle";
import { database } from "@/server/database";

const schema = z.object({
  password: z.string().min(1).max(1024),
});

export async function POST(request: NextRequest) {
  const auth = await authenticateMutation(request);
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  const forwarded =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const keys = throttleKeys(auth.session.user.username, forwarded);
  const blocked = await isBlocked(keys);
  const passwordOkay = await verifyPassword(
    auth.session.user.passwordHash ?? DUMMY_PASSWORD_HASH,
    parsed.data.password,
  );
  if (blocked || !auth.session.user.passwordHash || !passwordOkay) {
    await recordFailure(keys);
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "auth.reauthenticate",
      targetType: "session",
      targetId: auth.session.id,
      outcome: "DENIED",
      reason: blocked ? "THROTTLED" : "GENERIC_FAILURE",
    });
    return NextResponse.json(
      { error: "identity confirmation failed" },
      { status: blocked ? 429 : 401 },
    );
  }
  const now = new Date();
  const updated = await database().session.updateMany({
    where: {
      id: auth.session.id,
      userId: auth.session.userId,
      revokedAt: null,
    },
    data: { reauthenticatedAt: now },
  });
  if (updated.count !== 1)
    return NextResponse.json({ error: "session changed" }, { status: 409 });
  await clearUsernameFailure(keys.username);
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "auth.reauthenticate",
    targetType: "session",
    targetId: auth.session.id,
    outcome: "SUCCEEDED",
    after: { reauthenticatedAt: now.toISOString() },
  });
  return NextResponse.json({ reauthenticatedAt: now.toISOString() });
}
