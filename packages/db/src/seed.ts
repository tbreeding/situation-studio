import argon2 from "argon2";
import { createDatabaseClient } from "./client";

const databaseUrl = process.env.STUDIO_DATABASE_URL;
const password = process.env.STUDIO_BOOTSTRAP_ADMIN_PASSWORD;

if (!databaseUrl)
  throw new Error("STUDIO_DATABASE_URL is required to seed the database.");
if (!password || [...password].length < 12)
  throw new Error(
    "STUDIO_BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 characters.",
  );

const database = createDatabaseClient(databaseUrl, 2);

try {
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
    hashLength: 32,
  });
  const user = await database.user.upsert({
    where: { username: "admin" },
    create: {
      username: "admin",
      displayName: "Studio administrator",
      passwordHash,
    },
    update: {
      state: "ACTIVE",
      passwordHash,
      passwordVersion: { increment: 1 },
    },
  });
  for (const role of ["ADMIN", "EDITOR"] as const)
    await database.userRoleAssignment.upsert({
      where: { userId_role: { userId: user.id, role } },
      create: { userId: user.id, role },
      update: {},
    });
  process.stdout.write("Bootstrap administrator is ready.\n");
} finally {
  await database.$disconnect();
}
