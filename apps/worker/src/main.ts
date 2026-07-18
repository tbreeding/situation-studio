import { createDatabaseClient } from "@situation-studio/db";
import { MODEL_POLICY } from "@situation-studio/domain";
import { z } from "zod";

const configSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  PROVIDER_EXECUTION_MODE: z
    .enum(["disabled", "fake", "api"])
    .default("disabled"),
});
const config = configSchema.parse(process.env);
const database = createDatabaseClient(config.DATABASE_URL, 4);

const queued = await database.aiJob.count({ where: { state: "QUEUED" } });
process.stdout.write(
  JSON.stringify({
    service: "situation-studio-worker",
    state: "ready",
    queued,
    providerMode: config.PROVIDER_EXECUTION_MODE,
    modelPolicy: MODEL_POLICY.version,
  }) + "\n",
);
await database.$disconnect();
