import { createDatabaseClient } from "@situation-studio/db";
import { runOneReview, type ReviewProviderConfiguration } from "./review";

const databaseUrl = process.env.STUDIO_REVIEW_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "STUDIO_REVIEW_DATABASE_URL is required for the review worker.",
  );

function configuration(): ReviewProviderConfiguration {
  if (process.env.REVIEW_PROVIDER_MODE === "deterministic")
    return { mode: "deterministic" };
  const openai =
    process.env.OPENAI_API_KEY && process.env.OPENAI_REVIEW_MODEL
      ? {
          apiKey: process.env.OPENAI_API_KEY,
          model: process.env.OPENAI_REVIEW_MODEL,
        }
      : undefined;
  const anthropic =
    process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_REVIEW_MODEL
      ? {
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.ANTHROPIC_REVIEW_MODEL,
        }
      : undefined;
  if (!openai && !anthropic)
    throw new Error("At least one service provider route must be configured.");
  return {
    mode: "service",
    ...(openai ? { openai } : {}),
    ...(anthropic ? { anthropic } : {}),
  };
}

const database = createDatabaseClient(databaseUrl, 4);
const providerConfiguration = configuration();
let stopping = false;

async function heartbeat(status: string) {
  await database.processHeartbeat.upsert({
    where: { id: "review-worker" },
    create: {
      id: "review-worker",
      status,
      details: {
        providerMode: providerConfiguration.mode,
        openaiConfigured: Boolean(providerConfiguration.openai),
        anthropicConfigured: Boolean(providerConfiguration.anthropic),
      },
      lastSeenAt: new Date(),
    },
    update: {
      status,
      details: {
        providerMode: providerConfiguration.mode,
        openaiConfigured: Boolean(providerConfiguration.openai),
        anthropicConfigured: Boolean(providerConfiguration.anthropic),
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

try {
  while (!stopping) {
    await heartbeat("CHECKING_QUEUE");
    const worked = await runOneReview(database, providerConfiguration);
    if (!worked) {
      await heartbeat("IDLE");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref();
      });
    } else await heartbeat("IDLE");
  }
} finally {
  await heartbeat("STOPPING").catch(() => undefined);
  await database.$disconnect();
}
