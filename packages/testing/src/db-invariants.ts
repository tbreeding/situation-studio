import { randomUUID } from "node:crypto";
import { createDatabaseClient } from "@situation-studio/db";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || !/situation_studio_migration_test_/u.test(databaseUrl))
  throw new Error(
    "Refusing DB invariant test outside a dedicated situation_studio_migration_test_* database.",
  );

const left = createDatabaseClient(databaseUrl, 2);
const right = createDatabaseClient(databaseUrl, 2);
const suffix = randomUUID().slice(0, 8);
try {
  const snapshot = await left.repositorySnapshot.create({
    data: {
      commitSha: randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40),
      manifest: {},
      manifestHash: "a".repeat(64),
      parserVersion: "db-test-v1",
      importKind: "LEGACY_IMPORT",
      validationState: "PASSED",
    },
  });
  const situation = await left.situation.create({
    data: { slug: `db-race-${suffix}`, title: "Synthetic checkout race" },
  });
  const users = await Promise.all(
    ["left", "right"].map((name) =>
      left.user.create({
        data: {
          username: `${name}-${suffix}`,
          displayName: `${name} fixture`,
          passwordHash: "$argon2id$fixture",
          state: "ACTIVE",
        },
      }),
    ),
  );
  const acquire = (database: typeof left, holderUserId: string) =>
    database.$transaction(
      async (transaction) => {
        const fenced = await transaction.situation.update({
          where: { id: situation.id },
          data: { fence: { increment: 1 } },
        });
        return transaction.situationCheckout.create({
          data: {
            situationId: situation.id,
            holderUserId,
            mode: "EDITING",
            custody: "USER",
            fencingToken: fenced.fence,
            expiresAt: new Date(Date.now() + 60_000),
          },
        });
      },
      { isolationLevel: "Serializable" },
    );
  const race = await Promise.allSettled([
    acquire(left, users[0]!.id),
    acquire(right, users[1]!.id),
  ]);
  if (race.filter((result) => result.status === "fulfilled").length !== 1)
    throw new Error("Checkout race did not produce exactly one winner.");
  if (
    (await left.situationCheckout.count({
      where: { situationId: situation.id, releasedAt: null },
    })) !== 1
  )
    throw new Error("Active checkout uniqueness was violated.");

  const audit = await left.auditEvent.create({
    data: {
      actorType: "SERVICE",
      action: "db.invariant",
      targetType: "snapshot",
      targetId: snapshot.id,
      correlationId: randomUUID(),
      outcome: "SUCCEEDED",
    },
  });
  const appendOnly = await left.auditEvent
    .update({ where: { id: audit.id }, data: { outcome: "FAILED" } })
    .then(
      () => false,
      () => true,
    );
  if (!appendOnly)
    throw new Error("Audit append-only trigger allowed an update.");

  process.stdout.write(
    JSON.stringify({
      checkoutRace: "one-winner",
      activeCheckoutCount: 1,
      auditAppendOnly: true,
      database: new URL(databaseUrl).pathname.slice(1),
    }) + "\n",
  );
} finally {
  await Promise.all([left.$disconnect(), right.$disconnect()]);
}
