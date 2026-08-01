import { z } from "zod";

export const REVIEW_STATUS_SCHEMA_VERSION = "review-status-v3" as const;
export const REVIEW_STATUS_EVENT_NAME = "review-status" as const;
export const REVIEW_STAGE_TOTAL = 24 as const;
export const LEGACY_REVIEW_STAGE_TOTAL = 22 as const;

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

export const publicReviewFailureReasonCodeSchema = z.enum([
  "PROVIDER_CAPACITY",
  "PROVIDER_TRANSIENT",
  "PROVIDER_AUTHENTICATION",
  "PROVIDER_OUTPUT_INVALID",
  "CANDIDATE_METADATA_JSON_INVALID",
  "CANDIDATE_OUTPUT_INVALID",
  "CANDIDATE_FINDING_REFERENCE_INVALID",
  "PROPOSAL_MATERIALIZATION_FAILED",
  "REVIEW_EVIDENCE_BUILD_FAILED",
  "REVIEW_INPUT_VALIDATION_FAILED",
  "REVIEW_APPLICATION_FAILED",
]);

export const publicReviewLaneStateSchema = z.enum([
  "FOCUSED",
  "WAITING",
  "RELEASED",
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

const publicFailureSnapshotSchema = z.object({
  failureClass: publicReviewFailureClassSchema,
  reasonCode: publicReviewFailureReasonCodeSchema,
  title: z.string().min(1).max(120),
  explanation: z.string().min(1).max(300),
  stage: publicCurrentStageSchema
    .pick({ ordinal: true, code: true, displayName: true })
    .nullable(),
});

export const reviewStatusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_STATUS_SCHEMA_VERSION),
    reviewJobId: z.uuid(),
    state: reviewJobStateSchema,
    completedStages: z.number().int().min(0).max(REVIEW_STAGE_TOTAL),
    totalStages: z.union([
      z.literal(LEGACY_REVIEW_STAGE_TOTAL),
      z.literal(REVIEW_STAGE_TOTAL),
    ]),
    stages: z
      .array(publicStageSnapshotSchema)
      .min(LEGACY_REVIEW_STAGE_TOTAL)
      .max(REVIEW_STAGE_TOTAL),
    currentStage: publicCurrentStageSchema.nullable(),
    laneState: publicReviewLaneStateSchema,
    retry: publicRetrySnapshotSchema.nullable(),
    terminal: publicTerminalSnapshotSchema.nullable(),
    failure: publicFailureSnapshotSchema.nullable(),
    proposalReady: z.boolean(),
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((snapshot, context) => {
    const ordinals = new Set(snapshot.stages.map((stage) => stage.ordinal));
    if (
      ordinals.size !== snapshot.totalStages ||
      snapshot.stages.length !== snapshot.totalStages
    )
      context.addIssue({
        code: "custom",
        message:
          "Review stages must match the declared total and have unique ordinals.",
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
    if (snapshot.state === "RUNNING" && snapshot.laneState !== "FOCUSED")
      context.addIssue({
        code: "custom",
        message: "A running review must own the focused review lane.",
        path: ["laneState"],
      });
    if (
      ["SUCCEEDED", "CANCELLED"].includes(snapshot.state) &&
      snapshot.laneState !== "RELEASED"
    )
      context.addIssue({
        code: "custom",
        message: "A completed or cancelled review must release the lane.",
        path: ["laneState"],
      });
    if ((snapshot.retry || snapshot.state === "FAILED") && !snapshot.failure)
      context.addIssue({
        code: "custom",
        message: "A retrying or failed review must explain the safe failure.",
        path: ["failure"],
      });
  });

export type ReviewJobState = z.infer<typeof reviewJobStateSchema>;
export type PublicReviewFailureClass = z.infer<
  typeof publicReviewFailureClassSchema
>;
export type PublicReviewFailureReasonCode = z.infer<
  typeof publicReviewFailureReasonCodeSchema
>;
export type ReviewStatusSnapshot = z.infer<typeof reviewStatusSnapshotSchema>;

export function isActiveReviewState(state: ReviewJobState) {
  return state === "QUEUED" || state === "RUNNING";
}

export function isTerminalReviewState(state: ReviewJobState) {
  return state === "SUCCEEDED" || state === "FAILED" || state === "CANCELLED";
}
