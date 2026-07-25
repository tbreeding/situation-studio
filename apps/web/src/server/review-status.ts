import { createHash } from "node:crypto";
import { database } from "@/server/database";
import {
  publicReviewFailureClassSchema,
  reviewStatusSnapshotSchema,
  REVIEW_STAGE_TOTAL,
  REVIEW_STATUS_SCHEMA_VERSION,
  type PublicReviewFailureClass,
  type ReviewStatusSnapshot,
} from "@/review-status-contract";

const REVIEW_STAGE_DISPLAY_NAMES: Record<string, string> = {
  "surface-mapper": "Mapping the review surfaces",
  "critic-nvc": "Nonviolent communication critique",
  "critic-negotiation": "Negotiation critique",
  "critic-coaching": "Coaching critique",
  "critic-team-health": "Team health critique",
  "critic-radical-candor": "Radical Candor critique",
  "critic-change-systems": "Change-systems critique",
  "critic-manager-tools": "Manager Tools critique",
  "rebuttal-nvc": "Nonviolent communication rebuttal",
  "rebuttal-negotiation": "Negotiation rebuttal",
  "rebuttal-coaching": "Coaching rebuttal",
  "rebuttal-team-health": "Team health rebuttal",
  "rebuttal-radical-candor": "Radical Candor rebuttal",
  "rebuttal-change-systems": "Change-systems rebuttal",
  "rebuttal-manager-tools": "Manager Tools rebuttal",
  adjudicator: "Adjudicating the recommendations",
  "teaching-designer": "Designing the teaching approach",
  "bundle-writer": "Writing the proposal bundle",
  "audit-semantic": "Auditing semantic integrity",
  "audit-teaching-alignment": "Auditing teaching alignment",
  "audit-repository-integrity": "Auditing repository integrity",
  "deterministic-validator": "Validating the proposal",
};

type ReviewStatusRun = {
  attempt: number;
  failureClass: string | null;
  retryable: boolean | null;
};

type ReviewStatusStep = {
  ordinal: number;
  roleCode: string;
  state: string;
  runs: ReviewStatusRun[];
};

export type ReviewStatusRecord = {
  id: string;
  state: string;
  retryNotBefore: Date | null;
  failureCode: string | null;
  proposal: { id: string } | null;
  steps: ReviewStatusStep[];
};

function safeFailureClass(value: string | null | undefined) {
  const parsed = publicReviewFailureClassSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function safeJobFailureClass(
  value: string | null,
): PublicReviewFailureClass | null {
  const mapping: Record<string, PublicReviewFailureClass> = {
    CAPACITY: "PROVIDER_CAPACITY",
    TRANSIENT: "PROVIDER_TRANSIENT",
    AUTHENTICATION: "PROVIDER_AUTH",
    INVALID_OUTPUT: "OUTPUT_INVALID",
    APPLICATION: "APPLICATION",
    CANCELLED: "CANCELLED",
  };
  return value ? (mapping[value] ?? null) : null;
}

function snapshotIdentity(value: object) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function reviewStageDisplayName(roleCode: string, ordinal: number) {
  return (
    REVIEW_STAGE_DISPLAY_NAMES[roleCode] ??
    `Review stage ${Math.min(Math.max(ordinal, 1), REVIEW_STAGE_TOTAL)}`
  );
}

export function buildReviewStatusSnapshot(
  record: ReviewStatusRecord,
): ReviewStatusSnapshot {
  const steps = [...record.steps].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const retryingStep =
    record.state === "QUEUED" && record.retryNotBefore
      ? steps.find((step) => {
          const run = step.runs[0];
          return (
            step.state === "READY" &&
            run?.retryable === true &&
            safeFailureClass(run.failureClass) !== null
          );
        })
      : null;
  const currentStep =
    steps.find((step) => step.state === "RUNNING") ??
    retryingStep ??
    steps.find((step) => step.state === "FAILED") ??
    steps.find(
      (step) =>
        step.state === "READY" ||
        step.state === "PENDING" ||
        step.state === "CANCELLED",
    ) ??
    null;
  const currentRun = currentStep?.runs[0] ?? null;
  const retryFailureClass = safeFailureClass(
    retryingStep?.runs[0]?.failureClass,
  );
  const failedStep = steps.find((step) => step.state === "FAILED");
  const terminalFailureClass =
    safeFailureClass(failedStep?.runs[0]?.failureClass) ??
    safeJobFailureClass(record.failureCode);
  const base = {
    schemaVersion: REVIEW_STATUS_SCHEMA_VERSION,
    reviewJobId: record.id,
    state: record.state,
    completedStages: steps.filter((step) => step.state === "SUCCEEDED").length,
    totalStages: REVIEW_STAGE_TOTAL,
    stages: steps.map((step) => ({
      ordinal: step.ordinal,
      state: step.state,
    })),
    currentStage: currentStep
      ? {
          ordinal: currentStep.ordinal,
          code: currentStep.roleCode,
          displayName: reviewStageDisplayName(
            currentStep.roleCode,
            currentStep.ordinal,
          ),
          state: currentStep.state,
          attempt:
            currentStep.state === "RUNNING" ||
            currentStep.state === "FAILED" ||
            currentStep === retryingStep
              ? (currentRun?.attempt ?? null)
              : null,
        }
      : null,
    retry:
      retryingStep && retryFailureClass && record.retryNotBefore
        ? {
            state: "SCHEDULED" as const,
            stageOrdinal: retryingStep.ordinal,
            failureClass: retryFailureClass,
            attempt: retryingStep.runs[0]!.attempt,
            maximumAttempts: 3,
            scheduledAt: record.retryNotBefore.toISOString(),
          }
        : null,
    terminal:
      record.state === "SUCCEEDED" ||
      record.state === "FAILED" ||
      record.state === "CANCELLED"
        ? {
            state: record.state,
            failureClass:
              record.state === "FAILED" ? terminalFailureClass : null,
          }
        : null,
    proposalReady: Boolean(record.proposal),
  };
  return reviewStatusSnapshotSchema.parse({
    ...base,
    snapshotId: snapshotIdentity(base),
  });
}

const reviewStatusSelection = {
  id: true,
  state: true,
  retryNotBefore: true,
  failureCode: true,
  proposal: { select: { id: true } },
  steps: {
    orderBy: { ordinal: "asc" as const },
    select: {
      ordinal: true,
      roleCode: true,
      state: true,
      runs: {
        orderBy: { attempt: "desc" as const },
        take: 1,
        select: {
          attempt: true,
          failureClass: true,
          retryable: true,
        },
      },
    },
  },
};

export async function loadReviewStatusSnapshot(
  reviewJobId: string,
): Promise<ReviewStatusSnapshot | null> {
  const record = await database().reviewJob.findUnique({
    where: { id: reviewJobId },
    select: reviewStatusSelection,
  });
  return record
    ? buildReviewStatusSnapshot(record as ReviewStatusRecord)
    : null;
}
