import { createHash } from "node:crypto";
import { database } from "@/server/database";
import {
  publicReviewFailureClassSchema,
  publicReviewFailureReasonCodeSchema,
  reviewStatusSnapshotSchema,
  REVIEW_STAGE_TOTAL,
  REVIEW_STATUS_SCHEMA_VERSION,
  type PublicReviewFailureClass,
  type PublicReviewFailureReasonCode,
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
  "issue-register": "Combining the independent critiques",
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
  "audit-page-language": "Auditing page language and cognitive load",
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
  laneOwner?: boolean;
  retryNotBefore: Date | null;
  failureCode: string | null;
  failureReasonCode?: string | null;
  failureStageOrdinal?: number | null;
  failureStageRole?: string | null;
  proposal: { id: string } | null;
  steps: ReviewStatusStep[];
};

const PUBLIC_FAILURE_REASONS: Record<
  PublicReviewFailureReasonCode,
  { title: string; explanation: string }
> = {
  PROVIDER_CAPACITY: {
    title: "The review provider was busy",
    explanation: "The provider could not accept this review stage.",
  },
  PROVIDER_TRANSIENT: {
    title: "The review provider was interrupted",
    explanation: "The provider timed out or returned a temporary error.",
  },
  PROVIDER_AUTHENTICATION: {
    title: "The review provider needs authentication",
    explanation: "The worker could not authenticate with the review provider.",
  },
  PROVIDER_OUTPUT_INVALID: {
    title: "The provider response could not be used",
    explanation: "The response did not match the required review structure.",
  },
  CANDIDATE_METADATA_JSON_INVALID: {
    title: "A proposed metadata change was invalid",
    explanation: "The bundle writer returned metadata that was not valid JSON.",
  },
  CANDIDATE_OUTPUT_INVALID: {
    title: "The proposed revision could not be built",
    explanation:
      "A bundle-writer change did not satisfy the safe candidate format.",
  },
  CANDIDATE_FINDING_REFERENCE_INVALID: {
    title: "A proposal change lost its evidence link",
    explanation:
      "The bundle writer referenced a finding that the completed review did not contain.",
  },
  PROPOSAL_MATERIALIZATION_FAILED: {
    title: "The proposal could not be assembled",
    explanation:
      "The completed stage outputs could not be combined into a reviewable proposal.",
  },
  REVIEW_EVIDENCE_BUILD_FAILED: {
    title: "The review evidence could not be prepared",
    explanation:
      "The worker could not build the safe input for this review stage.",
  },
  REVIEW_INPUT_VALIDATION_FAILED: {
    title: "The saved review input did not validate",
    explanation:
      "The pinned situation bundle failed the final deterministic check.",
  },
  REVIEW_APPLICATION_FAILED: {
    title: "Review processing stopped",
    explanation: "The worker could not complete an internal review operation.",
  },
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

function defaultReasonCode(
  failureClass: PublicReviewFailureClass,
): PublicReviewFailureReasonCode {
  const defaults: Record<
    PublicReviewFailureClass,
    PublicReviewFailureReasonCode
  > = {
    PROVIDER_CAPACITY: "PROVIDER_CAPACITY",
    PROVIDER_TRANSIENT: "PROVIDER_TRANSIENT",
    PROVIDER_AUTH: "PROVIDER_AUTHENTICATION",
    OUTPUT_INVALID: "PROVIDER_OUTPUT_INVALID",
    APPLICATION: "REVIEW_APPLICATION_FAILED",
    CANCELLED: "REVIEW_APPLICATION_FAILED",
  };
  return defaults[failureClass];
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
  const projectedFailureClass =
    retryFailureClass ??
    terminalFailureClass ??
    (record.state === "FAILED" ? "APPLICATION" : null);
  const storedReason = publicReviewFailureReasonCodeSchema.safeParse(
    record.failureReasonCode,
  );
  const reasonCode = projectedFailureClass
    ? storedReason.success
      ? storedReason.data
      : defaultReasonCode(projectedFailureClass)
    : null;
  const failureStageOrdinal =
    record.failureStageOrdinal ?? currentStep?.ordinal ?? null;
  const failureStageRole =
    record.failureStageRole ?? currentStep?.roleCode ?? null;
  const failureStage =
    failureStageOrdinal &&
    failureStageOrdinal >= 1 &&
    failureStageOrdinal <= steps.length &&
    failureStageRole &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(failureStageRole)
      ? {
          ordinal: failureStageOrdinal,
          code: failureStageRole,
          displayName: reviewStageDisplayName(
            failureStageRole,
            failureStageOrdinal,
          ),
        }
      : null;
  const laneState =
    record.state === "RUNNING" || record.laneOwner
      ? ("FOCUSED" as const)
      : record.state === "QUEUED"
        ? ("WAITING" as const)
        : ("RELEASED" as const);
  const base = {
    schemaVersion: REVIEW_STATUS_SCHEMA_VERSION,
    reviewJobId: record.id,
    state: record.state,
    completedStages: steps.filter((step) => step.state === "SUCCEEDED").length,
    totalStages: steps.length,
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
    laneState,
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
    failure:
      projectedFailureClass && reasonCode
        ? {
            failureClass: projectedFailureClass,
            reasonCode,
            ...PUBLIC_FAILURE_REASONS[reasonCode],
            stage: failureStage,
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
  laneOwner: true,
  retryNotBefore: true,
  failureCode: true,
  failureReasonCode: true,
  failureStageOrdinal: true,
  failureStageRole: true,
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
