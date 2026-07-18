import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseClient } from "@situation-studio/db";
import { MODEL_POLICY } from "@situation-studio/domain";
import { z } from "zod";
import { claimNextJob, processReviewJob, type WorkerConfig } from "./review";

const configSchema = z
  .object({
    DATABASE_URL: z.string().startsWith("postgresql://"),
    STUDIO_RUNTIME_ENV: z
      .enum(["validation", "production"])
      .default("production"),
    PROVIDER_EXECUTION_MODE: z.enum(["disabled", "cli", "api"]),
    OPENAI_API_KEY: z.string().min(20).optional(),
    ANTHROPIC_API_KEY: z.string().min(20).optional(),
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(20).optional(),
    CODEX_BIN: z.string().min(1).optional(),
    CODEX_HOME: z.string().min(1).optional(),
    CLAUDE_BIN: z.string().min(1).optional(),
    WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2000),
    WORKER_RUN_ONCE: z.enum(["0", "1"]).default("0"),
  })
  .superRefine((value, context) => {
    if (
      value.PROVIDER_EXECUTION_MODE === "cli" &&
      value.STUDIO_RUNTIME_ENV !== "validation"
    )
      context.addIssue({
        code: "custom",
        path: ["PROVIDER_EXECUTION_MODE"],
        message: "CLI credentials are restricted to isolated validation.",
      });
    if (value.PROVIDER_EXECUTION_MODE === "api" && !value.OPENAI_API_KEY)
      context.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message: "The Codex-first production route requires OPENAI_API_KEY.",
      });
  });

const parsed = configSchema.parse(process.env);
if (parsed.PROVIDER_EXECUTION_MODE === "disabled") {
  process.stdout.write(
    JSON.stringify({
      service: "situation-studio-worker",
      state: "disabled",
      providerPriority: MODEL_POLICY.priority,
    }) + "\n",
  );
  process.exit(0);
}

const database = createDatabaseClient(parsed.DATABASE_URL, 4);
const workerConfig: WorkerConfig = {
  providerMode: parsed.PROVIDER_EXECUTION_MODE,
  ...(parsed.OPENAI_API_KEY ? { openAiApiKey: parsed.OPENAI_API_KEY } : {}),
  ...(parsed.ANTHROPIC_API_KEY
    ? { anthropicApiKey: parsed.ANTHROPIC_API_KEY }
    : {}),
  ...(parsed.CODEX_BIN ? { codexBinary: parsed.CODEX_BIN } : {}),
  ...(parsed.CODEX_HOME ? { codexHome: parsed.CODEX_HOME } : {}),
  ...(parsed.CLAUDE_BIN ? { claudeBinary: parsed.CLAUDE_BIN } : {}),
  ...(parsed.CLAUDE_CODE_OAUTH_TOKEN
    ? { claudeOauthToken: parsed.CLAUDE_CODE_OAUTH_TOKEN }
    : {}),
};

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

try {
  do {
    const jobId = await claimNextJob(database);
    if (jobId)
      await processReviewJob(database, workerConfig, jobId).catch((error) => {
        process.stderr.write(
          `Review job ${jobId} failed: ${error instanceof Error ? error.message : "unknown"}\n`,
        );
      });
    else if (parsed.WORKER_RUN_ONCE === "0") await delay(parsed.WORKER_POLL_MS);
  } while (!stopping && parsed.WORKER_RUN_ONCE === "0");
} finally {
  await database.$disconnect();
}
