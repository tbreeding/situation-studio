import { NextResponse } from "next/server";
import { z } from "zod";
import { database } from "@/server/database";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import { canonicalUsername } from "@/server/auth/throttle";
import { hashPassword } from "@/server/auth/password";

const createSchema = z.object({
  username: z.string().min(2).max(64),
  displayName: z.string().min(2).max(120),
  password: z.string().min(12).max(1024),
  admin: z.boolean(),
});

export async function POST(request: Request) {
  const auth = await requireMutationSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!hasRole(auth.session, "ADMIN"))
    return NextResponse.json(
      { error: "Administrator access required." },
      { status: 403 },
    );
  try {
    const input = createSchema.parse(await request.json());
    const passwordHash = await hashPassword(input.password);
    const user = await database().$transaction(async (transaction) => {
      const created = await transaction.user.create({
        data: {
          username: canonicalUsername(input.username),
          displayName: input.displayName.trim(),
          passwordHash,
          roles: {
            create: [
              { role: "EDITOR" },
              ...(input.admin ? [{ role: "ADMIN" as const }] : []),
            ],
          },
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: auth.session.userId,
          action: "USER_CREATED",
          subjectType: "USER",
          subjectId: created.id,
          payload: { username: created.username, admin: input.admin },
        },
      });
      return created;
    });
    return NextResponse.json({ id: user.id }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError)
      return NextResponse.json(
        {
          error:
            "Enter a valid username, display name, and 12+ character password.",
        },
        { status: 422 },
      );
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "P2002"
    )
      return NextResponse.json(
        { error: "That username already exists." },
        { status: 409 },
      );
    throw error;
  }
}
