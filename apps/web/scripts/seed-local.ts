import path from "node:path";
import { createDatabaseClient } from "@situation-studio/db";
import { hashPassword } from "../src/server/auth/password";
import { importLegacyBaseline } from "../src/server/setup/baseline";
import { seedAuthorization } from "../src/server/setup/authorization";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const studioRoot = path.resolve(import.meta.dirname, "../../..");
const leadershipRoot = path.resolve(
  process.env.LEADERSHIP_REPO_PATH ?? path.join(studioRoot, "../leadership"),
);
const database = createDatabaseClient(databaseUrl, 2);
try {
  await seedAuthorization(database);
  const user = await database.user.upsert({
    where: { username: "studio-admin" },
    create: {
      username: "studio-admin",
      displayName: "Studio Administrator",
      repositoryReviewerId: "studio-admin-reviewer",
      passwordHash: await hashPassword("Studio-Test-Only-Password-2026!"),
      state: "ACTIVE",
      identityType: "HUMAN",
    },
    update: {
      state: "ACTIVE",
      repositoryReviewerId: "studio-admin-reviewer",
    },
  });
  const role = await database.role.findUniqueOrThrow({
    where: { code: "ADMINISTRATOR" },
  });
  await database.userRoleAssignment.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    create: { userId: user.id, roleId: role.id, grantedById: user.id },
    update: {},
  });
  const editor = await database.user.upsert({
    where: { username: "studio-editor" },
    create: {
      username: "studio-editor",
      displayName: "Studio Editor",
      passwordHash: await hashPassword("Studio-Test-Only-Password-2026!"),
      state: "ACTIVE",
      identityType: "HUMAN",
    },
    update: { state: "ACTIVE" },
  });
  const editorRole = await database.role.findUniqueOrThrow({
    where: { code: "EDITOR" },
  });
  await database.userRoleAssignment.upsert({
    where: {
      userId_roleId: { userId: editor.id, roleId: editorRole.id },
    },
    create: {
      userId: editor.id,
      roleId: editorRole.id,
      grantedById: user.id,
    },
    update: {},
  });
  const imported = await importLegacyBaseline(
    database,
    studioRoot,
    leadershipRoot,
  );
  process.stdout.write(
    `Local fixture ready: ${imported.situations} situations.\n`,
  );
} finally {
  await database.$disconnect();
}
