export type PublicationProgressStatus = "complete" | "current" | "pending";

export type PublicationProgressStep = {
  key: "confirmation" | "authority" | "leadership" | "studio";
  label: string;
  description: string;
  status: PublicationProgressStatus;
};

export type PublicationLiveStage = {
  label: string;
  detail: string;
};

const publicationActivityLabels: Record<string, string> = {
  SNAPSHOT_MATERIALIZED: "Exact candidate snapshot created",
  SNAPSHOT_VALIDATED: "Candidate content validated",
  CANDIDATE_AVAILABLE: "Private candidate made available",
  CANDIDATE_VERIFIED: "Private candidate verified by Leadership",
  OFFICIAL_POINTER_COMMITTED: "Official database snapshot selected",
  PUBLICATION_RECONCILED: "Leadership verified and publication reconciled",
  PUBLICATION_RESTORING_PREVIOUS: "Restoring the previous official snapshot",
  PUBLICATION_AUTO_ROLLED_BACK: "Previous official snapshot restored",
  PUBLICATION_RECONCILIATION_REQUIRED:
    "Publication stopped for operator reconciliation",
  PUBLICATION_FAILED_BEFORE_CONFIRMATION:
    "Private preview stopped before publication",
};

export function publicationActivityLabel(eventType: string) {
  return (
    publicationActivityLabels[eventType] ??
    eventType
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/^./u, (letter) => letter.toUpperCase())
  );
}

export function publicationLiveStage(
  state: string,
  backend: "git" | "database" = "git",
): PublicationLiveStage {
  if (state === "AWAITING_CONFIRMATION")
    return {
      label: "Confirmation is queued for the publisher",
      detail:
        "The confirmation is durable. The publisher will resume this exact request without another click.",
    };
  if (state === "OFFICIAL_POINTER_COMMITTED")
    return {
      label:
        backend === "database"
          ? "Checking Leadership for the exact official snapshot"
          : "Checking the activated Leadership release",
      detail:
        backend === "database"
          ? "Leadership is loading the new official database snapshot and returning a signed health receipt. This check is bounded; Studio restores the previous snapshot automatically if it cannot verify the new one."
          : "Leadership is proving that the already-staged release is live before Studio completes publication.",
    };
  if (state === "CUTOVER")
    return {
      label: "Activating the reviewed Leadership release",
      detail:
        "The publisher is switching the live release to the exact candidate and will verify it before reconciliation.",
    };
  if (state === "LIVE_VERIFIED")
    return {
      label: "Leadership is verified; finishing reconciliation",
      detail:
        "The exact live content passed verification. Studio is recording the new baseline and releasing publisher custody.",
    };
  if (state === "RECONCILED")
    return {
      label: "Publication completed successfully",
      detail:
        "Leadership and Studio agree on the exact official snapshot, and publisher custody has been released.",
    };
  if (state === "RESTORING_PREVIOUS")
    return {
      label: "Restoring the previous official snapshot",
      detail:
        "The new snapshot did not verify in time. Studio is restoring and verifying the last known-good official content.",
    };
  return {
    label:
      backend === "database"
        ? "Preparing the exact database snapshot"
        : "Preparing the exact Leadership release",
    detail:
      "The trusted publisher is advancing the durable request. Closing this page will not interrupt it.",
  };
}

export function privateCandidateHandoffDestination(bootstrapUrl: string) {
  const candidate = new URL(bootstrapUrl);
  if (
    !["http:", "https:"].includes(candidate.protocol) ||
    candidate.username ||
    candidate.password ||
    candidate.pathname !== "/candidate/bootstrap" ||
    !/^[a-f0-9]{64}$/u.test(candidate.searchParams.get("state") ?? "")
  )
    throw new Error("Invalid candidate origin");
  const callback = new URL(candidate.searchParams.get("callback") ?? "");
  if (!["http:", "https:"].includes(callback.protocol))
    throw new Error("Invalid candidate callback");
  return candidate.toString();
}

export function reconciliationDisagreement(input: {
  kind: "publication" | "rollback";
  officialSnapshotHash: string | null;
  observedSnapshotHash: string | null;
  candidateSnapshotHash: string | null;
}) {
  const short = (value: string | null) => value?.slice(0, 12) ?? "unavailable";
  return `${input.kind === "rollback" ? "Rollback" : "Publication"} needs reconciliation. Official database snapshot ${short(input.officialSnapshotHash)}, Leadership last observed ${short(input.observedSnapshotHash)}, and Studio candidate ${short(input.candidateSnapshotHash)} disagree. Further publication is blocked; restore Leadership from the frozen verified official cache while operations investigate.`;
}

const stagingStates = new Set([
  "REQUESTED",
  "SNAPSHOT_MATERIALIZED",
  "SNAPSHOT_VALIDATED",
  "CANDIDATE_AVAILABLE",
  "CANDIDATE_VERIFIED",
  "WORKTREE_READY",
  "APPLIED",
  "VALIDATED",
  "COMMITTED",
  "PUSHED",
  "PREVIEW_BUILT",
  "PREVIEW_VERIFIED",
]);

const postConfirmationStates = new Set([
  "OFFICIAL_POINTER_COMMITTED",
  "CUTOVER",
  "LIVE_VERIFIED",
  "RECONCILED",
]);

const terminalStates = new Set([
  "RECONCILED",
  "FAILED_PREVIEW",
  "AUTO_ROLLED_BACK",
  "RECONCILIATION_REQUIRED",
]);

export function isAwaitingHumanConfirmation(
  state: string,
  finalConfirmed: boolean,
) {
  return state === "AWAITING_CONFIRMATION" && !finalConfirmed;
}

export function isPrivateCandidateReviewPending(
  backend: "git" | "database",
  state: string,
) {
  return backend === "database" && state === "CANDIDATE_AVAILABLE";
}

export function canPrepareDatabaseFailedPreviewRecovery(input: {
  publicationBackend: "git" | "database";
  bundleState: string | null;
  publicationRequestState: string | null;
  ownsCheckout: boolean;
  canApprove: boolean;
}) {
  return (
    input.publicationBackend === "database" &&
    ["APPROVED", "HUMAN_REVIEW"].includes(input.bundleState ?? "") &&
    input.publicationRequestState === "FAILED_PREVIEW" &&
    input.ownsCheckout &&
    input.canApprove
  );
}

export function shouldPollPublication(
  state: string,
  finalConfirmed: boolean,
  confirmationSubmitted = false,
) {
  if (terminalStates.has(state)) return false;
  if (stagingStates.has(state)) return true;
  return (
    state === "AWAITING_CONFIRMATION" &&
    (finalConfirmed || confirmationSubmitted)
  );
}

export function publicationDecisionLabel(
  state: string,
  finalConfirmed: boolean,
  backend: "git" | "database" = "git",
) {
  if (isAwaitingHumanConfirmation(state, finalConfirmed))
    return "Awaiting your confirmation";
  if (state === "RECONCILED") return "Published successfully";
  if (state === "FAILED_PREVIEW")
    return backend === "database"
      ? "Private preview failed; public content unchanged"
      : "Candidate staging failed safely";
  if (state === "AUTO_ROLLED_BACK") return "Previous version restored";
  if (state === "RECONCILIATION_REQUIRED") return "Reconciliation required";
  if (state === "OFFICIAL_POINTER_COMMITTED") return "Verifying Leadership";
  if (finalConfirmed || postConfirmationStates.has(state))
    return "Final publication in progress";
  if (backend === "database") {
    if (state === "SNAPSHOT_VALIDATED") return "Validating exact content";
    return "Preparing private preview";
  }
  return "Preparing the staged candidate";
}

function stepStatus(
  complete: boolean,
  current: boolean,
): PublicationProgressStatus {
  if (complete) return "complete";
  return current ? "current" : "pending";
}

export function publicationProgressSteps(
  state: string,
  finalConfirmed: boolean,
  confirmationSubmitted = false,
  backend: "git" | "database" = "git",
): PublicationProgressStep[] {
  const confirmationComplete =
    finalConfirmed ||
    confirmationSubmitted ||
    postConfirmationStates.has(state);
  const gitComplete =
    state === "OFFICIAL_POINTER_COMMITTED" ||
    state === "CUTOVER" ||
    state === "LIVE_VERIFIED" ||
    state === "RECONCILED";
  const leadershipComplete =
    state === "LIVE_VERIFIED" || state === "RECONCILED";
  const studioComplete = state === "RECONCILED";

  return [
    {
      key: "confirmation",
      label: "Confirmation recorded",
      description:
        "Your explicit approval is attached to this exact candidate.",
      status: stepStatus(confirmationComplete, !confirmationComplete),
    },
    {
      key: "authority",
      label:
        backend === "database"
          ? "Official snapshot selected"
          : "Protected Git main advanced",
      description:
        backend === "database"
          ? "The exact reviewed snapshot becomes the official database pointer."
          : "The staged commit becomes the official repository baseline.",
      status: stepStatus(gitComplete, confirmationComplete && !gitComplete),
    },
    {
      key: "leadership",
      label: "Leadership release verified",
      description:
        backend === "database"
          ? "Leadership attests that it loaded the exact official snapshot hash."
          : "The same staged release is checked again on Leadership.",
      status: stepStatus(
        leadershipComplete,
        gitComplete && !leadershipComplete,
      ),
    },
    {
      key: "studio",
      label: "Studio reconciled and custody released",
      description: "The new baseline is recorded and publisher custody ends.",
      status: stepStatus(studioComplete, leadershipComplete && !studioComplete),
    },
  ];
}
