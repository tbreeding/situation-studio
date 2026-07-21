"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  parsePublicationActivity,
  parsePublicationStreamStatus,
  type PublicationStreamStatus,
} from "@/lib/publication-events";
import {
  publicationActivityLabel,
  publicationLiveStage,
  publicationProgressSteps,
  shouldPollPublication,
} from "@/lib/publication-presentation";

type ConnectionState = "connecting" | "live" | "reconnecting" | "complete";

type Activity = {
  id: string;
  label: string;
  createdAt: string;
};

const refreshStates = new Set([
  "RECONCILED",
  "FAILED_PREVIEW",
  "AUTO_ROLLED_BACK",
  "RECONCILIATION_REQUIRED",
]);

type Props = {
  publicationBackend: "git" | "database";
  confirmationSubmitted: boolean;
  publishedBaseline: string | null;
  request: {
    id: string;
    state: string;
    currentStep: string;
    previewCommitSha: string | null;
    finalConfirmed: boolean;
  };
};

function elapsedLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function durationLabel(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 5) return "just started";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

function connectionCopy(connection: ConnectionState) {
  if (connection === "live") return "Live updates connected";
  if (connection === "reconnecting")
    return "Live updates reconnecting · safe refresh fallback active";
  if (connection === "complete") return "Live publication complete";
  return "Connecting to live publisher status";
}

export function PublicationLiveProgress(props: Props) {
  const router = useRouter();
  const shouldStream = shouldPollPublication(
    props.request.state,
    props.request.finalConfirmed,
    props.confirmationSubmitted,
  );
  const [connection, setConnection] = useState<ConnectionState>(
    shouldStream ? "connecting" : "complete",
  );
  const [liveStatus, setLiveStatus] = useState<PublicationStreamStatus | null>(
    null,
  );
  const [activities, setActivities] = useState<Activity[]>([]);
  const [lastContactAt, setLastContactAt] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldStream) return;
    const clockTimer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(clockTimer);
  }, [shouldStream]);

  useEffect(() => {
    if (!shouldStream) return;
    const source = new EventSource(
      `/api/publications/${props.request.id}/events`,
    );
    let fallback: number | null = null;
    let refreshTimer: number | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        router.refresh();
      }, 150);
    };
    const applyStatus = (status: PublicationStreamStatus | null) => {
      if (!status) return;
      setLiveStatus(status);
      setLastContactAt(Date.now());
      if (refreshStates.has(status.state)) scheduleRefresh();
    };
    const receiveStatus = (event: Event) => {
      applyStatus(
        parsePublicationStreamStatus((event as MessageEvent<string>).data),
      );
    };
    const pollFallback = async () => {
      try {
        const response = await fetch(
          `/api/publications/${props.request.id}/events?snapshot=1`,
          { cache: "no-store" },
        );
        if (!response.ok) return;
        applyStatus(parsePublicationStreamStatus(await response.text()));
      } catch {
        /* EventSource will continue its own reconnect attempts. */
      }
    };
    source.onopen = () => {
      setConnection("live");
      setLastContactAt(Date.now());
      if (fallback !== null) {
        window.clearInterval(fallback);
        fallback = null;
      }
    };
    source.addEventListener("status", receiveStatus);
    source.addEventListener("heartbeat", receiveStatus);
    source.addEventListener("publication", (event) => {
      const message = event as MessageEvent<string>;
      const activity = parsePublicationActivity(message.data);
      setLastContactAt(Date.now());
      if (activity) {
        const item = {
          id: message.lastEventId || `${activity.type}:${activity.createdAt}`,
          label: publicationActivityLabel(activity.type),
          createdAt: activity.createdAt,
        };
        setActivities((current) => {
          const withoutDuplicate = current.filter(
            (existing) => existing.id !== item.id,
          );
          return [...withoutDuplicate, item]
            .sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt),
            )
            .slice(-4);
        });
      }
    });
    source.onerror = () => {
      setConnection("reconnecting");
      void pollFallback();
      fallback ??= window.setInterval(() => void pollFallback(), 2_500);
    };
    return () => {
      source.close();
      if (fallback !== null) window.clearInterval(fallback);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [
    props.request.currentStep,
    props.request.finalConfirmed,
    props.request.id,
    props.request.state,
    router,
    shouldStream,
  ]);

  const state = liveStatus?.state ?? props.request.state;
  const finalConfirmed =
    liveStatus?.finalConfirmed ?? props.request.finalConfirmed;
  const progressSteps = publicationProgressSteps(
    state,
    finalConfirmed,
    props.confirmationSubmitted,
    props.publicationBackend,
  );
  const currentStage = publicationLiveStage(state, props.publicationBackend);
  const completed = state === "RECONCILED";
  const stageStartedAt = liveStatus
    ? new Date(liveStatus.updatedAt).getTime()
    : null;

  return (
    <section
      className={`publicationDecisionCard ${completed ? "success" : "publishing"}`}
      aria-labelledby="publication-progress-title"
    >
      <header className="publicationLiveHeader">
        <div className="publicationDecisionCopy">
          <p className="eyebrow">
            {completed
              ? "Final publication complete"
              : "Final publication in progress"}
          </p>
          <h3 id="publication-progress-title">
            {completed ? "Published" : "Publishing"} exact candidate{" "}
            {props.request.previewCommitSha?.slice(0, 8)}
          </h3>
          <p>
            {completed
              ? "The exact candidate is official and publisher custody is released."
              : "Confirmation is recorded. Publication continues safely on the server even if you leave this page."}
          </p>
        </div>
        <div
          className={`publicationLiveConnection ${connection}`}
          data-testid="publication-live-connection"
        >
          <span aria-hidden="true" />
          <div>
            <strong>
              {connectionCopy(completed ? "complete" : connection)}
            </strong>
            <small>
              {lastContactAt === null
                ? "Opening the event stream…"
                : `Last server contact ${elapsedLabel(clock - lastContactAt)}`}
            </small>
          </div>
        </div>
      </header>

      <div
        className="publicationLiveNow"
        data-testid="publication-live-stage"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <span aria-hidden="true">{completed ? "✓" : "↻"}</span>
        <div>
          <small>Current activity</small>
          <strong>{currentStage.label}</strong>
          <p>{currentStage.detail}</p>
          {!completed && stageStartedAt !== null && (
            <small>
              Current stage running for {durationLabel(clock - stageStartedAt)}.
            </small>
          )}
        </div>
      </div>

      <ol className="publicationProgress">
        {progressSteps.map((step, index) => (
          <li className={step.status} key={step.key}>
            <span aria-hidden="true">
              {step.status === "complete" ? "✓" : index + 1}
            </span>
            <div>
              <strong>{step.label}</strong>
              <small>{step.description}</small>
            </div>
          </li>
        ))}
      </ol>

      {activities.length > 0 && (
        <div className="publicationLiveActivity">
          <strong>Recent publisher activity</strong>
          <ol>
            {activities.map((activity) => (
              <li key={activity.id}>
                <span aria-hidden="true">✓</span>
                <span>{activity.label}</span>
                <time dateTime={activity.createdAt}>
                  {new Date(activity.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </time>
              </li>
            ))}
          </ol>
        </div>
      )}

      <p className="publicationProgressFootnote">
        Previous official baseline{" "}
        <code>{props.publishedBaseline?.slice(0, 8) ?? "unavailable"}</code>{" "}
        remains recoverable until reconciliation completes.
      </p>
    </section>
  );
}
