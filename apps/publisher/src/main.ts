import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { createDatabaseClient } from "@situation-studio/db";
import { z } from "zod";
import { RepositoryPublisher } from "./repository";
import { nextPublicationRequest, processPublication } from "./service";
import { nextRollbackRequest, processRollback } from "./rollback";

const schema = z
  .object({
    DATABASE_URL: z.string().startsWith("postgresql://"),
    PUBLISHER_RUNTIME_ENV: z.enum(["validation", "production"]),
    PUBLISHER_PROFILE: z.enum(["leadership-validation", "protected-beta"]),
    PUBLISHER_REMOTE_URL: z.string().min(1),
    PUBLISHER_STATE_ROOT: z.string().min(1),
    PUBLISHER_RELEASE_ROOT: z.string().min(1),
    PUBLISHER_PREVIEW_LINK: z.string().min(1),
    PUBLISHER_LIVE_LINK: z.string().min(1),
    PUBLISHER_ACTIVATION_BINARY: z.string().startsWith("/"),
    PUBLISHER_PREVIEW_PROCESS: z.string().min(1),
    PUBLISHER_LIVE_PROCESS: z.string().min(1),
    PUBLISHER_PREVIEW_HEALTH_URL: z.string().url(),
    PUBLISHER_LIVE_HEALTH_URL: z.string().url(),
    PUBLISHER_POLL_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(60_000)
      .default(2000),
    PUBLISHER_RUN_ONCE: z.enum(["0", "1"]).default("0"),
  })
  .superRefine((value, context) => {
    if (
      value.PUBLISHER_PROFILE === "leadership-validation" &&
      value.PUBLISHER_RUNTIME_ENV !== "validation"
    )
      context.addIssue({
        code: "custom",
        path: ["PUBLISHER_PROFILE"],
        message: "The fixture publisher profile is validation-only.",
      });
    if (
      value.PUBLISHER_PROFILE === "protected-beta" &&
      value.PUBLISHER_RUNTIME_ENV !== "production"
    )
      context.addIssue({
        code: "custom",
        path: ["PUBLISHER_PROFILE"],
        message: "The protected beta profile requires production isolation.",
      });
  });

const config = schema.parse(process.env);
const database = createDatabaseClient(config.DATABASE_URL, 2);
const stateRoot = path.resolve(config.PUBLISHER_STATE_ROOT);
const publisher = new RepositoryPublisher({
  remoteUrl: config.PUBLISHER_REMOTE_URL,
  cachePath: path.join(stateRoot, "repository.git"),
  workRoot: path.join(stateRoot, "worktrees"),
  releaseRoot: path.resolve(config.PUBLISHER_RELEASE_ROOT),
  previewLink: path.resolve(config.PUBLISHER_PREVIEW_LINK),
  liveLink: path.resolve(config.PUBLISHER_LIVE_LINK),
  activationBinary: path.resolve(config.PUBLISHER_ACTIVATION_BINARY),
  previewProcessName: config.PUBLISHER_PREVIEW_PROCESS,
  liveProcessName: config.PUBLISHER_LIVE_PROCESS,
  previewHealthUrl: config.PUBLISHER_PREVIEW_HEALTH_URL,
  liveHealthUrl: config.PUBLISHER_LIVE_HEALTH_URL,
  validationCommands: [
    { binary: "pnpm", args: ["install", "--frozen-lockfile"] },
    { binary: "pnpm", args: ["lint"] },
    { binary: "pnpm", args: ["typecheck"] },
    { binary: "pnpm", args: ["content:validate"] },
    { binary: "pnpm", args: ["test"] },
    { binary: "pnpm", args: ["build"] },
  ],
  validationEnvironment: {
    NEXT_PUBLIC_SITE_URL:
      config.PUBLISHER_PROFILE === "protected-beta"
        ? "https://leadership.timsprototypes.com"
        : "http://127.0.0.1:3305",
  },
});

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

try {
  do {
    const requestId = await nextPublicationRequest(database);
    if (requestId)
      await processPublication(database, publisher, requestId).catch(
        (error) => {
          process.stderr.write(
            `Publication ${requestId} failed: ${error instanceof Error ? error.message : "unknown"}\n`,
          );
        },
      );
    else {
      const rollbackId = await nextRollbackRequest(database);
      if (rollbackId)
        await processRollback(database, publisher, rollbackId).catch(
          (error) => {
            process.stderr.write(
              `Rollback ${rollbackId} failed: ${error instanceof Error ? error.message : "unknown"}\n`,
            );
          },
        );
      else if (config.PUBLISHER_RUN_ONCE === "0")
        await delay(config.PUBLISHER_POLL_MS);
    }
  } while (!stopping && config.PUBLISHER_RUN_ONCE === "0");
} finally {
  await database.$disconnect();
}
