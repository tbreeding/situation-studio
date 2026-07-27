"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  AgentRevisionReview,
  type ReviewProposalView,
} from "@/components/agent-revision-review";
import { RenderedGuidance } from "@/components/rendered-guidance";
import { RenderedComparison } from "@/components/rendered-comparison";
import { formattedRetryTime } from "@/components/review-retry-status";
import { SynchronizedDiff } from "@/components/synchronized-diff";
import {
  WORKSPACE_TABS,
  workspaceTabPath,
  type WorkspaceTab,
} from "@/components/workspace-tabs";
import {
  initialLiveReviewState,
  nextReviewAnnouncement,
  reduceLiveReviewState,
  retryCountdown,
  reviewProgressText,
  SAFE_REVIEW_FAILURE_LABELS,
  terminalRefreshDelay,
  type ReviewAnnouncementState,
} from "@/review-status-client";
import {
  isActiveReviewState,
  isTerminalReviewState,
  reviewStatusSnapshotSchema,
  REVIEW_STATUS_EVENT_NAME,
  type ReviewStatusSnapshot,
} from "@/review-status-contract";

type Metadata = {
  slug: string;
  title: string;
  description: string;
  stakes: string;
  primarySkill: string;
  preparationTime: "5 minutes" | "15 minutes" | "30 minutes";
  emotionalLoad: "low" | "medium" | "high";
  pattern: "first-occurrence" | "emerging-pattern" | "repeated-pattern";
  scope: "individual" | "pair" | "team";
  tags: string[];
  audience: Array<"manager" | "technical-lead">;
  support: Array<"hr" | "legal" | "safety" | "security" | "senior-leader">;
  published: string;
  lastReviewed: string;
  author: string;
  reviewer: string;
  socialHook: string;
  campaignCluster: string;
};

type Bundle = {
  schemaVersion: "situation-bundle-v1";
  contractVersion: string;
  validationPolicyVersion: string;
  situationId: string;
  visibility: "PUBLIC" | "RETIRED" | "UNPUBLISHED";
  metadata: Metadata;
  bodyHash: string;
  artifacts: unknown[];
  relationships: Array<{
    kind: string;
    logicalId: string;
    position: number;
    contentHash: string;
    visibility: string;
  }>;
  promotion: Record<string, unknown>;
  contextHashes: string[];
};

type HistoryItem = {
  id: string;
  bundleHash: string;
  productionAt: string;
  sourceKind: string;
  releaseId: string;
  manifestHash: string;
  changeSummary: string;
  editorNote: string | null;
  body: string;
};

type Review = {
  id: string;
  queuedAt: string;
  status: ReviewStatusSnapshot;
  inputRevisionId: string;
  currentRevisionId: string | null;
  inputBundleHash: string;
  inputBody: string;
  proposal: ReviewProposalView | null;
};

type Publication = {
  state: string;
};

type ContextItem = {
  logicalId: string;
  kind: string;
  visibility: string;
  contentHash: string;
  sharingCount: number;
  hasVariant: boolean;
};

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalText(value: string) {
  return `${value.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "")}\n`;
}

function serializeSections(names: string[], sections: Record<string, string>) {
  return canonicalText(
    names
      .map((name) => `## ${name}\n\n${(sections[name] ?? "").trim()}`)
      .join("\n\n"),
  );
}

function parseSections(names: string[], body: string) {
  const normalized = canonicalText(body);
  const matches = [...normalized.matchAll(/^##[ \t]+(.+?)[ \t]*$/gmu)];
  const parsed: Record<string, string> = {};
  matches.forEach((match, index) => {
    const name = match[1]?.trim() ?? "";
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    parsed[name] = normalized.slice(start, end).trim();
  });
  if (names.some((name) => !(name in parsed)))
    throw new Error(
      "Raw MDX is missing one or more required section headings.",
    );
  return Object.fromEntries(names.map((name) => [name, parsed[name] ?? ""]));
}

function shortHash(value: string | null) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "Not published";
}

export function WorkspaceEditor({
  initialTab,
  situation,
  initialBundle,
  initialSections,
  initialBody,
  productionBody,
  sectionNames,
  checkout,
  currentUserId,
  csrfToken,
  review,
  publication,
  history,
  context,
}: {
  initialTab: WorkspaceTab;
  situation: {
    id: string;
    slug: string;
    title: string;
    visibility: string;
    productionBundleHash: string | null;
  };
  initialBundle: Bundle;
  initialSections: Record<string, string>;
  initialBody: string;
  productionBody: string;
  sectionNames: string[];
  checkout: null | {
    id: string;
    fence: string;
    holderId: string;
    holderName: string;
  };
  currentUserId: string;
  csrfToken: string;
  review: Review | null;
  publication: Publication | null;
  history: HistoryItem[];
  context: ContextItem[];
}) {
  const router = useRouter();
  const serverReviewSnapshot = review?.status ?? null;
  const [liveReview, dispatchLiveReview] = useReducer(
    reduceLiveReviewState,
    serverReviewSnapshot,
    initialLiveReviewState,
  );
  const reviewStatus =
    liveReview.reviewJobId === review?.id
      ? (liveReview.snapshot ?? serverReviewSnapshot)
      : serverReviewSnapshot;
  const mine = checkout?.holderId === currentUserId;
  const reviewLocked = reviewStatus
    ? isActiveReviewState(reviewStatus.state)
    : false;
  const publicationLocked = Boolean(
    publication &&
    ["REQUESTED", "ASSEMBLING", "PROMOTING", "VERIFYING"].includes(
      publication.state,
    ),
  );
  const workspaceLocked = reviewLocked || publicationLocked;
  const editable = Boolean(mine && !workspaceLocked);
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [bundle, setBundle] = useState(initialBundle);
  const [sections, setSections] = useState(initialSections);
  const [rawBody, setRawBody] = useState(initialBody);
  const [rawMode, setRawMode] = useState(false);
  const [saveState, setSaveState] = useState<
    "saved" | "dirty" | "saving" | "error"
  >("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [proposalPending, setProposalPending] = useState(false);
  const [pending, startTransition] = useTransition();
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [comparedHistoryId, setComparedHistoryId] = useState<string | null>(
    null,
  );
  const dirtyVersion = useRef(0);
  const savedVersion = useRef(0);
  const submitButton = useRef<HTMLButtonElement>(null);
  const submitDialog = useRef<HTMLDivElement>(null);
  const reviewConnectionGeneration = useRef(0);
  const refreshedTerminalSnapshot = useRef<string | null>(
    serverReviewSnapshot && isTerminalReviewState(serverReviewSnapshot.state)
      ? serverReviewSnapshot.snapshotId
      : null,
  );
  const previousAnnouncedSnapshot = useRef<ReviewStatusSnapshot | null>(null);
  const announcementState = useRef<ReviewAnnouncementState>({
    message: "",
    lastAnnouncedAt: Number.NEGATIVE_INFINITY,
    snapshotId: null,
  });
  const [reviewAnnouncement, setReviewAnnouncement] = useState("");
  const [reviewClock, setReviewClock] = useState(() => Date.now());

  useEffect(() => {
    const generation = ++reviewConnectionGeneration.current;
    if (
      !serverReviewSnapshot ||
      !isActiveReviewState(serverReviewSnapshot.state)
    ) {
      dispatchLiveReview({
        type: "sync",
        generation,
        snapshot: serverReviewSnapshot,
      });
      return;
    }

    const reviewJobId = serverReviewSnapshot.reviewJobId;
    dispatchLiveReview({
      type: "start",
      reviewJobId,
      generation,
      snapshot: serverReviewSnapshot,
    });
    const source = new EventSource(`/api/reviews/${reviewJobId}/events`);
    source.onopen = () =>
      dispatchLiveReview({ type: "open", reviewJobId, generation });
    source.onerror = () =>
      dispatchLiveReview({
        type: "connection-error",
        reviewJobId,
        generation,
      });
    const receiveSnapshot = (rawEvent: Event) => {
      const event = rawEvent as MessageEvent<string>;
      try {
        const snapshot = reviewStatusSnapshotSchema.parse(
          JSON.parse(event.data) as unknown,
        );
        dispatchLiveReview({
          type: "snapshot",
          reviewJobId,
          generation,
          snapshot,
        });
        if (isTerminalReviewState(snapshot.state)) source.close();
      } catch {
        // The durable snapshot is recovered by the next valid event or native
        // EventSource reconnection; malformed public input is never rendered.
      }
    };
    source.addEventListener(REVIEW_STATUS_EVENT_NAME, receiveSnapshot);
    return () => {
      source.removeEventListener(REVIEW_STATUS_EVENT_NAME, receiveSnapshot);
      source.close();
    };
  }, [serverReviewSnapshot]);

  useEffect(() => {
    if (!reviewStatus) return;
    const nextAnnouncement = nextReviewAnnouncement(
      announcementState.current,
      previousAnnouncedSnapshot.current,
      reviewStatus,
      Date.now(),
    );
    previousAnnouncedSnapshot.current = reviewStatus;
    if (nextAnnouncement.message !== announcementState.current.message)
      setReviewAnnouncement(nextAnnouncement.message);
    announcementState.current = nextAnnouncement;
  }, [reviewStatus]);

  useEffect(() => {
    const scheduledAt = reviewStatus?.retry?.scheduledAt;
    if (!scheduledAt) return;
    const timer = window.setInterval(() => setReviewClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [reviewStatus?.retry?.scheduledAt]);

  useEffect(() => {
    if (!reviewStatus || !isTerminalReviewState(reviewStatus.state)) {
      refreshedTerminalSnapshot.current = null;
      return;
    }
    if (refreshedTerminalSnapshot.current === reviewStatus.snapshotId) return;
    refreshedTerminalSnapshot.current = reviewStatus.snapshotId;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const delay = terminalRefreshDelay(reviewStatus, reducedMotion) ?? 0;
    const timer = window.setTimeout(() => router.refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [reviewStatus, router]);

  const body = useMemo(
    () =>
      rawMode
        ? canonicalText(rawBody)
        : serializeSections(sectionNames, sections),
    [rawBody, rawMode, sectionNames, sections],
  );

  function markDirty() {
    dirtyVersion.current += 1;
    setSaveState("dirty");
  }

  const save = useCallback(
    async (namedCheckpoint = "Autosave") => {
      if (
        !checkout ||
        !editable ||
        savedVersion.current === dirtyVersion.current
      )
        return true;
      const version = dirtyVersion.current;
      setSaveState("saving");
      const bodyHash = await sha256(body);
      const nextBundle = { ...bundle, bodyHash };
      const response = await fetch(`/api/checkouts/${checkout.id}/save`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          fence: checkout.fence,
          bundle: nextBundle,
          body,
          namedCheckpoint,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        setSaveState("error");
        setMessage(payload.error ?? "The draft could not be saved.");
        return false;
      }
      savedVersion.current = version;
      setBundle(nextBundle);
      setSaveState(version === dirtyVersion.current ? "saved" : "dirty");
      return true;
    },
    [body, bundle, checkout, csrfToken, editable],
  );

  useEffect(() => {
    if (saveState !== "dirty" || !editable) return;
    const timer = window.setTimeout(() => void save(), 900);
    return () => window.clearTimeout(timer);
  }, [editable, save, saveState]);

  useEffect(() => {
    if (!confirmSubmit) return;
    const root = submitDialog.current?.closest("main");
    const background = root
      ? [...root.children].filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement &&
            !element.contains(submitDialog.current),
        )
      : [];
    for (const element of background) element.inert = true;
    submitDialog.current
      ?.querySelector<HTMLButtonElement>("button:not([disabled])")
      ?.focus();
    return () => {
      for (const element of background) element.inert = false;
    };
  }, [confirmSubmit]);

  function closeSubmitDialog() {
    setConfirmSubmit(false);
    requestAnimationFrame(() => submitButton.current?.focus());
  }

  function handleSubmitDialogKeyDown(
    event: React.KeyboardEvent<HTMLDivElement>,
  ) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSubmitDialog();
      return;
    }
    if (event.key !== "Tab" || !submitDialog.current) return;
    const controls = [
      ...submitDialog.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function mutate(
    url: string,
    payload: Record<string, unknown> = {},
    options: { saveFirst?: boolean; redirectHome?: boolean } = {},
  ) {
    setMessage(null);
    if (options.saveFirst && !(await save("Action checkpoint"))) return;
    startTransition(async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(result.error ?? "The action could not be completed.");
        return;
      }
      if (options.redirectHome) router.push("/");
      router.refresh();
    });
  }

  function updateMetadata<K extends keyof Metadata>(
    key: K,
    value: Metadata[K],
  ) {
    setBundle((current) => ({
      ...current,
      metadata: { ...current.metadata, [key]: value },
    }));
    markDirty();
  }

  async function proposalRequest(
    url: string,
    method: "POST" | "PATCH",
    payload: Record<string, unknown>,
  ) {
    if (!checkout) return false;
    setMessage(null);
    setProposalPending(true);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) {
        setMessage(result.error ?? "The agent suggestion could not be saved.");
        return false;
      }
      router.refresh();
      return true;
    } finally {
      setProposalPending(false);
    }
  }

  function selectTab(next: WorkspaceTab) {
    setTab(next);
    window.history.replaceState(
      window.history.state,
      "",
      workspaceTabPath(window.location.href, next),
    );
  }

  function handleTabKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: WorkspaceTab,
  ) {
    const index = WORKSPACE_TABS.indexOf(current);
    const next =
      event.key === "Home"
        ? WORKSPACE_TABS[0]
        : event.key === "End"
          ? WORKSPACE_TABS.at(-1)
          : event.key === "ArrowRight"
            ? WORKSPACE_TABS[(index + 1) % WORKSPACE_TABS.length]
            : event.key === "ArrowLeft"
              ? WORKSPACE_TABS[
                  (index - 1 + WORKSPACE_TABS.length) % WORKSPACE_TABS.length
                ]
              : undefined;
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    requestAnimationFrame(() =>
      document.querySelector<HTMLButtonElement>(`#tab-${next}`)?.focus(),
    );
  }

  const changedSections = sectionNames.filter((name) => {
    const marker = `## ${name}`;
    const current = body.split(marker)[1]?.split(/^## /mu)[0]?.trim() ?? "";
    const production =
      productionBody.split(marker)[1]?.split(/^## /mu)[0]?.trim() ?? "";
    return current !== production;
  });

  return (
    <main className="workspacePage">
      <span className="srOnly" aria-live="polite" aria-atomic="true">
        {reviewAnnouncement}
      </span>
      <header className="workspaceHeader">
        <div className="workspaceTitle">
          <Link className="backLink" href="/">
            ← All situations
          </Link>
          <p className="eyebrow">Situation workspace</p>
          <h1>{bundle.metadata.title}</h1>
          <div className="workspaceMeta">
            <span>{situation.slug}</span>
            <span className={`statusPill ${mine ? "status-checked" : ""}`}>
              <i aria-hidden="true" />
              {checkout
                ? mine
                  ? "Checked out to you"
                  : `Checked out by ${checkout.holderName}`
                : situation.visibility === "RETIRED"
                  ? "Retired"
                  : "Available"}
            </span>
            {reviewLocked ? (
              <span className="activityLabel">
                {reviewStatus?.retry
                  ? `Review retrying · ${reviewStatus.currentStage?.displayName ?? "current stage"}`
                  : `Review ${reviewStatus?.state.toLowerCase()}`}
              </span>
            ) : null}
            {publicationLocked ? (
              <span className="activityLabel">Publishing</span>
            ) : null}
          </div>
        </div>
        <div className="workspaceActions">
          {message ? (
            <span className="actionError" role="alert">
              {message}
            </span>
          ) : null}
          {mine && checkout ? (
            <>
              <span className={`saveState save-${saveState}`} role="status">
                <i aria-hidden="true" />
                {saveState === "saving"
                  ? "Saving…"
                  : saveState === "dirty"
                    ? "Unsaved changes"
                    : saveState === "error"
                      ? "Save failed"
                      : "All changes saved"}
              </span>
              <button
                className="secondaryButton"
                type="button"
                disabled={pending || workspaceLocked}
                onClick={() =>
                  void mutate(
                    `/api/checkouts/${checkout.id}/check-in`,
                    { fence: checkout.fence },
                    { saveFirst: true, redirectHome: true },
                  )
                }
              >
                Check in
              </button>
              {reviewLocked && review ? (
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    void mutate(`/api/reviews/${review.id}/cancel`)
                  }
                >
                  Cancel review
                </button>
              ) : review && reviewStatus?.state === "FAILED" ? (
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={pending || publicationLocked}
                  onClick={() => void mutate(`/api/reviews/${review.id}/retry`)}
                >
                  Retry review
                </button>
              ) : (
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={pending || publicationLocked}
                  onClick={() =>
                    void mutate(
                      `/api/checkouts/${checkout.id}/review`,
                      { fence: checkout.fence },
                      { saveFirst: true },
                    )
                  }
                >
                  Run agent review
                </button>
              )}
              {situation.productionBundleHash &&
              bundle.visibility !== "RETIRED" &&
              !workspaceLocked ? (
                <button
                  className="textButton dangerText"
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Create a retirement draft? Production will not change until you submit it.",
                      )
                    )
                      void mutate(
                        `/api/checkouts/${checkout.id}/retire`,
                        { fence: checkout.fence },
                        { saveFirst: true },
                      );
                  }}
                >
                  Retire
                </button>
              ) : null}
              {situation.visibility === "RETIRED" &&
              bundle.visibility === "RETIRED" &&
              !workspaceLocked ? (
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setBundle((current) => ({
                      ...current,
                      visibility: "PUBLIC",
                    }));
                    markDirty();
                  }}
                >
                  Restore to public
                </button>
              ) : null}
              {situation.productionBundleHash && !workspaceLocked ? (
                <button
                  className="textButton"
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Archive this draft and start again from exact current production?",
                      )
                    )
                      void mutate(`/api/checkouts/${checkout.id}/start-over`, {
                        fence: checkout.fence,
                      });
                  }}
                >
                  Start over
                </button>
              ) : null}
              <button
                ref={submitButton}
                className="primaryButton"
                type="button"
                disabled={pending || workspaceLocked || saveState === "error"}
                onClick={() => setConfirmSubmit(true)}
              >
                Submit to production
              </button>
            </>
          ) : checkout ? (
            <span className="ownerNotice">
              Only {checkout.holderName} can change this situation.
            </span>
          ) : (
            <button
              className="primaryButton"
              type="button"
              disabled={pending}
              onClick={() =>
                void mutate(`/api/situations/${situation.id}/checkout`)
              }
            >
              Check out
            </button>
          )}
        </div>
      </header>

      <nav
        className="workspaceTabs"
        aria-label="Situation workspace"
        role="tablist"
      >
        {(
          [
            ["edit", "Edit"],
            ["review", "Review"],
            ["history", `History ${history.length}`],
            ["context", `Context ${context.length}`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            id={`tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            className={tab === value ? "active" : undefined}
            onClick={() => selectTab(value)}
            onKeyDown={(event) => handleTabKeyDown(event, value)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "edit" ? (
        <section
          id="panel-edit"
          className="workspacePanel editPanel"
          role="tabpanel"
          aria-labelledby="tab-edit"
          tabIndex={-1}
        >
          {!mine ? (
            <div className="readOnlyBanner">
              <strong>Inspection mode.</strong>{" "}
              {checkout
                ? `${checkout.holderName} owns the durable checkout.`
                : "Check out this situation to edit it."}
            </div>
          ) : publicationLocked ? (
            <div className="readOnlyBanner">
              <strong>Publication in progress.</strong> This workspace remains
              read-only until Leadership verification completes.
            </div>
          ) : reviewLocked ? (
            <div className="readOnlyBanner">
              <strong>
                {reviewStatus?.retry
                  ? `Review retrying ${reviewStatus.currentStage?.displayName ?? "the current stage"}.`
                  : "Draft pinned for review."}
              </strong>{" "}
              Editing returns when the job finishes or is cancelled. Review
              continues safely on the server.
            </div>
          ) : null}
          <div className="editColumn">
            <section className="editorCard metadataCard">
              <header>
                <div>
                  <p className="cardEyebrow">Structured metadata</p>
                  <h2>Editorial framing</h2>
                </div>
                <span>Required</span>
              </header>
              <div className="fieldGrid">
                <label className="fieldWide">
                  <span>Title</span>
                  <input
                    value={bundle.metadata.title}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("title", event.target.value)
                    }
                  />
                </label>
                <label className="fieldWide">
                  <span>Description</span>
                  <textarea
                    rows={2}
                    value={bundle.metadata.description}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("description", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Primary skill</span>
                  <select
                    value={bundle.metadata.primarySkill}
                    disabled={!editable}
                    onChange={(event) =>
                      updateMetadata("primarySkill", event.target.value)
                    }
                  >
                    {[
                      "one-on-ones",
                      "feedback",
                      "coaching",
                      "delegation",
                      "team-dynamics",
                      "transition-to-manager",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Emotional load</span>
                  <select
                    value={bundle.metadata.emotionalLoad}
                    disabled={!editable}
                    onChange={(event) =>
                      updateMetadata(
                        "emotionalLoad",
                        event.target.value as Metadata["emotionalLoad"],
                      )
                    }
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label>
                  <span>Pattern</span>
                  <select
                    value={bundle.metadata.pattern}
                    disabled={!editable}
                    onChange={(event) =>
                      updateMetadata(
                        "pattern",
                        event.target.value as Metadata["pattern"],
                      )
                    }
                  >
                    <option value="first-occurrence">First occurrence</option>
                    <option value="emerging-pattern">Emerging pattern</option>
                    <option value="repeated-pattern">Repeated pattern</option>
                  </select>
                </label>
                <label>
                  <span>Preparation</span>
                  <select
                    value={bundle.metadata.preparationTime}
                    disabled={!editable}
                    onChange={(event) =>
                      updateMetadata(
                        "preparationTime",
                        event.target.value as Metadata["preparationTime"],
                      )
                    }
                  >
                    <option>5 minutes</option>
                    <option>15 minutes</option>
                    <option>30 minutes</option>
                  </select>
                </label>
                <label>
                  <span>Scope</span>
                  <select
                    value={bundle.metadata.scope}
                    disabled={!editable}
                    onChange={(event) =>
                      updateMetadata(
                        "scope",
                        event.target.value as Metadata["scope"],
                      )
                    }
                  >
                    <option value="individual">Individual</option>
                    <option value="pair">Pair</option>
                    <option value="team">Team</option>
                  </select>
                </label>
                <label className="fieldWide">
                  <span>Tags (comma separated)</span>
                  <input
                    value={bundle.metadata.tags.join(", ")}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata(
                        "tags",
                        event.target.value
                          .split(",")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      )
                    }
                  />
                </label>
                <fieldset
                  className="choiceField fieldWide"
                  disabled={!editable}
                >
                  <legend>Audience</legend>
                  {(["manager", "technical-lead"] as const).map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={bundle.metadata.audience.includes(value)}
                        onChange={(event) =>
                          updateMetadata(
                            "audience",
                            event.target.checked
                              ? [...bundle.metadata.audience, value]
                              : bundle.metadata.audience.filter(
                                  (item) => item !== value,
                                ),
                          )
                        }
                      />
                      <span>{value.replaceAll("-", " ")}</span>
                    </label>
                  ))}
                </fieldset>
                <fieldset
                  className="choiceField fieldWide"
                  disabled={!editable}
                >
                  <legend>Support</legend>
                  {(
                    [
                      "hr",
                      "legal",
                      "safety",
                      "security",
                      "senior-leader",
                    ] as const
                  ).map((value) => (
                    <label key={value}>
                      <input
                        type="checkbox"
                        checked={bundle.metadata.support.includes(value)}
                        onChange={(event) =>
                          updateMetadata(
                            "support",
                            event.target.checked
                              ? [...bundle.metadata.support, value]
                              : bundle.metadata.support.filter(
                                  (item) => item !== value,
                                ),
                          )
                        }
                      />
                      <span>{value.replaceAll("-", " ")}</span>
                    </label>
                  ))}
                </fieldset>
                <label className="fieldWide">
                  <span>Stakes</span>
                  <textarea
                    rows={3}
                    value={bundle.metadata.stakes}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("stakes", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Published</span>
                  <input
                    type="date"
                    value={bundle.metadata.published}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("published", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Last reviewed</span>
                  <input
                    type="date"
                    value={bundle.metadata.lastReviewed}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("lastReviewed", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Author ID</span>
                  <input
                    value={bundle.metadata.author}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("author", event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Reviewer ID</span>
                  <input
                    value={bundle.metadata.reviewer}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("reviewer", event.target.value)
                    }
                  />
                </label>
                <label className="fieldWide">
                  <span>Social hook</span>
                  <textarea
                    rows={2}
                    value={bundle.metadata.socialHook}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("socialHook", event.target.value)
                    }
                  />
                </label>
                <label className="fieldWide">
                  <span>Campaign cluster</span>
                  <input
                    value={bundle.metadata.campaignCluster}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) =>
                      updateMetadata("campaignCluster", event.target.value)
                    }
                  />
                </label>
              </div>
            </section>

            <section className="editorCard sectionCard">
              <header>
                <div>
                  <p className="cardEyebrow">Guidance</p>
                  <h2>{rawMode ? "Raw MDX" : "Required sections"}</h2>
                </div>
                <button
                  className="textButton"
                  type="button"
                  disabled={!editable}
                  onClick={() => {
                    if (!rawMode) {
                      setRawBody(body);
                      setRawMode(true);
                      return;
                    }
                    try {
                      setSections(parseSections(sectionNames, rawBody));
                      setRawMode(false);
                      setMessage(null);
                    } catch (error) {
                      setMessage(
                        error instanceof Error
                          ? error.message
                          : "Raw MDX could not be parsed.",
                      );
                    }
                  }}
                >
                  {rawMode ? "Use section editor" : "Advanced: edit raw MDX"}
                </button>
              </header>
              {rawMode ? (
                <label className="rawEditor">
                  <span className="srOnly">Situation MDX</span>
                  <textarea
                    spellCheck
                    value={rawBody}
                    disabled={!editable}
                    onBlur={() => void save()}
                    onChange={(event) => {
                      setRawBody(event.target.value);
                      markDirty();
                    }}
                  />
                </label>
              ) : (
                <div className="sectionEditors">
                  {sectionNames.map((name, index) => (
                    <details key={name} open={index < 3}>
                      <summary>
                        <span>{String(index + 1).padStart(2, "0")}</span>
                        <strong>{name}</strong>
                        <small>
                          {(sections[name] ?? "").length} characters
                        </small>
                      </summary>
                      <label>
                        <span className="srOnly">{name}</span>
                        <textarea
                          rows={7}
                          value={sections[name] ?? ""}
                          disabled={!editable}
                          onBlur={() => void save()}
                          onChange={(event) => {
                            setSections((current) => ({
                              ...current,
                              [name]: event.target.value,
                            }));
                            markDirty();
                          }}
                        />
                      </label>
                    </details>
                  ))}
                </div>
              )}
            </section>
          </div>
          <aside className="previewColumn">
            <header>
              <div>
                <p className="cardEyebrow">Draft preview</p>
                <h2>Leadership rendering</h2>
              </div>
              <span>Studio bytes</span>
            </header>
            <div className="previewFrame">
              <p className="previewEyebrow">{bundle.metadata.primarySkill}</p>
              <h1>{bundle.metadata.title}</h1>
              <p className="previewDescription">
                {bundle.metadata.description}
              </p>
              <RenderedGuidance body={body} />
            </div>
          </aside>
        </section>
      ) : null}

      {tab === "review" ? (
        <section
          id="panel-review"
          className="workspacePanel reviewPanel"
          role="tabpanel"
          aria-labelledby="tab-review"
          tabIndex={-1}
        >
          {!review?.proposal ? (
            <div className="reviewSummary">
              <div>
                <p className="cardEyebrow">Exact comparison</p>
                <h2>{changedSections.length} changed sections</h2>
                <p>
                  Production and draft are rendered from their retained source
                  bytes. The source diff below is exact.
                </p>
              </div>
              {review && reviewStatus ? (
                <div
                  className={`reviewJobCard review-${reviewStatus.state.toLowerCase()} ${
                    reviewStatus.retry ? "review-retrying" : ""
                  }`}
                >
                  <span
                    className={`jobState state-${
                      reviewStatus.retry
                        ? "retrying"
                        : reviewStatus.state.toLowerCase()
                    }`}
                  >
                    {reviewStatus.retry ? "RETRYING" : reviewStatus.state}
                  </span>
                  <strong>22-stage agent review</strong>
                  <span className="reviewProgressText">
                    {reviewProgressText(reviewStatus)}
                  </span>
                  <div
                    className="reviewProgressBar"
                    role="progressbar"
                    aria-label="Agent review progress"
                    aria-valuemin={0}
                    aria-valuemax={reviewStatus.totalStages}
                    aria-valuenow={reviewStatus.completedStages}
                    aria-valuetext={reviewProgressText(reviewStatus)}
                  >
                    <div className="stageRail" aria-hidden="true">
                      {reviewStatus.stages.map((step) => (
                        <i
                          key={step.ordinal}
                          className={[
                            step.state.toLowerCase(),
                            isActiveReviewState(reviewStatus.state) &&
                            reviewStatus.currentStage?.ordinal === step.ordinal
                              ? "active"
                              : "",
                            reviewStatus.retry?.stageOrdinal === step.ordinal
                              ? "retrying"
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        />
                      ))}
                    </div>
                  </div>
                  {reviewStatus.currentStage ? (
                    <p className="reviewCurrentStage">
                      <span>
                        {reviewStatus.state === "FAILED"
                          ? "Stopped at"
                          : reviewStatus.state === "CANCELLED"
                            ? "Cancelled at"
                            : reviewStatus.retry
                              ? "Retrying stage"
                              : "Current stage"}
                      </span>
                      <strong>{reviewStatus.currentStage.displayName}</strong>
                      {reviewStatus.currentStage.attempt ? (
                        <small>
                          Attempt {reviewStatus.currentStage.attempt}
                          {reviewStatus.retry
                            ? ` of ${reviewStatus.retry.maximumAttempts}`
                            : ""}
                        </small>
                      ) : null}
                    </p>
                  ) : null}
                  {isActiveReviewState(reviewStatus.state) ? (
                    <p className="reviewServerActivity">
                      <i
                        className="reviewActivityIndicator"
                        aria-hidden="true"
                      />
                      <span>
                        {liveReview.connection === "reconnecting"
                          ? "Reconnecting… Review continues safely on the server."
                          : liveReview.connection === "connecting"
                            ? "Connecting to live updates… Review continues safely on the server."
                            : "Review continues safely on the server."}
                      </span>
                    </p>
                  ) : null}
                  {reviewStatus.retry ? (
                    <p className="reviewRetryStatus">
                      <strong>Automatic retry scheduled</strong>
                      <span>
                        {
                          SAFE_REVIEW_FAILURE_LABELS[
                            reviewStatus.retry.failureClass
                          ]
                        }
                        {" · "}
                        attempt {reviewStatus.retry.attempt} of{" "}
                        {reviewStatus.retry.maximumAttempts}
                      </span>
                      <span className="retrySchedule">
                        {retryCountdown(
                          reviewStatus.retry.scheduledAt,
                          reviewClock,
                        )}
                        {" · "}
                        <time dateTime={reviewStatus.retry.scheduledAt}>
                          {formattedRetryTime(reviewStatus.retry.scheduledAt)}
                        </time>
                      </span>
                    </p>
                  ) : null}
                  {reviewStatus.state === "SUCCEEDED" ? (
                    <p className="reviewTerminalStatus reviewTerminalSuccess">
                      <strong>Review complete.</strong>
                      <span>
                        {reviewStatus.proposalReady
                          ? "Loading the agent revision…"
                          : "Finalizing the revision view…"}
                      </span>
                    </p>
                  ) : reviewStatus.state === "FAILED" ? (
                    <p className="reviewTerminalStatus reviewTerminalFailure">
                      <strong>Review stopped safely.</strong>
                      <span>
                        {reviewStatus.terminal?.failureClass
                          ? `${SAFE_REVIEW_FAILURE_LABELS[reviewStatus.terminal.failureClass]}. `
                          : ""}
                        Use Retry review when you are ready.
                      </span>
                    </p>
                  ) : reviewStatus.state === "CANCELLED" ? (
                    <p className="reviewTerminalStatus">
                      <strong>Review cancelled.</strong>
                      <span>The workspace is editable again.</span>
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="reviewJobCard quiet">
                  <strong>No agent revision attached</strong>
                  <span>Manual editing and publication remain available.</span>
                </div>
              )}
            </div>
          ) : null}
          {review?.proposal ? (
            <>
              <AgentRevisionReview
                proposal={review.proposal}
                inputRevisionId={review.inputRevisionId}
                currentRevisionId={review.currentRevisionId}
                inputBundleHash={review.inputBundleHash}
                checkoutAvailable={Boolean(checkout)}
                pending={pending || proposalPending}
                publicationLocked={publicationLocked}
                onAccept={(changeId) =>
                  checkout
                    ? proposalRequest(
                        `/api/proposal-changes/${changeId}`,
                        "POST",
                        {
                          checkoutId: checkout.id,
                          fence: checkout.fence,
                          decision: "ACCEPT",
                        },
                      )
                    : Promise.resolve(false)
                }
                onReject={(changeId) =>
                  checkout
                    ? proposalRequest(
                        `/api/proposal-changes/${changeId}`,
                        "POST",
                        {
                          checkoutId: checkout.id,
                          fence: checkout.fence,
                          decision: "REJECT",
                        },
                      )
                    : Promise.resolve(false)
                }
                onEdit={(changeId, editedBody) =>
                  checkout
                    ? proposalRequest(
                        `/api/proposal-changes/${changeId}`,
                        "PATCH",
                        {
                          checkoutId: checkout.id,
                          fence: checkout.fence,
                          editedBody,
                        },
                      )
                    : Promise.resolve(false)
                }
                onAcceptAll={() =>
                  checkout
                    ? proposalRequest(
                        `/api/review-proposals/${review.proposal!.id}/accept-all`,
                        "POST",
                        {
                          checkoutId: checkout.id,
                          fence: checkout.fence,
                        },
                      )
                    : Promise.resolve(false)
                }
                onRejectAll={() =>
                  checkout
                    ? proposalRequest(
                        `/api/review-proposals/${review.proposal!.id}/reject-all`,
                        "POST",
                        {
                          checkoutId: checkout.id,
                          fence: checkout.fence,
                        },
                      )
                    : Promise.resolve(false)
                }
              />
              <details className="secondaryReviewComparison">
                <summary>
                  Production → saved draft ({changedSections.length} changed{" "}
                  {changedSections.length === 1 ? "section" : "sections"})
                </summary>
                <RenderedComparison
                  production={productionBody}
                  draft={body}
                  productionRevision={shortHash(situation.productionBundleHash)}
                />
                <details className="diffDisclosure">
                  <summary>Production source diff</summary>
                  <SynchronizedDiff production={productionBody} draft={body} />
                </details>
              </details>
            </>
          ) : (
            <>
              <RenderedComparison
                production={productionBody}
                draft={body}
                productionRevision={shortHash(situation.productionBundleHash)}
              />
              <details className="diffDisclosure" open>
                <summary>Exact source diff</summary>
                <SynchronizedDiff production={productionBody} draft={body} />
              </details>
            </>
          )}
        </section>
      ) : null}

      {tab === "history" ? (
        <section
          id="panel-history"
          className="workspacePanel historyPanel"
          role="tabpanel"
          aria-labelledby="tab-history"
          tabIndex={-1}
        >
          <header className="panelIntro">
            <div>
              <p className="cardEyebrow">Forward-only history</p>
              <h2>Every distinct production version</h2>
              <p>
                A restoration starts a reviewable draft. It never rewinds
                unrelated Leadership content.
              </p>
            </div>
          </header>
          <div className="historyTimeline">
            {history.map((item, index) => (
              <article key={item.id}>
                <div className="timelineRail">
                  <i aria-hidden="true" />
                  {index < history.length - 1 ? (
                    <span aria-hidden="true" />
                  ) : null}
                </div>
                <div className="historyContent">
                  <header>
                    <div>
                      <span className="historyVersion">
                        Version {history.length - index}
                      </span>
                      <strong>{item.changeSummary}</strong>
                    </div>
                    <time dateTime={item.productionAt}>
                      {new Date(item.productionAt).toLocaleString()}
                    </time>
                  </header>
                  <dl>
                    <div>
                      <dt>Source</dt>
                      <dd>{item.sourceKind.replaceAll("_", " ")}</dd>
                    </div>
                    <div>
                      <dt>Bundle</dt>
                      <dd>
                        <code>{shortHash(item.bundleHash)}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Leadership release</dt>
                      <dd>
                        <code>{item.releaseId.slice(0, 8)}…</code>
                      </dd>
                    </div>
                  </dl>
                  {item.editorNote ? <p>{item.editorNote}</p> : null}
                  <div className="historyActions">
                    <button
                      className="textButton"
                      type="button"
                      aria-expanded={comparedHistoryId === item.id}
                      onClick={() =>
                        setComparedHistoryId((current) =>
                          current === item.id ? null : item.id,
                        )
                      }
                    >
                      {comparedHistoryId === item.id
                        ? "Close comparison"
                        : "Compare with current"}
                    </button>
                    <button
                      className="secondaryButton"
                      type="button"
                      disabled={!mine || workspaceLocked}
                      onClick={() =>
                        void mutate(
                          `/api/history/${item.id}/restore`,
                          checkout
                            ? { checkoutId: checkout.id, fence: checkout.fence }
                            : {},
                        )
                      }
                    >
                      Start restoration draft
                    </button>
                  </div>
                  {comparedHistoryId === item.id ? (
                    <div className="historyComparison">
                      <article
                        tabIndex={0}
                        aria-label="Selected history version"
                      >
                        <strong>Selected version</strong>
                        <RenderedGuidance body={item.body} compact />
                      </article>
                      <article
                        tabIndex={0}
                        aria-label="Current production version"
                      >
                        <strong>Current production</strong>
                        <RenderedGuidance body={productionBody} compact />
                      </article>
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
            {!history.length ? (
              <div className="emptyState">
                <strong>No production versions yet.</strong>
                <span>
                  The first successful submission becomes version one.
                </span>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {tab === "context" ? (
        <section
          id="panel-context"
          className="workspacePanel contextPanel"
          role="tabpanel"
          aria-labelledby="tab-context"
          tabIndex={-1}
        >
          <header className="panelIntro">
            <div>
              <p className="cardEyebrow">Review evidence</p>
              <h2>Connected learning surfaces</h2>
              <p>
                Shared originals stay read-only. Editing one here creates a
                situation-owned variant.
              </p>
            </div>
          </header>
          <div className="contextGrid">
            {context.map((item) => (
              <article key={item.logicalId}>
                <header>
                  <span className="artifactKind">
                    {item.kind.replaceAll("_", " ")}
                  </span>
                  {item.hasVariant ? (
                    <span className="variantBadge">Scoped variant</span>
                  ) : (
                    <span className="sharedBadge">Shared original</span>
                  )}
                </header>
                <h3>{item.logicalId}</h3>
                <dl>
                  <div>
                    <dt>Sharing</dt>
                    <dd>{item.sharingCount} situations</dd>
                  </div>
                  <div>
                    <dt>Current hash</dt>
                    <dd>
                      <code>{shortHash(item.contentHash)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Visibility</dt>
                    <dd>{item.visibility.replaceAll("_", " ")}</dd>
                  </div>
                </dl>
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={!editable}
                  onClick={() => {
                    if (!checkout) return;
                    const changedBody = window.prompt(
                      `Create a situation-scoped ${item.kind.toLowerCase()} variant. Enter the complete replacement content:`,
                    );
                    if (changedBody)
                      void mutate(`/api/checkouts/${checkout.id}/variants`, {
                        fence: checkout.fence,
                        originalLogicalId: item.logicalId,
                        originalContentHash: item.contentHash,
                        kind: item.kind,
                        changedBody,
                      });
                  }}
                >
                  {item.hasVariant ? "Edit this variant" : "Create scoped edit"}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {confirmSubmit && checkout ? (
        <div className="dialogBackdrop" role="presentation">
          <div
            ref={submitDialog}
            className="confirmationDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="submit-title"
            tabIndex={-1}
            onKeyDown={handleSubmitDialogKeyDown}
          >
            <p className="cardEyebrow">One production confirmation</p>
            <h2 id="submit-title">Submit this situation to Leadership?</h2>
            <p>
              Studio will validate the exact saved bundle, carry unrelated
              production content forward, and verify the running Leadership
              release before reporting success.
            </p>
            <dl>
              <div>
                <dt>Situation</dt>
                <dd>{bundle.metadata.title}</dd>
              </div>
              <div>
                <dt>Current production</dt>
                <dd>
                  <code>{shortHash(situation.productionBundleHash)}</code>
                </dd>
              </div>
              <div>
                <dt>Changed sections</dt>
                <dd>
                  {changedSections.join(", ") || "Metadata or relationships"}
                </dd>
              </div>
              <div>
                <dt>Provenance</dt>
                <dd>{review?.proposal ? "Agent-assisted" : "Manual"}</dd>
              </div>
              <div>
                <dt>Validation</dt>
                <dd className="validationPass">
                  Ready for exact-hash validation
                </dd>
              </div>
            </dl>
            <div className="dialogActions">
              <button
                className="secondaryButton"
                type="button"
                onClick={closeSubmitDialog}
              >
                Keep editing
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={pending}
                onClick={() => {
                  setConfirmSubmit(false);
                  void mutate(
                    `/api/checkouts/${checkout.id}/publish`,
                    {
                      fence: checkout.fence,
                    },
                    { saveFirst: true },
                  );
                }}
              >
                Confirm submission
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
