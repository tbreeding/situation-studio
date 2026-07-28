import { z } from "zod";

export const PUBLICATION_STATUS_SCHEMA_VERSION =
  "publication-status-v1" as const;
export const PUBLICATION_STATUS_EVENT_NAME = "publication-status" as const;
export const PUBLICATION_STAGE_TOTAL = 5 as const;

export const publicationJobStateSchema = z.enum([
  "REQUESTED",
  "ASSEMBLING",
  "NEEDS_REFRESH",
  "PROMOTING",
  "VERIFYING",
  "SUCCEEDED",
  "RESTORED",
  "RECOVERY_REQUIRED",
  "FAILED",
]);

export const publicationStageKeySchema = z.enum([
  "STARTING",
  "BUILDING",
  "VALIDATING",
  "ACTIVATING",
  "VERIFYING",
]);

export const publicationActivityCodeSchema = z.enum([
  "STARTING",
  "BUILDING",
  "VALIDATING",
  "ACTIVATING",
  "VERIFYING",
  "RESTORING",
]);

export const publicPublicationStageStateSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "COMPLETE",
  "FAILED",
]);

const publicPublicationStageSchema = z.object({
  ordinal: z.number().int().min(1).max(PUBLICATION_STAGE_TOTAL),
  key: publicationStageKeySchema,
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(240),
  state: publicPublicationStageStateSchema,
});

const publicPublicationActivitySchema = z.object({
  code: publicationActivityCodeSchema,
  ordinal: z.number().int().min(1).max(PUBLICATION_STAGE_TOTAL).nullable(),
  displayName: z.string().min(1).max(120),
  description: z.string().min(1).max(240),
});

const publicPublicationTerminalSchema = z.object({
  state: z.enum([
    "NEEDS_REFRESH",
    "SUCCEEDED",
    "RESTORED",
    "RECOVERY_REQUIRED",
    "FAILED",
  ]),
  tone: z.enum(["SUCCESS", "WARNING", "ERROR"]),
  title: z.string().min(1).max(120),
  message: z.string().min(1).max(280),
});

export const publicationStatusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(PUBLICATION_STATUS_SCHEMA_VERSION),
    publicationJobId: z.uuid(),
    state: publicationJobStateSchema,
    completedStages: z.number().int().min(0).max(PUBLICATION_STAGE_TOTAL),
    totalStages: z.literal(PUBLICATION_STAGE_TOTAL),
    stages: z
      .array(publicPublicationStageSchema)
      .length(PUBLICATION_STAGE_TOTAL),
    currentStage: publicPublicationActivitySchema.nullable(),
    terminal: publicPublicationTerminalSchema.nullable(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((snapshot, context) => {
    const completed = snapshot.stages.filter(
      (stage) => stage.state === "COMPLETE",
    ).length;
    if (completed !== snapshot.completedStages)
      context.addIssue({
        code: "custom",
        message: "Completed-stage count does not match stage states.",
        path: ["completedStages"],
      });
    const terminal = isTerminalPublicationState(snapshot.state);
    if (terminal !== Boolean(snapshot.terminal))
      context.addIssue({
        code: "custom",
        message: "Terminal details must match the publication state.",
        path: ["terminal"],
      });
    if (snapshot.terminal && snapshot.terminal.state !== snapshot.state)
      context.addIssue({
        code: "custom",
        message: "Terminal state must match the publication state.",
        path: ["terminal", "state"],
      });
  });

export type PublicationJobState = z.infer<typeof publicationJobStateSchema>;
export type PublicationStatusSnapshot = z.infer<
  typeof publicationStatusSnapshotSchema
>;

export function isActivePublicationState(state: PublicationJobState) {
  return (
    state === "REQUESTED" ||
    state === "ASSEMBLING" ||
    state === "PROMOTING" ||
    state === "VERIFYING"
  );
}

export function isTerminalPublicationState(state: PublicationJobState) {
  return !isActivePublicationState(state);
}
