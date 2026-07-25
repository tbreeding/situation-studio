import { createDatabaseClient } from "@situation-studio/db";
import { runOneReview, type ReviewProviderConfiguration } from "./review";
import { reviewWorkerIdleStatus } from "./status";

const databaseUrl = process.env.STUDIO_REVIEW_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "STUDIO_REVIEW_DATABASE_URL is required for the review worker.",
  );

function configuration(): ReviewProviderConfiguration {
  if (process.env.REVIEW_PROVIDER_MODE === "deterministic")
    return { mode: "deterministic" };
  const release = process.env.SITUATION_STUDIO_RELEASE;
  const codexModel = process.env.CODEX_REVIEW_MODEL;
  const claudeModel = process.env.CLAUDE_REVIEW_MODEL;
  if (!release || !codexModel || !claudeModel)
    throw new Error(
      "Subscription CLI review requires the release and both pinned models.",
    );
  return {
    mode: "subscription-cli",
    codex: {
      binary: process.env.CODEX_BIN ?? "codex",
      model: codexModel,
      wrapper: `${release}/ops/run-codex-review.sh`,
    },
    claude: {
      binary: process.env.CLAUDE_BIN ?? "claude",
      model: claudeModel,
    },
  };
}

const database = createDatabaseClient(databaseUrl, 4);
const providerConfiguration = configuration();
let stopping = false;
let latestFinishedReview: {
  state: string;
  failureCode: string | null;
  finishedAt: Date | null;
} | null = null;

function workerStatus() {
  return reviewWorkerIdleStatus(latestFinishedReview);
}

async function heartbeat(status: string) {
  await database.processHeartbeat.upsert({
    where: { id: "review-worker" },
    create: {
      id: "review-worker",
      status,
      details: {
        providerMode: providerConfiguration.mode,
        providerPreference:
          providerConfiguration.mode === "subscription-cli"
            ? ["codex", "claude"]
            : ["deterministic"],
        models:
          providerConfiguration.mode === "subscription-cli"
            ? {
                codex: providerConfiguration.codex.model,
                claude: providerConfiguration.claude.model,
              }
            : { deterministic: "deterministic-provider-v1" },
      },
      lastSeenAt: new Date(),
    },
    update: {
      status,
      details: {
        providerMode: providerConfiguration.mode,
        providerPreference:
          providerConfiguration.mode === "subscription-cli"
            ? ["codex", "claude"]
            : ["deterministic"],
        models:
          providerConfiguration.mode === "subscription-cli"
            ? {
                codex: providerConfiguration.codex.model,
                claude: providerConfiguration.claude.model,
              }
            : { deterministic: "deterministic-provider-v1" },
      },
      lastSeenAt: new Date(),
    },
  });
}

process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

async function refreshWorkerStatus() {
  const latestReview = await database.reviewJob.findFirst({
    where: { finishedAt: { not: null } },
    orderBy: { finishedAt: "desc" },
    select: { state: true, failureCode: true, finishedAt: true },
  });
  latestFinishedReview = latestReview;
}

await refreshWorkerStatus();
const heartbeatMonitor = setInterval(() => {
  void heartbeat(workerStatus()).catch(() => undefined);
}, 15_000);
heartbeatMonitor.unref();

try {
  while (!stopping) {
    await heartbeat(workerStatus());
    const worked = await runOneReview(database, providerConfiguration);
    if (worked) {
      await refreshWorkerStatus();
      await heartbeat(workerStatus());
    } else {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      });
    }
  }
} finally {
  clearInterval(heartbeatMonitor);
  await heartbeat("STOPPING").catch(() => undefined);
  await database.$disconnect();
}
