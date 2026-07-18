import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "@situation-studio/db";
import { hashPassword } from "../src/server/auth/password";
import { parseNamedArguments, readConfirmedPassword } from "./cli-password";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const input = parseNamedArguments(process.argv.slice(2));
const password = await readConfirmedPassword();
const passwordHash = await hashPassword(password);
const database = createDatabaseClient(databaseUrl, 2);
try {
  const user = await database.user.findUniqueOrThrow({
    where: { username: input.username },
    include: { roleAssignments: { include: { role: true } } },
  });
  if (user.state !== "ACTIVE")
    throw new Error(
      "A deactivated administrator must be reactivated separately.",
    );
  if (
    !user.roleAssignments.some(
      (assignment) => assignment.role.code === "ADMINISTRATOR",
    )
  )
    throw new Error("The target is not an administrator.");
  await database.$transaction(
    async (transaction) => {
      await transaction.user.update({
        where: { id: user.id },
        data: { passwordHash, passwordVersion: { increment: 1 } },
      });
      await transaction.session.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "BREAK_GLASS_RESET" },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "HUMAN",
          actorId: user.id,
          action: "admin.reset",
          targetType: "user",
          targetId: user.id,
          correlationId: randomUUID(),
          outcome: "SUCCEEDED",
          afterMetadata: { sessionsRevoked: true },
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
  process.stdout.write("Administrator access reset; all sessions revoked.\n");
} finally {
  await database.$disconnect();
}
