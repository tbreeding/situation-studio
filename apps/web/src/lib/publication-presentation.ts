export type PublicationProgressStatus = "complete" | "current" | "pending";

export type PublicationProgressStep = {
  key: "confirmation" | "git" | "leadership" | "studio";
  label: string;
  description: string;
  status: PublicationProgressStatus;
};

const stagingStates = new Set([
  "REQUESTED",
  "WORKTREE_READY",
  "APPLIED",
  "VALIDATED",
  "COMMITTED",
  "PUSHED",
  "PREVIEW_BUILT",
  "PREVIEW_VERIFIED",
]);

const postConfirmationStates = new Set([
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
) {
  if (isAwaitingHumanConfirmation(state, finalConfirmed))
    return "Awaiting your confirmation";
  if (state === "RECONCILED") return "Published and reconciled";
  if (state === "FAILED_PREVIEW") return "Candidate staging failed safely";
  if (state === "AUTO_ROLLED_BACK") return "Previous release restored";
  if (state === "RECONCILIATION_REQUIRED") return "Reconciliation required";
  if (finalConfirmed || postConfirmationStates.has(state))
    return "Final publication in progress";
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
): PublicationProgressStep[] {
  const confirmationComplete =
    finalConfirmed ||
    confirmationSubmitted ||
    postConfirmationStates.has(state);
  const gitComplete =
    state === "CUTOVER" || state === "LIVE_VERIFIED" || state === "RECONCILED";
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
      key: "git",
      label: "Protected Git main advanced",
      description:
        "The staged commit becomes the official repository baseline.",
      status: stepStatus(gitComplete, confirmationComplete && !gitComplete),
    },
    {
      key: "leadership",
      label: "Leadership release verified",
      description: "The same staged release is checked again on Leadership.",
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
