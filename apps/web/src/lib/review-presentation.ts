import { workflowRoles } from "@situation-studio/domain";

export type ReviewJobState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_CAPACITY"
  | "RETRY_SCHEDULED"
  | "CANCELLING"
  | "CANCELLED"
  | "SUCCEEDED"
  | "INCOMPLETE"
  | "FAILED";

export type ReviewStepSnapshot = {
  role: string;
  state: string;
  updatedAt: string;
};

export type ReviewJobSnapshot = {
  id: string;
  state: ReviewJobState;
  stage: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  observedAt: string;
  steps: ReviewStepSnapshot[];
};

export type ReviewTone = "active" | "warning" | "success" | "danger";
export type ReviewProgressStatus = "complete" | "current" | "pending";

export const terminalReviewStates = new Set<ReviewJobState>([
  "CANCELLED",
  "SUCCEEDED",
  "INCOMPLETE",
  "FAILED",
]);

const queuedWarningMs = 2 * 60 * 1000;
const runningWarningMs = 5 * 60 * 1000;

function timestamp(value: string | null) {
  return value ? new Date(value).getTime() : 0;
}

export function reviewLastChangedAt(job: ReviewJobSnapshot): string {
  const values = [
    job.createdAt,
    job.startedAt,
    job.finishedAt,
    ...job.steps.map((step) => step.updatedAt),
  ].filter((value): value is string => Boolean(value));
  return values.reduce((latest, value) =>
    timestamp(value) > timestamp(latest) ? value : latest,
  );
}

export function humanizeReviewRole(role: string): string {
  if (role === "MAP_LEARNING_SURFACES")
    return "Mapping connected learning surfaces";
  const blindCritic = /^BLIND_CRITIC_(\d+)$/u.exec(role);
  if (blindCritic) return `Independent critique ${blindCritic[1]} of 7`;
  const rebuttal = /^REBUTTAL_(\d+)$/u.exec(role);
  if (rebuttal) return `Response to critique ${rebuttal[1]} of 7`;
  const labels: Readonly<Record<string, string>> = {
    ADJUDICATOR: "Reconciling reviewer disagreements",
    TEACHING_DESIGNER: "Checking the teaching design",
    BUNDLE_WRITER: "Writing the candidate bundle",
    SEMANTIC_AUDITOR: "Auditing meaning and consistency",
    TEACHING_ALIGNMENT_AUDITOR: "Checking teaching alignment",
    REPOSITORY_INTEGRITY_AUDITOR: "Checking repository integrity",
    REPOSITORY_VALIDATION: "Running final repository validation",
  };
  return (
    labels[role] ??
    role
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/^./u, (character) => character.toUpperCase())
  );
}

export function reviewCompletedCount(job: ReviewJobSnapshot): number {
  const succeeded = new Set(
    job.steps
      .filter((step) => step.state === "SUCCEEDED")
      .map((step) => step.role),
  );
  return workflowRoles.filter((role) => succeeded.has(role)).length;
}

export function reviewCurrentStage(job: ReviewJobSnapshot): string {
  const running = job.steps.find((step) => step.state === "RUNNING");
  if (running) return humanizeReviewRole(running.role);
  const stagedRole = /^\d+ of \d+: (.+)$/u.exec(job.stage)?.[1];
  if (stagedRole)
    return humanizeReviewRole(stagedRole.toUpperCase().replaceAll(" ", "_"));
  return job.stage;
}

function durationLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 10) return "a few seconds";
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function reviewProgressSteps(job: ReviewJobSnapshot): Array<{
  key: "accepted" | "worker" | "review" | "candidate";
  label: string;
  description: string;
  status: ReviewProgressStatus;
}> {
  const terminal = terminalReviewStates.has(job.state);
  const started = Boolean(job.startedAt) || reviewCompletedCount(job) > 0;
  const succeeded = job.state === "SUCCEEDED";
  const stoppedWithoutCandidate = terminal && !succeeded;
  return [
    {
      key: "accepted",
      label: "Request accepted",
      description: "The saved draft and exact review input are recorded.",
      status: "complete",
    },
    {
      key: "worker",
      label: started ? "Review worker started" : "Waiting for a review worker",
      description: started
        ? "A worker has claimed the durable review job."
        : "The job is queued safely; clicking again is unnecessary.",
      status: started
        ? "complete"
        : stoppedWithoutCandidate
          ? "pending"
          : "current",
    },
    {
      key: "review",
      label: `Complete review · ${reviewCompletedCount(job)}/${workflowRoles.length}`,
      description:
        job.state === "RUNNING"
          ? reviewCurrentStage(job)
          : succeeded
            ? "Every review and validation step completed."
            : stoppedWithoutCandidate
              ? "The review stopped before all steps completed."
              : "The complete review begins when a worker is available.",
      status: succeeded
        ? "complete"
        : job.state === "RUNNING" || reviewCompletedCount(job) > 0
          ? "current"
          : "pending",
    },
    {
      key: "candidate",
      label: succeeded ? "Candidate ready for you" : "Return candidate to you",
      description: succeeded
        ? "The exact candidate is ready for human review."
        : stoppedWithoutCandidate
          ? "No candidate was produced; your draft will be returned for editing."
          : "When complete, this page will automatically show the candidate.",
      status: succeeded ? "complete" : "pending",
    },
  ];
}

export function reviewPresentation(job: ReviewJobSnapshot, now: Date) {
  const completed = reviewCompletedCount(job);
  const total = workflowRoles.length;
  const lastChangedAt = reviewLastChangedAt(job);
  const quietForMs = Math.max(0, now.getTime() - timestamp(lastChangedAt));
  const queuedForMs = Math.max(0, now.getTime() - timestamp(job.createdAt));
  const runningLong = job.state === "RUNNING" && quietForMs >= runningWarningMs;
  const queuedLong = job.state === "QUEUED" && queuedForMs >= queuedWarningMs;

  if (job.state === "SUCCEEDED")
    return {
      tone: "success" as const,
      eyebrow: "Complete review finished",
      title: "Candidate ready for your review",
      detail: `All ${total} review and validation steps completed. This page is loading the exact candidate now.`,
      action: "No further action is required until the candidate appears.",
      completed,
      total,
      lastChangedAt,
      timing: `Finished after ${durationLabel(timestamp(job.finishedAt) - timestamp(job.createdAt))}.`,
    };
  if (job.state === "FAILED" || job.state === "INCOMPLETE")
    return {
      tone: "danger" as const,
      eyebrow: "Complete review stopped",
      title:
        job.state === "FAILED"
          ? "The review failed"
          : "The review is incomplete",
      detail:
        job.state === "FAILED"
          ? "No candidate was published. Your saved draft remains intact and will be returned for editing."
          : "The workflow could not produce a complete candidate. Your saved draft remains intact.",
      action: "Open Review jobs for the recorded stage and available actions.",
      completed,
      total,
      lastChangedAt,
      timing: `Stopped after ${durationLabel(timestamp(job.finishedAt) - timestamp(job.createdAt))}.`,
    };
  if (job.state === "CANCELLED" || job.state === "CANCELLING")
    return {
      tone: "warning" as const,
      eyebrow: "Complete review",
      title:
        job.state === "CANCELLING" ? "Stopping the review" : "Review cancelled",
      detail:
        job.state === "CANCELLING"
          ? "The active provider attempt is being stopped safely."
          : "No candidate was published. Your saved draft is being returned for editing.",
      action: "This page will update when checkout custody has returned.",
      completed,
      total,
      lastChangedAt,
      timing: `Last progress ${durationLabel(quietForMs)} ago.`,
    };
  if (job.state === "WAITING_CAPACITY" || job.state === "RETRY_SCHEDULED")
    return {
      tone: "warning" as const,
      eyebrow: "Complete review paused safely",
      title:
        job.state === "WAITING_CAPACITY"
          ? "Waiting for AI capacity"
          : "A retry is scheduled",
      detail:
        "The durable job and completed steps are saved. It will continue without another click.",
      action: "You can leave this page; live progress resumes automatically.",
      completed,
      total,
      lastChangedAt,
      timing: `Last progress ${durationLabel(quietForMs)} ago.`,
    };
  if (queuedLong)
    return {
      tone: "warning" as const,
      eyebrow: "Complete review queued",
      title: "Still waiting for a review worker",
      detail: `The request is safe and queued, but no worker has claimed it after ${durationLabel(queuedForMs)}.`,
      action:
        "Do not click again. You may leave this page or open Review jobs to cancel it.",
      completed,
      total,
      lastChangedAt,
      timing: `Queued for ${durationLabel(queuedForMs)}.`,
    };
  if (job.state === "QUEUED")
    return {
      tone: "active" as const,
      eyebrow: "Complete review queued",
      title: "Request accepted — waiting for a review worker",
      detail:
        "Your saved draft is protected and the published guidance remains live while the job waits.",
      action: "No action is needed. This page updates automatically.",
      completed,
      total,
      lastChangedAt,
      timing: `Queued ${durationLabel(queuedForMs)} ago.`,
    };
  return {
    tone: runningLong ? ("warning" as const) : ("active" as const),
    eyebrow: runningLong
      ? "Complete review taking longer than expected"
      : "Complete review in progress",
    title: reviewCurrentStage(job),
    detail: runningLong
      ? `The job is still active, but no new step has been recorded for ${durationLabel(quietForMs)}.`
      : `${completed} of ${total} review and validation steps are complete.`,
    action: runningLong
      ? "You do not need to restart it. Open Review jobs if you want to cancel."
      : "You can leave this page; the durable job will continue.",
    completed,
    total,
    lastChangedAt,
    timing: `Last progress ${durationLabel(quietForMs)} ago.`,
  };
}
