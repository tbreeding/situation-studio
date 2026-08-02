import { readFileSync } from "node:fs";
import path from "node:path";
import { createDatabaseClient } from "@situation-studio/db";
import { runtimeCapabilitiesFromHealth } from "@situation-studio/leadership-bridge";
import {
  claimPublicationJob,
  processPublicationJob,
  reconcilePublicationRecovery,
  runtimeIdentityFromHealth,
  runtimeRouteProofFromVerificationEndpoint,
  type RuntimeRouteExpectation,
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
const leadershipCapabilitiesUrl = requiredEnvironment(
  "LEADERSHIP_RUNTIME_CAPABILITIES_URL",
);
const studioRelease = requiredEnvironment("SITUATION_STUDIO_RELEASE");
const producerCommit = readFileSync(
  path.join(studioRelease, ".release-commit"),
  "utf8",
).trim();

const studio = createDatabaseClient(studioDatabaseUrl, 4);
let publisherStatus = "STARTING";
const dependencies = {
  studio,
  leadershipPublisherUrl,
  runtimeIdentity: (options?: { signal?: AbortSignal }) =>
    runtimeIdentityFromHealth(leadershipHealthUrl, options),
  runtimeCapabilities: () =>
    runtimeCapabilitiesFromHealth(leadershipCapabilitiesUrl),
  runtimeRouteProof: (expected: RuntimeRouteExpectation) =>
    runtimeRouteProofFromVerificationEndpoint(leadershipHealthUrl, expected),
  producerCommit,
  onRuntimeIdentityProbe: () =>
    heartbeat(publisherStatus).catch(() => undefined),
  onFailure: (error: unknown) => {
    console.error("Publication attempt failed.", error);
  },
};

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

async function setPublisherStatus(status: string) {
  publisherStatus = status;
  await heartbeat(status);
}

const heartbeatMonitor = setInterval(() => {
  void heartbeat(publisherStatus).catch(() => undefined);
}, 15_000);
heartbeatMonitor.unref();

async function run() {
  for (;;) {
    try {
      await setPublisherStatus("CHECKING_RECOVERY");
      await reconcilePublicationRecovery(dependencies);
      await setPublisherStatus("CHECKING_QUEUE");
      const claim = await claimPublicationJob(studio);
      if (claim) {
        await setPublisherStatus("WORKING");
        await processPublicationJob(dependencies, claim.id, claim.claimToken);
        await setPublisherStatus("IDLE");
      } else {
        await setPublisherStatus("IDLE");
      }
    } catch (error) {
      dependencies.onFailure(error);
      await setPublisherStatus("DEGRADED").catch(() => undefined);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

void run().finally(async () => {
  clearInterval(heartbeatMonitor);
  publisherStatus = "STOPPING";
  await heartbeat("STOPPING").catch(() => undefined);
  await studio.$disconnect();
});
