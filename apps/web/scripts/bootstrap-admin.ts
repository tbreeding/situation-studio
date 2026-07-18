import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "@situation-studio/db";
import { hashPassword } from "../src/server/auth/password";
import { seedAuthorization } from "../src/server/setup/authorization";
import { parseNamedArguments, readConfirmedPassword } from "./cli-password";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const input = parseNamedArguments(process.argv.slice(2));
const password = await readConfirmedPassword();
const passwordHash = await hashPassword(password);
const database = createDatabaseClient(databaseUrl, 2);

try {
  await seedAuthorization(database);
  const existing = await database.userRoleAssignment.findFirst({
    where: { role: { code: "ADMINISTRATOR" }, user: { state: "ACTIVE" } },
  });
  if (existing)
    throw new Error(
      "Administrator bootstrap refused: an active administrator already exists.",
    );
  const administrator = await database.$transaction(
    async (transaction) => {
      const user = await transaction.user.create({
        data: {
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          identityType: "HUMAN",
          state: "ACTIVE",
        },
      });
      const role = await transaction.role.findUniqueOrThrow({
        where: { code: "ADMINISTRATOR" },
      });
      await transaction.userRoleAssignment.create({
        data: { userId: user.id, roleId: role.id, grantedById: user.id },
      });
      await transaction.auditEvent.create({
        data: {
          actorType: "HUMAN",
          actorId: user.id,
          action: "admin.bootstrap",
          targetType: "user",
          targetId: user.id,
          correlationId: randomUUID(),
          outcome: "SUCCEEDED",
          afterMetadata: { username: user.username, role: "ADMINISTRATOR" },
        },
      });
      return user;
    },
    { isolationLevel: "Serializable" },
  );
  process.stdout.write(
    `Administrator created for ${administrator.username}.\n`,
  );
} finally {
  await database.$disconnect();
}
