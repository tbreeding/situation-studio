import { z } from "zod";

export const REVIEW_STATUS_SCHEMA_VERSION = "review-status-v1" as const;
export const REVIEW_STATUS_EVENT_NAME = "review-status" as const;
export const REVIEW_STAGE_TOTAL = 22 as const;

export const reviewJobStateSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

export const publicReviewFailureClassSchema = z.enum([
  "PROVIDER_CAPACITY",
  "PROVIDER_TRANSIENT",
  "PROVIDER_AUTH",
  "OUTPUT_INVALID",
  "APPLICATION",
  "CANCELLED",
]);

export const publicReviewStageStateSchema = z.enum([
  "PENDING",
  "READY",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

const publicStageCodeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const publicStageSnapshotSchema = z.object({
  ordinal: z.number().int().min(1).max(REVIEW_STAGE_TOTAL),
  state: publicReviewStageStateSchema,
});

const publicCurrentStageSchema = z.object({
  ordinal: z.number().int().min(1).max(REVIEW_STAGE_TOTAL),
  code: publicStageCodeSchema,
  displayName: z.string().min(1).max(120),
  state: publicReviewStageStateSchema,
  attempt: z.number().int().min(1).max(100).nullable(),
});

const publicRetrySnapshotSchema = z.object({
  state: z.literal("SCHEDULED"),
  stageOrdinal: z.number().int().min(1).max(REVIEW_STAGE_TOTAL),
  failureClass: publicReviewFailureClassSchema,
  attempt: z.number().int().min(1).max(100),
  maximumAttempts: z.number().int().min(1).max(100),
  scheduledAt: z.iso.datetime({ offset: true }),
});

const publicTerminalSnapshotSchema = z.object({
  state: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
  failureClass: publicReviewFailureClassSchema.nullable(),
});

export const reviewStatusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_STATUS_SCHEMA_VERSION),
    reviewJobId: z.uuid(),
    state: reviewJobStateSchema,
    completedStages: z.number().int().min(0).max(REVIEW_STAGE_TOTAL),
    totalStages: z.literal(REVIEW_STAGE_TOTAL),
    stages: z.array(publicStageSnapshotSchema).length(REVIEW_STAGE_TOTAL),
    currentStage: publicCurrentStageSchema.nullable(),
    retry: publicRetrySnapshotSchema.nullable(),
    terminal: publicTerminalSnapshotSchema.nullable(),
    proposalReady: z.boolean(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((snapshot, context) => {
    const ordinals = new Set(snapshot.stages.map((stage) => stage.ordinal));
    if (ordinals.size !== REVIEW_STAGE_TOTAL)
      context.addIssue({
        code: "custom",
        message: "Review stages must have unique ordinals.",
        path: ["stages"],
      });
    const completed = snapshot.stages.filter(
      (stage) => stage.state === "SUCCEEDED",
    ).length;
    if (completed !== snapshot.completedStages)
      context.addIssue({
        code: "custom",
        message: "Completed-stage count does not match stage states.",
        path: ["completedStages"],
      });
    const terminal = ["SUCCEEDED", "FAILED", "CANCELLED"].includes(
      snapshot.state,
    );
    if (terminal !== Boolean(snapshot.terminal))
      context.addIssue({
        code: "custom",
        message: "Terminal details must match the review state.",
        path: ["terminal"],
      });
    if (snapshot.terminal && snapshot.terminal.state !== snapshot.state)
      context.addIssue({
        code: "custom",
        message: "Terminal state must match the review state.",
        path: ["terminal", "state"],
      });
    if (snapshot.retry && snapshot.state !== "QUEUED")
      context.addIssue({
        code: "custom",
        message: "Only a queued review may have a scheduled retry.",
        path: ["retry"],
      });
  });

export type ReviewJobState = z.infer<typeof reviewJobStateSchema>;
export type PublicReviewFailureClass = z.infer<
  typeof publicReviewFailureClassSchema
>;
export type ReviewStatusSnapshot = z.infer<typeof reviewStatusSnapshotSchema>;

export function isActiveReviewState(state: ReviewJobState) {
  return state === "QUEUED" || state === "RUNNING";
}

export function isTerminalReviewState(state: ReviewJobState) {
  return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED";
}
