import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { opaqueToken, sha256 } from "@/server/auth/crypto";
import { audit } from "@/server/audit";
import { environment } from "@/server/environment";

const schema = z.object({
  username: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/u),
  displayName: z.string().trim().min(2).max(120),
  roles: z
    .array(z.enum(["ADMINISTRATOR", "EDITOR", "REVIEWER", "PUBLISHER"]))
    .max(4),
});

export async function POST(request: NextRequest) {
  const auth = await authenticateMutation(request, "user.manage");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  if (
    !auth.session.reauthenticatedAt ||
    auth.session.reauthenticatedAt.getTime() < Date.now() - 15 * 60 * 1000
  )
    return NextResponse.json(
      { error: "recent reauthentication required" },
      { status: 403 },
    );
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: "invalid account request" },
      { status: 400 },
    );
  const token = opaqueToken();
  const result = await database().$transaction(
    async (transaction) => {
      const user = await transaction.user.create({
        data: {
          username: parsed.data.username,
          displayName: parsed.data.displayName,
          state: "PENDING_ACTIVATION",
          identityType: "HUMAN",
        },
      });
      for (const code of parsed.data.roles) {
        const role = await transaction.role.findUniqueOrThrow({
          where: { code },
        });
        await transaction.userRoleAssignment.create({
          data: {
            userId: user.id,
            roleId: role.id,
            grantedById: auth.session.userId,
          },
        });
      }
      await transaction.activationToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(token),
          kind: "ACTIVATION",
          createdById: auth.session.userId,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
      return user;
    },
    { isolationLevel: "Serializable" },
  );
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "user.invite",
    targetType: "user",
    targetId: result.id,
    outcome: "SUCCEEDED",
    after: { username: result.username, roles: parsed.data.roles },
  });
  return NextResponse.json(
    {
      userId: result.id,
      activationUrl: new URL(
        `/activate/${token}`,
        environment().SITUATION_STUDIO_ORIGIN,
      ).toString(),
    },
    { status: 201 },
  );
}
