import { createDatabaseClient } from "@situation-studio/db";
import {
  claimPublicationJob,
  processPublicationJob,
  runtimeIdentityFromHealth,
} from "./index.js";

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const studioDatabaseUrl = requiredEnvironment("STUDIO_PUBLISHER_DATABASE_URL");
const leadershipPublisherUrl = requiredEnvironment(
  "LEADERSHIP_STUDIO_PUBLISHER_DATABASE_URL",
);
const leadershipHealthUrl = requiredEnvironment(
  "LEADERSHIP_CONTENT_HEALTH_URL",
);

const studio = createDatabaseClient(studioDatabaseUrl, 4);

async function heartbeat(status: string) {
  const recoveryRequired = await studio.publicationJob.count({
    where: { state: "RECOVERY_REQUIRED" },
  });
  await studio.processHeartbeat.upsert({
    where: { id: "publisher" },
    create: {
      id: "publisher",
      status,
      details: { recoveryRequired, runtimeHealthConfigured: true },
      lastSeenAt: new Date(),
    },
    update: {
      status,
      details: { recoveryRequired, runtimeHealthConfigured: true },
      lastSeenAt: new Date(),
    },
  });
}

async function run() {
  for (;;) {
    await heartbeat("CHECKING_QUEUE");
    const claim = await claimPublicationJob(studio);
    if (!claim) {
      await heartbeat("IDLE");
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    await heartbeat("WORKING");
    await processPublicationJob(
      {
        studio,
        leadershipPublisherUrl,
        runtimeIdentity: () => runtimeIdentityFromHealth(leadershipHealthUrl),
      },
      claim.id,
      claim.claimToken,
    );
    await heartbeat("IDLE");
  }
}

void run().finally(async () => {
  await heartbeat("STOPPING").catch(() => undefined);
  await studio.$disconnect();
});
