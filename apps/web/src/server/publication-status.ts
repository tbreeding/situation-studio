import { createHash } from "node:crypto";
import {
  publicationFailureDetailSchema,
  type PublicationFailureDetail,
} from "@situation-studio/domain";
import { database } from "@/server/database";
import {
  publicationStatusSnapshotSchema,
  PUBLICATION_STAGE_TOTAL,
  PUBLICATION_STATUS_SCHEMA_VERSION,
  type PublicationJobState,
  type PublicationStatusSnapshot,
} from "@/publication-status-contract";

const PUBLICATION_STAGES = [
  {
    key: "STARTING",
    displayName: "Starting publication",
    description:
      "Locking the exact saved revision and confirming your checkout.",
  },
  {
    key: "BUILDING",
    displayName: "Building the release",
    description:
      "Reading current production and building a deterministic Leadership release.",
  },
  {
    key: "VALIDATING",
    displayName: "Validating the release",
    description:
      "Checking the content, relationships, and hashes before anything goes live.",
  },
  {
    key: "ACTIVATING",
    displayName: "Activating in Leadership",
    description:
      "Writing an immutable release and moving the official production pointer.",
  },
  {
    key: "VERIFYING",
    displayName: "Verifying live content",
    description:
      "Waiting for the live Leadership app to report the exact new release.",
  },
] as const;

type PublicationStatusEvent = {
  sequence: number;
  kind: string;
  createdAt?: Date;
  payload?: unknown;
};

export type PublicationStatusRecord = {
  id: string;
  state: string;
  failureCode: string | null;
  events: PublicationStatusEvent[];
};

function snapshotIdentity(value: object) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const FAILURE_DETAIL_EVENT_KINDS = new Set([
  "RESTORE_STARTED",
  "FAILED",
  "RECOVERY_REQUIRED",
]);

function failureDetailFromEvents(
  events: PublicationStatusEvent[],
  field: "failureDetail" | "recoveryFailureDetail",
) {
  for (const event of [...events].reverse()) {
    if (!FAILURE_DETAIL_EVENT_KINDS.has(event.kind)) continue;
    if (
      !event.payload ||
      typeof event.payload !== "object" ||
      Array.isArray(event.payload)
    )
      continue;
    const parsed = publicationFailureDetailSchema.safeParse(
      (event.payload as Record<string, unknown>)[field],
    );
    if (parsed.success) return parsed.data;
  }
  return null;
}

function restoredMessage(failure: PublicationFailureDetail | null) {
  if (!failure)
    return "The new release did not pass live verification, so Leadership remains on the previous verified version.";
  const checks = `${failure.attempts} ${failure.attempts === 1 ? "check" : "checks"}`;
  switch (failure.reason) {
    case "HTTP_STATUS":
      return failure.lastHttpStatus
        ? `Leadership content health returned HTTP ${failure.lastHttpStatus} after ${checks}, so the previous verified version was restored. Your saved draft and checkout are unchanged.`
        : `Leadership content health returned an error after ${checks}, so the previous verified version was restored. Your saved draft and checkout are unchanged.`;
    case "IDENTITY_MISMATCH":
      return `Leadership content health did not report the new release after ${checks}, so the previous verified version was restored. Your saved draft and checkout are unchanged.`;
    case "UNAVAILABLE":
      return `Leadership content health was unavailable after ${checks}, so the previous verified version was restored. Your saved draft and checkout are unchanged.`;
    case "INVALID_RESPONSE":
      return `Leadership content health returned an unusable response after ${checks}, so the previous verified version was restored. Your saved draft and checkout are unchanged.`;
  }
}

function terminalDetails(
  state: PublicationJobState,
  failureCode: string | null,
  failure: PublicationFailureDetail | null,
) {
  switch (state) {
    case "SUCCEEDED":
      return {
        state,
        tone: "SUCCESS" as const,
        title: "Published",
        message:
          "Leadership is serving the verified release. The draft is archived and the checkout is closed.",
      };
    case "NEEDS_REFRESH":
      return {
        state,
        tone: "WARNING" as const,
        title: "Draft needs a refresh",
        message:
          "Production changed while this draft was open. Refresh the draft before submitting it again.",
      };
    case "RESTORED":
      return {
        state,
        tone: "WARNING" as const,
        title: "Previous version restored",
        message: restoredMessage(failure),
      };
    case "RECOVERY_REQUIRED":
      return {
        state,
        tone: "ERROR" as const,
        title: "Publication needs attention",
        message:
          "Automatic recovery could not be verified. Editing stays locked while an administrator restores a known release.",
      };
    case "FAILED":
      if (failureCode === "PRACTICE_EMBED_MISMATCH")
        return {
          state,
          tone: "ERROR" as const,
          title: "Practice embed does not match",
          message:
            "Production was not changed. In Two-minute practice, make the PracticeEmbed practice ID and variant match the situation metadata before trying again.",
        };
      if (failureCode === "PREPARED_ACTION_MISMATCH")
        return {
          state,
          tone: "ERROR" as const,
          title: "Prepared action does not match",
          message:
            "Production was not changed. Make the PreparedAction scenario and skill match the situation metadata before trying again.",
        };
      if (failureCode === "CANONICAL_SNAPSHOT_INVALID")
        return {
          state,
          tone: "ERROR" as const,
          title: "Release validation failed",
          message:
            "Production was not changed. The saved draft does not satisfy Leadership's content contract; review the changed content before trying again.",
        };
      return {
        state,
        tone: "ERROR" as const,
        title: "Publication failed",
        message:
          "Production was not changed. Your saved draft remains available to try again.",
      };
    default:
      return null;
  }
}

function completedStageCount(
  state: PublicationJobState,
  eventKinds: Set<string>,
) {
  if (state === "SUCCEEDED") return PUBLICATION_STAGE_TOTAL;
  let completed = 0;
  if (
    state !== "REQUESTED" ||
    eventKinds.has("POINTER_OBSERVED") ||
    eventKinds.has("CONFLICTED")
  )
    completed = 1;
  if (
    eventKinds.has("SNAPSHOT_BUILT") ||
    state === "PROMOTING" ||
    state === "VERIFYING" ||
    state === "RESTORED" ||
    state === "RECOVERY_REQUIRED"
  )
    completed = 2;
  if (
    eventKinds.has("VALIDATED") ||
    state === "VERIFYING" ||
    state === "RESTORED" ||
    state === "RECOVERY_REQUIRED"
  )
    completed = 3;
  if (
    eventKinds.has("POINTER_ADVANCED") ||
    state === "VERIFYING" ||
    state === "RESTORED" ||
    state === "RECOVERY_REQUIRED"
  )
    completed = 4;
  if (eventKinds.has("VERIFIED")) completed = 5;
  return completed;
}

export function buildPublicationStatusSnapshot(
  record: PublicationStatusRecord,
): PublicationStatusSnapshot {
  const state = record.state as PublicationJobState;
  const events = [...record.events].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const eventKinds = new Set(events.map((event) => event.kind));
  const restoring = eventKinds.has("RESTORE_STARTED");
  const failure = failureDetailFromEvents(events, "failureDetail");
  const recoveryFailure =
    state === "RECOVERY_REQUIRED"
      ? failureDetailFromEvents(events, "recoveryFailureDetail")
      : null;
  const terminal = terminalDetails(state, record.failureCode, failure);
  const completedStages = completedStageCount(state, eventKinds);
  const failedStageIndex =
    terminal && state !== "SUCCEEDED"
      ? state === "RESTORED" || state === "RECOVERY_REQUIRED"
        ? 4
        : Math.min(completedStages, PUBLICATION_STAGE_TOTAL - 1)
      : null;
  const activeStageIndex =
    !terminal && !restoring
      ? Math.min(completedStages, PUBLICATION_STAGE_TOTAL - 1)
      : null;
  const stages = PUBLICATION_STAGES.map((stage, index) => ({
    ordinal: index + 1,
    key: stage.key,
    displayName: stage.displayName,
    description: stage.description,
    state:
      index < completedStages
        ? ("COMPLETE" as const)
        : index === failedStageIndex
          ? ("FAILED" as const)
          : index === activeStageIndex
            ? ("ACTIVE" as const)
            : ("PENDING" as const),
  }));
  const activeStage =
    activeStageIndex === null ? null : PUBLICATION_STAGES[activeStageIndex];
  const currentStage = restoring
    ? {
        code: "RESTORING" as const,
        ordinal: null,
        displayName: "Restoring the previous version",
        description:
          "Live verification did not complete, so Leadership is returning to the previous verified release.",
      }
    : activeStage
      ? {
          code: activeStage.key,
          ordinal: activeStageIndex! + 1,
          displayName: activeStage.displayName,
          description: activeStage.description,
        }
      : null;
  const base = {
    schemaVersion: PUBLICATION_STATUS_SCHEMA_VERSION,
    publicationJobId: record.id,
    state,
    completedStages: stages.filter((stage) => stage.state === "COMPLETE")
      .length,
    totalStages: PUBLICATION_STAGE_TOTAL,
    stages,
    currentStage,
    terminal,
    failure,
    recoveryFailure,
  };
  return publicationStatusSnapshotSchema.parse({
    ...base,
    snapshotId: snapshotIdentity(base),
  });
}

export async function loadPublicationStatusSnapshot(
  publicationJobId: string,
): Promise<PublicationStatusSnapshot | null> {
  const record = await database().publicationJob.findUnique({
    where: { id: publicationJobId },
    select: {
      id: true,
      state: true,
      failureCode: true,
      events: {
        orderBy: { sequence: "asc" },
        select: {
          sequence: true,
          kind: true,
          createdAt: true,
          payload: true,
        },
      },
    },
  });
  return record
    ? buildPublicationStatusSnapshot(record as PublicationStatusRecord)
    : null;
}
