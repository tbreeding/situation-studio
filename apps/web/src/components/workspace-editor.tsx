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
  displayedReviewSnapshot,
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
import {
  isActivePublicationState,
  isPublicationWorkspaceLocked,
  isTerminalPublicationState,
  publicationStatusSnapshotSchema,
  PUBLICATION_STATUS_EVENT_NAME,
  type PublicPublicationFailureDetail,
  type PublicationStatusSnapshot,
} from "@/publication-status-contract";
import {
  exactRevisionCommand,
  reviewRequiresForcedCheckpoint,
  serverRevisionAdoptionDecision,
  type EditorRevisionIdentity,
} from "@/editor-revision-state";
import {
  changedWorkspaceSections,
  currentWorkspaceBody,
  parseWorkspaceSections,
} from "@/workspace-source-state";

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
  sourceReferences?: string[];
  relatedSituationIds?: string[];
  practiceId?: string;
  practiceVariant?: string;
  fieldNotePresent?: true;
  safetyEscalationNotePresent?: true;
  reviewStatus?: "human-approved";
  socialHook: string;
  campaignCluster: string;
};

type Bundle = {
  schemaVersion: string;
  contractVersion: string;
  validationPolicyVersion: string;
  situationId: string;
  visibility: "PUBLIC" | "RETIRED" | "UNPUBLISHED";
  metadata: Metadata;
  bodyHash: string;
  managedComponents?: {
    practiceEmbed: {
      compact: true;
      practiceId: string;
      surface: "situation";
      variant: string;
    };
    preparedAction: { scenario: string; skill: string };
  };
  artifacts: unknown[];
  relationships: Array<{
    kind: string;
    logicalId: string;
    position: number;
    contentHash: string;
    visibility: string;
  }>;
  promotion: Record<string, unknown> | null;
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

type AuthoritativeRevision = {
  revisionId: string;
  revision: number;
  bundleHash: string;
  bundle: Bundle;
  body: string;
  savedAt: string;
};

type PublicationPreflight = {
  receiptId: string;
  revisionId: string;
  bundleHash: string;
  candidateHash: string;
  manifestHash: string;
  situationArtifactHash: string;
  baseReleaseId: string;
  baseManifestHash: string;
  expectedPointerGeneration: string;
  contractDigest: string;
  validationResult: "PASSED";
  candidatePreview: {
    schemaVersion: "publishable-situation-projection-v1";
    visibility: "PUBLIC" | "RETIRED";
    frontmatter: Metadata;
    bodyMdx: string;
    bodyMdxHash: string;
    managedComponents: Bundle["managedComponents"];
    relationships: Array<{
      kind: string;
      originalLogicalId: string;
      resolvedLogicalId: string;
      contentHash: string;
      visibility: string;
      position: number;
    }>;
    scopedArtifacts: Array<{
      logicalId: string;
      contentHash: string;
      byteLength: number;
      path: string;
      visibility?: string;
      ownerSituationSlug?: string;
      forkedFromLogicalId?: string;
      forkedFromContentHash?: string;
    }>;
    promotion: Record<string, unknown> | null;
    [key: string]: unknown;
  };
  validatedAt: string;
};

type ContextItem = {
  logicalId: string;
  kind: string;
  visibility: string;
  contentHash: string;
  sharingCount: number;
  hasVariant: boolean;
  body: string;
};

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function shortHash(value: string | null) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "Not published";
}

function publicationFailureExplanation(
  failure: PublicPublicationFailureDetail,
) {
  switch (failure.reason) {
    case "HTTP_STATUS":
      return failure.lastHttpStatus
        ? `The live content health check returned HTTP ${failure.lastHttpStatus} instead of a release identity.`
        : "The live content health check returned an error instead of a release identity.";
    case "IDENTITY_MISMATCH":
      return "The live content health check responded, but it did not report the release that was just activated.";
    case "UNAVAILABLE":
      return "The live content health check could not be reached or completed.";
    case "INVALID_RESPONSE":
      return "The live content health check responded, but its release identity could not be used.";
  }
}

function elapsedTimeLabel(elapsedMs: number) {
  if (elapsedMs < 1_000)
    return `${elapsedMs} ${elapsedMs === 1 ? "millisecond" : "milliseconds"}`;
  const seconds = (elapsedMs / 1_000).toFixed(1).replace(/\.0$/u, "");
  return `${seconds} ${seconds === "1" ? "second" : "seconds"}`;
}

function PublicationFailureEvidence({
  failure,
  summary,
  conclusion,
}: {
  failure: PublicPublicationFailureDetail;
  summary: string;
  conclusion: string;
}) {
  return (
    <details>
      <summary>{summary}</summary>
      <p>
        {publicationFailureExplanation(failure)} {conclusion}
      </p>
      <dl>
        <dt>Source</dt>
        <dd>Leadership content health</dd>
        <dt>Checks</dt>
        <dd>{failure.attempts}</dd>
        <dt>Verification time</dt>
        <dd>{elapsedTimeLabel(failure.elapsedMs)}</dd>
        {failure.lastHttpStatus ? (
          <>
            <dt>Last HTTP status</dt>
            <dd>{failure.lastHttpStatus}</dd>
          </>
        ) : null}
        <dt>Last observed identity</dt>
        <dd>
          {failure.lastObservedReleaseId ? (
            <>
              Release {failure.lastObservedReleaseId}
              {failure.lastObservedManifestHash
                ? ` · manifest ${shortHash(failure.lastObservedManifestHash)}`
                : ""}
            </>
          ) : (
            "No usable release identity was returned."
          )}
        </dd>
      </dl>
    </details>
  );
}

function replaceManagedAttribute(
  source: string,
  component: "PracticeEmbed" | "PreparedAction",
  attribute: string,
  value: string,
) {
  const pattern = new RegExp(
    `(<${component}\\b[^>]*\\b${attribute}\\s*=\\s*)(["'])(.*?)(\\2)`,
    "u",
  );
  return source.replace(
    pattern,
    (_match, prefix: string, quote: string) =>
      `${prefix}${quote}${value}${quote}`,
  );
}

export function WorkspaceEditor({
  initialTab,
  situation,
  initialBundle,
  initialSections,
  initialBody,
  initialRevision,
  productionBody,
  sectionNames,
  checkout,
  currentUserId,
  csrfToken,
  review,
  publication,
  globalRecoveryRequired,
  publicationBackup,
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
  initialRevision: {
    id: string;
    revision: number;
    bundleHash: string;
    savedAt: string;
  };
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
  publication: PublicationStatusSnapshot | null;
  globalRecoveryRequired: boolean;
  publicationBackup: { ready: boolean; message: string };
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
  const reviewStatus = displayedReviewSnapshot(
    liveReview,
    serverReviewSnapshot,
  );
  const serverPublicationSnapshot = publication;
  const [livePublication, setLivePublication] = useState<{
    publicationJobId: string;
    serverSnapshotId: string;
    snapshot: PublicationStatusSnapshot;
  } | null>(null);
  const publicationStatus =
    livePublication &&
    serverPublicationSnapshot &&
    livePublication.publicationJobId ===
      serverPublicationSnapshot.publicationJobId &&
    livePublication.serverSnapshotId === serverPublicationSnapshot.snapshotId
      ? livePublication.snapshot
      : serverPublicationSnapshot;
  const publicationActive = publicationStatus
    ? isActivePublicationState(publicationStatus.state)
    : false;
  const mine = checkout?.holderId === currentUserId;
  const reviewLocked = reviewStatus
    ? isActiveReviewState(reviewStatus.state)
    : false;
  const publicationLocked =
    globalRecoveryRequired ||
    (publicationStatus
      ? isPublicationWorkspaceLocked(publicationStatus.state)
      : false);
  const workspaceLocked = reviewLocked || publicationLocked;
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [bundle, setBundle] = useState(initialBundle);
  const [sections, setSections] = useState(initialSections);
  const [rawBody, setRawBody] = useState(initialBody);
  const [savedBody, setSavedBody] = useState(initialBody);
  const [bodyTouched, setBodyTouched] = useState(false);
  const [currentRevision, setCurrentRevision] = useState(initialRevision);
  const [rawMode, setRawMode] = useState(false);
  const [saveState, setSaveState] = useState<
    "saved" | "dirty" | "saving" | "error"
  >("saved");
  const [message, setMessage] = useState<string | null>(null);
  const [proposalPending, setProposalPending] = useState(false);
  const [pending, startTransition] = useTransition();
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [preflight, setPreflight] = useState<PublicationPreflight | null>(null);
  const [preflightPending, setPreflightPending] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const editable = Boolean(
    mine &&
    !workspaceLocked &&
    !proposalPending &&
    !preflightPending &&
    !pending &&
    !revisionConflict,
  );
  const [scopedEdit, setScopedEdit] = useState<{
    item: ContextItem;
    body: string;
  } | null>(null);
  const [comparedHistoryId, setComparedHistoryId] = useState<string | null>(
    null,
  );
  const dirtyVersion = useRef(0);
  const savedVersion = useRef(0);
  const revisionRef = useRef(initialRevision);
  const saveQueue = useRef<Promise<EditorRevisionIdentity | false>>(
    Promise.resolve({
      id: initialRevision.id,
      bundleHash: initialRevision.bundleHash,
    }),
  );
  const submitButton = useRef<HTMLButtonElement>(null);
  const submitDialog = useRef<HTMLDivElement>(null);
  const reviewConnectionGeneration = useRef(0);
  const publicationConnectionGeneration = useRef(0);
  const refreshedTerminalSnapshot = useRef<string | null>(
    serverReviewSnapshot && isTerminalReviewState(serverReviewSnapshot.state)
      ? serverReviewSnapshot.snapshotId
      : null,
  );
  const previousAnnouncedSnapshot = useRef<ReviewStatusSnapshot | null>(null);
  const refreshedPublicationTerminal = useRef<string | null>(
    serverPublicationSnapshot &&
      isTerminalPublicationState(serverPublicationSnapshot.state)
      ? serverPublicationSnapshot.snapshotId
      : null,
  );
  const announcementState = useRef<ReviewAnnouncementState>({
    message: "",
    lastAnnouncedAt: Number.NEGATIVE_INFINITY,
    snapshotId: null,
  });
  const [reviewAnnouncement, setReviewAnnouncement] = useState("");
  const [reviewClock, setReviewClock] = useState(() => Date.now());

  const adoptAuthoritativeRevision = useCallback(
    (authoritative: AuthoritativeRevision) => {
      revisionRef.current = {
        id: authoritative.revisionId,
        revision: authoritative.revision,
        bundleHash: authoritative.bundleHash,
        savedAt: authoritative.savedAt,
      };
      setCurrentRevision(revisionRef.current);
      setBundle(authoritative.bundle);
      setRawBody(authoritative.body);
      setSavedBody(authoritative.body);
      setBodyTouched(false);
      try {
        setSections(parseWorkspaceSections(sectionNames, authoritative.body));
        setRawMode(false);
      } catch {
        setRawMode(true);
      }
      dirtyVersion.current = 0;
      savedVersion.current = 0;
      setRevisionConflict(false);
      setSaveState("saved");
      setPreflight(null);
    },
    [sectionNames],
  );

  useEffect(() => {
    const decision = serverRevisionAdoptionDecision(
      revisionRef.current,
      initialRevision,
      dirtyVersion.current !== savedVersion.current,
    );
    if (decision === "UNCHANGED") return;
    if (decision === "PRESERVE_LOCAL") {
      setRevisionConflict(true);
      setPreflight(null);
      setSaveState("error");
      setMessage(
        "A newer authoritative revision arrived while you had unsaved edits. Your local text is preserved. Copy it before reloading to reconcile the revisions.",
      );
      return;
    }
    adoptAuthoritativeRevision({
      revisionId: initialRevision.id,
      revision: initialRevision.revision,
      bundleHash: initialRevision.bundleHash,
      bundle: initialBundle,
      body: initialBody,
      savedAt: initialRevision.savedAt,
    });
  }, [adoptAuthoritativeRevision, initialBody, initialBundle, initialRevision]);

  useEffect(() => {
    const generation = ++publicationConnectionGeneration.current;
    if (
      !serverPublicationSnapshot ||
      !isActivePublicationState(serverPublicationSnapshot.state)
    )
      return;

    const publicationJobId = serverPublicationSnapshot.publicationJobId;
    const source = new EventSource(
      `/api/publications/${publicationJobId}/events`,
    );
    const receiveSnapshot = (rawEvent: Event) => {
      if (generation !== publicationConnectionGeneration.current) return;
      const event = rawEvent as MessageEvent<string>;
      try {
        const snapshot = publicationStatusSnapshotSchema.parse(
          JSON.parse(event.data) as unknown,
        );
        setLivePublication({
          publicationJobId,
          serverSnapshotId: serverPublicationSnapshot.snapshotId,
          snapshot,
        });
        if (isTerminalPublicationState(snapshot.state)) source.close();
      } catch {
        // Native EventSource reconnection or the next valid durable snapshot
        // recovers malformed or interrupted public input.
      }
    };
    source.addEventListener(PUBLICATION_STATUS_EVENT_NAME, receiveSnapshot);
    return () => {
      source.removeEventListener(
        PUBLICATION_STATUS_EVENT_NAME,
        receiveSnapshot,
      );
      source.close();
    };
  }, [serverPublicationSnapshot]);

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

  useEffect(() => {
    if (
      !publicationStatus ||
      !isTerminalPublicationState(publicationStatus.state)
    ) {
      refreshedPublicationTerminal.current = null;
      return;
    }
    if (refreshedPublicationTerminal.current === publicationStatus.snapshotId)
      return;
    refreshedPublicationTerminal.current = publicationStatus.snapshotId;
    const timer = window.setTimeout(() => router.refresh(), 250);
    return () => window.clearTimeout(timer);
  }, [publicationStatus, router]);

  const body = useMemo(
    () =>
      currentWorkspaceBody({
        bodyTouched,
        rawMode,
        rawBody,
        sectionNames,
        sections,
      }),
    [bodyTouched, rawBody, rawMode, sectionNames, sections],
  );

  function markDirty() {
    dirtyVersion.current += 1;
    setSaveState("dirty");
    setPreflight(null);
    setConfirmSubmit(false);
  }

  const save = useCallback(
    async (namedCheckpoint = "Autosave", forceCheckpoint = false) => {
      if (!checkout || !editable) return false;
      if (!forceCheckpoint && savedVersion.current === dirtyVersion.current)
        return revisionRef.current;
      const version = dirtyVersion.current;
      const capturedBody = body;
      const capturedBundle = bundle;
      const queued = saveQueue.current.then(async () => {
        if (!forceCheckpoint && savedVersion.current >= version)
          return revisionRef.current;
        setSaveState("saving");
        const bodyHash = await sha256(capturedBody);
        const nextBundle = { ...capturedBundle, bodyHash };
        const expected = revisionRef.current;
        const response = await fetch(`/api/checkouts/${checkout.id}/save`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({
            fence: checkout.fence,
            bundle: nextBundle,
            body: capturedBody,
            namedCheckpoint,
            expectedParentRevisionId: expected.id,
            expectedParentBundleHash: expected.bundleHash,
          }),
        });
        const payload = (await response.json()) as Partial<
          AuthoritativeRevision & { error: string }
        >;
        if (
          !response.ok ||
          !payload.revisionId ||
          payload.revision === undefined ||
          !payload.bundleHash ||
          !payload.bundle ||
          !payload.body ||
          !payload.savedAt
        ) {
          setSaveState("error");
          setMessage(payload.error ?? "The draft could not be saved.");
          return false;
        }
        revisionRef.current = {
          id: payload.revisionId,
          revision: payload.revision,
          bundleHash: payload.bundleHash,
          savedAt: payload.savedAt,
        };
        setCurrentRevision(revisionRef.current);
        savedVersion.current = Math.max(savedVersion.current, version);
        setSavedBody(payload.body);
        if (version === dirtyVersion.current) {
          setBundle(payload.bundle);
          setRawBody(payload.body);
          setBodyTouched(false);
          try {
            setSections(parseWorkspaceSections(sectionNames, payload.body));
          } catch {
            setRawMode(true);
          }
        }
        setSaveState(version === dirtyVersion.current ? "saved" : "dirty");
        return {
          id: payload.revisionId,
          bundleHash: payload.bundleHash,
        };
      });
      saveQueue.current = queued.catch(() => false);
      return queued;
    },
    [body, bundle, checkout, csrfToken, editable, sectionNames],
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
    options: {
      saveFirst?: boolean;
      redirectHome?: boolean;
      exactRevision?: boolean;
      forceCheckpoint?: boolean;
    } = {},
  ) {
    setMessage(null);
    let checkpointRevision: EditorRevisionIdentity | null = null;
    if (options.saveFirst) {
      const saved = await save(
        "Action checkpoint",
        options.forceCheckpoint ?? false,
      );
      if (!saved) return;
      checkpointRevision = saved;
      if (dirtyVersion.current !== savedVersion.current) {
        setMessage(
          "The draft changed while the action checkpoint was being saved. Save the newer edits before continuing.",
        );
        return;
      }
    }
    startTransition(async () => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({
            ...payload,
            ...(options.exactRevision
              ? exactRevisionCommand(checkpointRevision ?? revisionRef.current)
              : {}),
          }),
        });
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) {
          if (result.error?.toLowerCase().includes("preflight")) {
            setPreflight(null);
            setConfirmSubmit(false);
          }
          setMessage(result.error ?? "The action could not be completed.");
          return;
        }
        if (options.redirectHome) router.push("/");
        router.refresh();
      } catch {
        setMessage(
          "The action could not be completed. Check your connection and try again.",
        );
      }
    });
  }

  async function prepareProductionSubmission() {
    if (!checkout || preflightPending) return;
    setMessage(null);
    setPreflightPending(true);
    try {
      if (!(await save("Publication preflight"))) return;
      if (dirtyVersion.current !== savedVersion.current) {
        setPreflight(null);
        setMessage(
          "The draft changed while it was being saved. Save the newer edits before validating for production.",
        );
        return;
      }
      const validationVersion = dirtyVersion.current;
      const expected = revisionRef.current;
      const response = await fetch(`/api/checkouts/${checkout.id}/preflight`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          fence: checkout.fence,
          revisionId: expected.id,
          bundleHash: expected.bundleHash,
        }),
      });
      const result = (await response.json().catch(() => ({}))) as Partial<
        PublicationPreflight & { error: string }
      >;
      if (
        !response.ok ||
        !result.receiptId ||
        result.revisionId !== revisionRef.current.id ||
        result.bundleHash !== revisionRef.current.bundleHash ||
        !result.candidateHash ||
        !result.manifestHash ||
        !result.situationArtifactHash ||
        !result.baseReleaseId ||
        !result.baseManifestHash ||
        !result.expectedPointerGeneration ||
        !result.contractDigest ||
        !result.candidatePreview ||
        result.validationResult !== "PASSED" ||
        !result.validatedAt ||
        dirtyVersion.current !== validationVersion ||
        savedVersion.current !== validationVersion
      ) {
        setPreflight(null);
        setMessage(result.error ?? "Publication validation did not pass.");
        return;
      }
      const passed = result as PublicationPreflight;
      setPreflight(passed);
      setConfirmSubmit(true);
    } catch {
      setPreflight(null);
      setMessage(
        "Publication validation could not complete. Check the connection and try again.",
      );
    } finally {
      setPreflightPending(false);
    }
  }

  function updateMetadata<K extends keyof Metadata>(
    key: K,
    value: Metadata[K],
  ) {
    setBundle((current) => ({
      ...current,
      metadata: { ...current.metadata, [key]: value },
      ...(current.managedComponents && key === "primarySkill"
        ? {
            managedComponents: {
              ...current.managedComponents,
              preparedAction: {
                ...current.managedComponents.preparedAction,
                skill: String(value),
              },
            },
          }
        : {}),
    }));
    if (key === "primarySkill")
      updateManagedBodyAttribute("PreparedAction", "skill", String(value));
    markDirty();
  }

  function updateManagedBodyAttribute(
    component: "PracticeEmbed" | "PreparedAction",
    attribute: string,
    value: string,
  ) {
    setBodyTouched(true);
    if (rawMode) {
      setRawBody((current) =>
        replaceManagedAttribute(current, component, attribute, value),
      );
      return;
    }
    setSections((current) =>
      Object.fromEntries(
        Object.entries(current).map(([name, section]) => [
          name,
          replaceManagedAttribute(section, component, attribute, value),
        ]),
      ),
    );
  }

  function updatePracticeMetadata(
    key: "practiceId" | "practiceVariant",
    value: string,
  ) {
    setBundle((current) => {
      if (!current.managedComponents) return current;
      return {
        ...current,
        metadata: { ...current.metadata, [key]: value },
        managedComponents: {
          ...current.managedComponents,
          practiceEmbed: {
            ...current.managedComponents.practiceEmbed,
            [key === "practiceId" ? "practiceId" : "variant"]: value,
          },
        },
      };
    });
    updateManagedBodyAttribute(
      "PracticeEmbed",
      key === "practiceId" ? "practiceId" : "variant",
      value,
    );
    markDirty();
  }

  async function proposalRequest(
    url: string,
    method: "POST" | "PATCH",
    payload: Record<string, unknown>,
  ) {
    if (!checkout) return false;
    if (dirtyVersion.current !== savedVersion.current) {
      setMessage(
        "Save or discard your newer edits before deciding a pinned review suggestion.",
      );
      return false;
    }
    setMessage(null);
    const requestVersion = dirtyVersion.current;
    setProposalPending(true);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          ...payload,
          revisionId: revisionRef.current.id,
          bundleHash: revisionRef.current.bundleHash,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        authoritativeRevision?: AuthoritativeRevision;
      };
      if (!response.ok) {
        setMessage(result.error ?? "The agent suggestion could not be saved.");
        return false;
      }
      if (dirtyVersion.current !== requestVersion) {
        setSaveState("error");
        setMessage(
          "A newer local edit arrived while the suggestion was being applied. Copy that unsaved edit, then reload the authoritative revision before continuing.",
        );
        return false;
      }
      if (result.authoritativeRevision)
        adoptAuthoritativeRevision(result.authoritativeRevision);
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

  const changedSections = changedWorkspaceSections(
    sectionNames,
    productionBody,
    savedBody,
  );

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
              <span className="activityLabel">
                {globalRecoveryRequired &&
                publicationStatus?.state !== "RECOVERY_REQUIRED"
                  ? "Studio publication recovery required"
                  : publicationStatus?.state === "RECOVERY_REQUIRED"
                    ? "Publication recovery required"
                    : `Publishing${
                        publicationStatus?.currentStage
                          ? ` · ${publicationStatus.currentStage.displayName}`
                          : ""
                      }`}
              </span>
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
                    void mutate(`/api/reviews/${review.id}/cancel`, {
                      revisionId: review.inputRevisionId,
                      bundleHash: review.inputBundleHash,
                    })
                  }
                >
                  Cancel review
                </button>
              ) : review && reviewStatus?.state === "FAILED" ? (
                <>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={pending || publicationLocked}
                    onClick={() =>
                      void mutate(`/api/reviews/${review.id}/retry`, {
                        revisionId: review.inputRevisionId,
                        bundleHash: review.inputBundleHash,
                      })
                    }
                  >
                    Retry review
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={pending || publicationLocked}
                    onClick={() =>
                      void mutate(`/api/reviews/${review.id}/cancel`, {
                        revisionId: review.inputRevisionId,
                        bundleHash: review.inputBundleHash,
                        reason: "Editor stopped failed review",
                      })
                    }
                  >
                    Stop review and continue queue
                  </button>
                </>
              ) : (
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={pending || publicationLocked}
                  onClick={() =>
                    void mutate(
                      `/api/checkouts/${checkout.id}/review`,
                      { fence: checkout.fence },
                      {
                        saveFirst: true,
                        exactRevision: true,
                        forceCheckpoint: reviewRequiresForcedCheckpoint(
                          bundle.schemaVersion,
                        ),
                      },
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
                disabled={
                  pending ||
                  workspaceLocked ||
                  reviewLocked ||
                  preflightPending ||
                  saveState === "error" ||
                  !publicationBackup.ready
                }
                aria-describedby={
                  publicationBackup.ready ? undefined : "publicationBackupBlock"
                }
                onClick={() => void prepareProductionSubmission()}
              >
                {preflightPending
                  ? "Validating exact candidate…"
                  : "Submit to production"}
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

      {!publicationBackup.ready ? (
        <section
          id="publicationBackupBlock"
          className="publicationOutcome publicationOutcome-warning"
          role="status"
        >
          <strong>Production submission paused</strong>
          <span>
            {publicationBackup.message} Your saved draft and checkout are
            unaffected.
          </span>
        </section>
      ) : null}

      {globalRecoveryRequired &&
      publicationStatus?.state !== "RECOVERY_REQUIRED" ? (
        <section
          className="publicationOutcome publicationOutcome-error"
          role="alert"
        >
          <strong>Studio publication recovery required</strong>
          <span>
            The live Leadership identity for another publication is not
            verified. Editorial changes stay locked until an administrator
            restores and verifies a known release.
          </span>
        </section>
      ) : null}

      {publicationActive && publicationStatus?.currentStage ? (
        <section
          className="publicationProgress"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="publicationProgressCurrent">
            <div>
              <p className="cardEyebrow">Publishing to production</p>
              <strong>{publicationStatus.currentStage.displayName}</strong>
              <p>{publicationStatus.currentStage.description}</p>
            </div>
            <span>
              {publicationStatus.completedStages} of{" "}
              {publicationStatus.totalStages} steps complete
            </span>
          </div>
          <progress
            value={publicationStatus.completedStages}
            max={publicationStatus.totalStages}
            aria-label={`${publicationStatus.completedStages} of ${publicationStatus.totalStages} publication steps complete`}
          />
          <details>
            <summary>What happens during publishing?</summary>
            <ol>
              {publicationStatus.stages.map((stage) => (
                <li
                  key={stage.key}
                  className={`publicationStage publicationStage-${stage.state.toLowerCase()}`}
                >
                  <i aria-hidden="true">
                    {stage.state === "COMPLETE"
                      ? "✓"
                      : stage.state === "ACTIVE"
                        ? "•"
                        : stage.ordinal}
                  </i>
                  <span>
                    <strong>{stage.displayName}</strong>
                    <small>{stage.description}</small>
                  </span>
                </li>
              ))}
            </ol>
          </details>
        </section>
      ) : publicationStatus?.terminal &&
        publicationStatus.terminal.state !== "SUCCEEDED" &&
        checkout ? (
        <section
          className={`publicationOutcome publicationOutcome-${publicationStatus.terminal.tone.toLowerCase()}`}
          role="alert"
        >
          <strong>{publicationStatus.terminal.title}</strong>
          <span>{publicationStatus.terminal.message}</span>
          {publicationStatus.failure ? (
            <PublicationFailureEvidence
              failure={publicationStatus.failure}
              summary={
                publicationStatus.state === "RECOVERY_REQUIRED"
                  ? "Why live verification failed"
                  : "Why verification failed"
              }
              conclusion={
                publicationStatus.state === "RESTORED"
                  ? "The previous verified version is still live."
                  : publicationStatus.state === "RECOVERY_REQUIRED"
                    ? "Leadership's current live release identity is not verified."
                    : "Production was not changed."
              }
            />
          ) : null}
          {publicationStatus.recoveryFailure ? (
            <PublicationFailureEvidence
              failure={publicationStatus.recoveryFailure}
              summary="Why automatic recovery failed"
              conclusion="Leadership's current live release identity is not verified. An administrator must restore and verify a known release before editing resumes."
            />
          ) : null}
        </section>
      ) : null}

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
              {globalRecoveryRequired &&
              publicationStatus?.state !== "RECOVERY_REQUIRED" ? (
                <>
                  <strong>Studio publication recovery required.</strong> The
                  live Leadership identity for another publication is not
                  verified. Editing returns after an administrator restores and
                  verifies a known release.
                </>
              ) : publicationStatus?.state === "RECOVERY_REQUIRED" ? (
                <>
                  <strong>Publication recovery required.</strong> Editing
                  returns after an administrator restores and verifies a known
                  Leadership release.
                </>
              ) : (
                <>
                  <strong>
                    {publicationStatus?.currentStage?.displayName ??
                      "Publication in progress"}
                    .
                  </strong>{" "}
                  {publicationStatus?.currentStage?.description} Editing returns
                  when Leadership verification completes.
                </>
              )}
            </div>
          ) : reviewLocked ? (
            <div className="readOnlyBanner">
              <strong>
                {reviewStatus?.retry
                  ? `Review retrying ${reviewStatus.currentStage?.displayName ?? "the current stage"}.`
                  : "Draft pinned for review."}
              </strong>{" "}
              You can keep editing. Review remains pinned to revision{" "}
              {review?.inputRevisionId.slice(0, 8)} and cannot absorb later
              saves.
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
                {bundle.schemaVersion === "situation-bundle-v2" ? (
                  <>
                    <label>
                      <span>Intended runtime visibility</span>
                      <input value={bundle.visibility} readOnly />
                      <small>
                        Studio keeps this revision as a draft until you submit
                        it; this value is the exact Leadership publication
                        intent included in its hash.
                      </small>
                      {bundle.visibility === "UNPUBLISHED" ? (
                        <button
                          className="secondaryButton"
                          type="button"
                          disabled={!editable}
                          onClick={() => {
                            setBundle((current) => ({
                              ...current,
                              visibility: "PUBLIC",
                            }));
                            markDirty();
                          }}
                        >
                          Set public intent
                        </button>
                      ) : null}
                    </label>
                    <label>
                      <span>Practice ID</span>
                      <input
                        value={bundle.metadata.practiceId ?? ""}
                        readOnly
                        aria-describedby="practice-id-help"
                      />
                      <small id="practice-id-help">
                        Practice identity is bound to the exact context
                        relationship. Changing that relationship is currently
                        manual-only.
                      </small>
                    </label>
                    <label>
                      <span>Practice variant</span>
                      <input
                        value={bundle.metadata.practiceVariant ?? ""}
                        disabled={!editable}
                        onBlur={() => void save()}
                        onChange={(event) =>
                          updatePracticeMetadata(
                            "practiceVariant",
                            event.target.value,
                          )
                        }
                      />
                    </label>
                    <label className="fieldWide">
                      <span>Source reference IDs (one per line)</span>
                      <textarea
                        rows={3}
                        value={(bundle.metadata.sourceReferences ?? []).join(
                          "\n",
                        )}
                        disabled={!editable}
                        onBlur={() => void save()}
                        onChange={(event) =>
                          updateMetadata(
                            "sourceReferences",
                            event.target.value
                              .split("\n")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          )
                        }
                      />
                    </label>
                    <label className="fieldWide">
                      <span>Related situation IDs (one per line)</span>
                      <textarea
                        rows={3}
                        value={(bundle.metadata.relatedSituationIds ?? []).join(
                          "\n",
                        )}
                        disabled={!editable}
                        onBlur={() => void save()}
                        onChange={(event) =>
                          updateMetadata(
                            "relatedSituationIds",
                            event.target.value
                              .split("\n")
                              .map((value) => value.trim())
                              .filter(Boolean),
                          )
                        }
                      />
                    </label>
                    <div className="fieldWide contractIdentity" role="note">
                      <span>Publication contract</span>
                      <strong>
                        Human approved · field note present · safety note
                        present
                      </strong>
                      <small>
                        These authoritative flags are validated with the MDX
                        component properties on every save and preflight.
                      </small>
                    </div>
                  </>
                ) : (
                  <div className="fieldWide contractIdentity" role="note">
                    <span>Legacy draft</span>
                    <strong>Synchronization required on next save</strong>
                    <small>
                      Studio will import the omitted authoritative fields from
                      this draft&apos;s exact Leadership base before recording a
                      v2 revision.
                    </small>
                  </div>
                )}
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
                      setSections(
                        parseWorkspaceSections(sectionNames, rawBody),
                      );
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
                      setBodyTouched(true);
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
                            setBodyTouched(true);
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
            <div
              className="previewFrame"
              role="region"
              aria-label="Draft preview"
              tabIndex={0}
            >
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
                        : reviewStatus.state === "QUEUED" &&
                            reviewStatus.laneState === "WAITING"
                          ? "waiting"
                          : reviewStatus.state.toLowerCase()
                    }`}
                  >
                    {reviewStatus.retry
                      ? "RETRYING"
                      : reviewStatus.state === "QUEUED" &&
                          reviewStatus.laneState === "WAITING"
                        ? "WAITING"
                        : reviewStatus.state}
                  </span>
                  <strong>{reviewStatus.totalStages}-stage agent review</strong>
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
                      {reviewStatus.laneState === "FOCUSED" ? (
                        <i
                          className="reviewActivityIndicator"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span>
                        {reviewStatus.laneState === "WAITING"
                          ? "Waiting for the focused review to finish. This review will not start early."
                          : reviewStatus.retry
                            ? "This review keeps the review lane. No later review will start during the retry wait."
                            : liveReview.connection === "reconnecting"
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
                        {reviewStatus.failure?.title ??
                          SAFE_REVIEW_FAILURE_LABELS[
                            reviewStatus.retry.failureClass
                          ]}
                        {" · "}
                        attempt {reviewStatus.retry.attempt} of{" "}
                        {reviewStatus.retry.maximumAttempts}
                      </span>
                      {reviewStatus.failure?.explanation ? (
                        <span>{reviewStatus.failure.explanation}</span>
                      ) : null}
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
                        {reviewStatus.failure?.title ??
                          (reviewStatus.terminal?.failureClass
                            ? SAFE_REVIEW_FAILURE_LABELS[
                                reviewStatus.terminal.failureClass
                              ]
                            : "Review processing stopped")}
                      </span>
                      {reviewStatus.failure?.explanation ? (
                        <span>{reviewStatus.failure.explanation}</span>
                      ) : null}
                      <span>
                        {reviewStatus.laneState === "FOCUSED"
                          ? "The review queue is paused here. Retry this review, or stop it to continue with the next review."
                          : "Retry this review when you are ready."}
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
                currentRevisionId={currentRevision.id}
                currentBundleHash={currentRevision.bundleHash}
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
                  draft={savedBody}
                  productionRevision={shortHash(situation.productionBundleHash)}
                />
                <details className="diffDisclosure">
                  <summary>Production source diff</summary>
                  <SynchronizedDiff
                    production={productionBody}
                    draft={savedBody}
                  />
                </details>
              </details>
            </>
          ) : (
            <>
              <RenderedComparison
                production={productionBody}
                draft={savedBody}
                productionRevision={shortHash(situation.productionBundleHash)}
              />
              <details className="diffDisclosure" open>
                <summary>Exact source diff</summary>
                <SynchronizedDiff
                  production={productionBody}
                  draft={savedBody}
                />
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
                    setScopedEdit({ item, body: item.body });
                  }}
                >
                  {item.hasVariant ? "Edit this variant" : "Create scoped edit"}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {scopedEdit && checkout ? (
        <div className="dialogBackdrop" role="presentation">
          <div
            className="confirmationDialog scopedArtifactDialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scoped-edit-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setScopedEdit(null);
              }
            }}
          >
            <p className="cardEyebrow">
              {scopedEdit.item.hasVariant
                ? "Situation-scoped variant"
                : "New situation-scoped variant"}
            </p>
            <h2 id="scoped-edit-title">
              {scopedEdit.item.hasVariant ? "Edit" : "Create"}{" "}
              {scopedEdit.item.kind.toLowerCase()} content
            </h2>
            <p>
              Enter the complete replacement content. Practice and source
              artifacts use JSON and are validated before the draft is saved.
            </p>
            <label htmlFor="scoped-edit-body">Complete replacement</label>
            <textarea
              id="scoped-edit-body"
              autoFocus
              spellCheck={false}
              value={scopedEdit.body}
              onChange={(event) =>
                setScopedEdit((current) =>
                  current ? { ...current, body: event.target.value } : current,
                )
              }
            />
            <div className="dialogActions">
              <button
                className="secondaryButton"
                type="button"
                onClick={() => setScopedEdit(null)}
              >
                Cancel
              </button>
              <button
                className="primaryButton"
                type="button"
                disabled={pending || !scopedEdit.body.trim()}
                onClick={() => {
                  const { item, body: changedBody } = scopedEdit;
                  setScopedEdit(null);
                  void mutate(`/api/checkouts/${checkout.id}/variants`, {
                    fence: checkout.fence,
                    originalLogicalId: item.logicalId,
                    originalContentHash: item.contentHash,
                    kind: item.kind,
                    changedBody,
                  });
                }}
              >
                Save scoped variant
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmSubmit && checkout && preflight ? (
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
                <dd className="validationPass">Validation passed</dd>
              </div>
              <div>
                <dt>Exact publication intent</dt>
                <dd>{preflight.candidatePreview.visibility}</dd>
              </div>
              <div>
                <dt>Practice</dt>
                <dd>
                  {preflight.candidatePreview.managedComponents?.practiceEmbed
                    .practiceId ?? "None"}
                  {preflight.candidatePreview.managedComponents?.practiceEmbed
                    .variant
                    ? ` · ${preflight.candidatePreview.managedComponents.practiceEmbed.variant}`
                    : ""}
                </dd>
              </div>
              <div>
                <dt>Candidate</dt>
                <dd>
                  <code>{shortHash(preflight.candidateHash)}</code>
                </dd>
              </div>
              <div>
                <dt>Leadership base</dt>
                <dd>
                  <code>{shortHash(preflight.baseManifestHash)}</code> · gen{" "}
                  {preflight.expectedPointerGeneration}
                </dd>
              </div>
            </dl>
            <details className="candidatePreview">
              <summary>Review the exact compiled candidate</summary>
              <p>
                Canonical MDX hash:{" "}
                <code>{shortHash(preflight.candidatePreview.bodyMdxHash)}</code>
                {" · "}
                {preflight.candidatePreview.relationships.length} relationships
                {" · "}
                {preflight.candidatePreview.scopedArtifacts.length} scoped
                artifacts
              </p>
              <h3>Complete compiled projection</h3>
              <pre>{JSON.stringify(preflight.candidatePreview, null, 2)}</pre>
            </details>
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
                      preflightReceiptId: preflight.receiptId,
                      candidateHash: preflight.candidateHash,
                    },
                    { exactRevision: true },
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
