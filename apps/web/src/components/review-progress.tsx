"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  reviewPresentation,
  reviewProgressSteps,
  terminalReviewStates,
  type ReviewJobSnapshot,
} from "@/lib/review-presentation";

export function ReviewProgress({
  initialJob,
}: {
  initialJob: ReviewJobSnapshot;
}) {
  const router = useRouter();
  const [job, setJob] = useState(initialJob);
  const [now, setNow] = useState(initialJob.observedAt);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "reconnecting" | "complete"
  >("connecting");
  const terminalRefreshRequested = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(new Date().toISOString()),
      10_000,
    );
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (terminalReviewStates.has(job.state)) {
      if (terminalRefreshRequested.current) return;
      terminalRefreshRequested.current = true;
      const refresh = window.setTimeout(() => router.refresh(), 700);
      return () => window.clearTimeout(refresh);
    }
    const source = new EventSource(`/api/jobs/${job.id}/events`);
    let fallback: number | null = null;
    source.onopen = () => {
      setConnection("live");
      if (fallback) {
        window.clearTimeout(fallback);
        fallback = null;
      }
    };
    source.addEventListener("progress", (event) => {
      try {
        const next = JSON.parse(event.data) as ReviewJobSnapshot;
        if (next.id !== job.id) return;
        setJob(next);
        setNow(next.observedAt);
        setConnection(
          terminalReviewStates.has(next.state) ? "complete" : "live",
        );
        if (terminalReviewStates.has(next.state)) source.close();
      } catch {
        setConnection("reconnecting");
      }
    });
    source.onerror = () => {
      setConnection("reconnecting");
      if (!fallback)
        fallback = window.setTimeout(() => router.refresh(), 10_000);
    };
    return () => {
      source.close();
      if (fallback) {
        window.clearTimeout(fallback);
        fallback = null;
      }
    };
  }, [job.id, job.state, router]);

  const presentation = useMemo(
    () => reviewPresentation(job, new Date(now)),
    [job, now],
  );
  const steps = reviewProgressSteps(job);
  const displayedConnection = terminalReviewStates.has(job.state)
    ? "complete"
    : connection;
  const connectionLabel =
    displayedConnection === "live"
      ? "Live updates connected"
      : displayedConnection === "reconnecting"
        ? "Reconnecting live updates"
        : displayedConnection === "complete"
          ? "Final update received"
          : "Connecting live updates";

  return (
    <section
      aria-labelledby="review-progress-title"
      className={`reviewProgressCard ${presentation.tone}`}
    >
      <header className="reviewProgressHeader">
        <div>
          <p className="eyebrow">{presentation.eyebrow}</p>
          <h2 id="review-progress-title">{presentation.title}</h2>
        </div>
        <span className={`liveState ${displayedConnection}`} role="status">
          <span aria-hidden="true" />
          {connectionLabel}
        </span>
      </header>
      <p className="reviewProgressDetail">{presentation.detail}</p>
      <div className="reviewProgressMeter">
        <div>
          <strong>
            {presentation.completed} of {presentation.total} steps complete
          </strong>
          <span>{presentation.timing}</span>
        </div>
        <progress
          aria-label="Complete review progress"
          max={presentation.total}
          value={presentation.completed}
        />
      </div>
      <ol className="reviewProgressSteps">
        {steps.map((step, index) => (
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
      <footer className="reviewProgressFooter">
        <p>
          <strong>What you should do:</strong> {presentation.action}
        </p>
        <p>
          The official published guidance remains live. Only this saved draft is
          locked while the review job has custody.
        </p>
        <Link href="/jobs">Open Review jobs</Link>
      </footer>
    </section>
  );
}
