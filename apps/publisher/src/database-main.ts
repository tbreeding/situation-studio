import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseClient } from "@situation-studio/db";
import { z } from "zod";
import {
  observationDeadlineExpired,
  requestLeadershipObservation,
  type ObservationKind,
} from "./database-observation";
import {
  beginAutomaticRollbackRestoration,
  beginAutomaticRestoration,
  markPublicationReconciliationRequired,
  markRollbackReconciliationRequired,
  processDatabaseRollback,
  processDatabasePublication,
} from "./database-service";

const configuration = z
  .object({
    DATABASE_URL: z.string().startsWith("postgresql://"),
    DATABASE_PUBLICATION_POLL_MS: z.coerce
      .number()
      .int()
      .min(250)
      .max(60_000)
      .default(2_000),
    DATABASE_PUBLICATION_RUN_ONCE: z.enum(["0", "1"]).default("0"),
    LEADERSHIP_OBSERVATION_URL: z.string().url(),
    LEADERSHIP_OBSERVATION_TRIGGER_SECRET: z.string().min(32),
    DATABASE_PUBLICATION_LIVE_VERIFY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(15 * 60_000)
      .default(120_000),
    DATABASE_PUBLICATION_OBSERVATION_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .default(10_000),
  })
  .refine(
    (value) =>
      value.DATABASE_PUBLICATION_OBSERVATION_REQUEST_TIMEOUT_MS <=
      value.DATABASE_PUBLICATION_LIVE_VERIFY_TIMEOUT_MS,
    {
      path: ["DATABASE_PUBLICATION_OBSERVATION_REQUEST_TIMEOUT_MS"],
      message: "Observation request timeout must not exceed the live deadline.",
    },
  )
  .parse(process.env);

const database = createDatabaseClient(configuration.DATABASE_URL, 2);
let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

const activeStates = [
  "REQUESTED",
  "SNAPSHOT_MATERIALIZED",
  "SNAPSHOT_VALIDATED",
  "CANDIDATE_AVAILABLE",
  "CANDIDATE_VERIFIED",
  "AWAITING_CONFIRMATION",
  "OFFICIAL_POINTER_COMMITTED",
  "RESTORING_PREVIOUS",
] as const;

async function nextTask() {
  const [publication, rollback] = await Promise.all([
    database.publicationRequest.findFirst({
      where: {
        publicationTargetId: { not: null },
        state: { in: [...activeStates] },
      },
      orderBy: { createdAt: "asc" },
      include: { databasePublication: true },
    }),
    database.rollbackRequest.findFirst({
      where: {
        publicationTargetId: { not: null },
        state: { in: [...activeStates] },
      },
      orderBy: { createdAt: "asc" },
      include: { databasePublication: true },
    }),
  ]);
  if (!publication)
    return rollback ? { kind: "rollback" as const, request: rollback } : null;
  if (!rollback) return { kind: "publication" as const, request: publication };
  return publication.createdAt <= rollback.createdAt
    ? { kind: "publication" as const, request: publication }
    : { kind: "rollback" as const, request: rollback };
}

async function requestObservation(
  publicationRequestId: string,
  observationKind: ObservationKind,
) {
  await requestLeadershipObservation({
    url: configuration.LEADERSHIP_OBSERVATION_URL,
    triggerSecret: configuration.LEADERSHIP_OBSERVATION_TRIGGER_SECRET,
    requestTimeoutMilliseconds:
      configuration.DATABASE_PUBLICATION_OBSERVATION_REQUEST_TIMEOUT_MS,
    publicationRequestId,
    observationKind,
  });
}

try {
  do {
    const task = await nextTask();
    if (!task) {
      if (configuration.DATABASE_PUBLICATION_RUN_ONCE === "0")
        await delay(configuration.DATABASE_PUBLICATION_POLL_MS);
      continue;
    }
    try {
      const result =
        task.kind === "publication"
          ? await processDatabasePublication(database, task.request.id)
          : await processDatabaseRollback(database, task.request.id);
      if (result.state === "OFFICIAL_POINTER_COMMITTED") {
        if (!result.publicationId)
          throw new Error("Post-commit publication record is missing.");
        const publication =
          await database.databasePublication.findUniqueOrThrow({
            where: { id: result.publicationId },
          });
        try {
          await requestObservation(task.request.id, "OFFICIAL");
        } catch (error) {
          if (
            observationDeadlineExpired(
              publication.updatedAt,
              configuration.DATABASE_PUBLICATION_LIVE_VERIFY_TIMEOUT_MS,
            )
          ) {
            const reason =
              error instanceof Error
                ? error.message
                : "Leadership live verification failed.";
            try {
              if (task.kind === "publication")
                await beginAutomaticRestoration(
                  database,
                  task.request.id,
                  reason,
                );
              else
                await beginAutomaticRollbackRestoration(
                  database,
                  task.request.id,
                  reason,
                );
            } catch (restorationError) {
              const restorationReason = `Automatic restoration could not start: ${
                restorationError instanceof Error
                  ? restorationError.message
                  : "unknown failure"
              }`;
              if (task.kind === "publication")
                await markPublicationReconciliationRequired(
                  database,
                  task.request.id,
                  restorationReason,
                );
              else
                await markRollbackReconciliationRequired(
                  database,
                  task.request.id,
                  restorationReason,
                );
            }
          }
        }
      } else if (result.state === "RESTORING_PREVIOUS") {
        if (!result.publicationId)
          throw new Error("Restoration publication record is missing.");
        try {
          await requestObservation(task.request.id, "RESTORATION");
        } catch (error) {
          const publication =
            await database.databasePublication.findUniqueOrThrow({
              where: { id: result.publicationId },
            });
          if (
            observationDeadlineExpired(
              publication.updatedAt,
              configuration.DATABASE_PUBLICATION_LIVE_VERIFY_TIMEOUT_MS,
            )
          ) {
            const reason = `Restoration could not be verified before its deadline: ${
              error instanceof Error ? error.message : "unknown failure"
            }`;
            if (task.kind === "publication")
              await markPublicationReconciliationRequired(
                database,
                task.request.id,
                reason,
              );
            else
              await markRollbackReconciliationRequired(
                database,
                task.request.id,
                reason,
              );
          }
        }
      }
    } catch (error) {
      process.stderr.write(
        `Database ${task.kind} ${task.request.id} failed: ${error instanceof Error ? error.message : "unknown"}\n`,
      );
    }
    if (configuration.DATABASE_PUBLICATION_RUN_ONCE === "0")
      await delay(configuration.DATABASE_PUBLICATION_POLL_MS);
  } while (!stopping && configuration.DATABASE_PUBLICATION_RUN_ONCE === "0");
} finally {
  await database.$disconnect();
}
