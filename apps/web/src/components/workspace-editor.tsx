"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ReauthenticationDialog } from "@/components/reauthentication-dialog";
import { RenderedGuidance } from "@/components/rendered-guidance";
import { SynchronizedDiff } from "@/components/synchronized-diff";

type Props = {
  situationId: string;
  draftId: string | null;
  checkout: {
    id: string;
    fencingToken: string;
    holderUserId: string | null;
    custody: string;
  } | null;
  userId: string;
  artifact: { id: string; body: string } | null;
  displayedArtifactState: "PUBLISHED" | "DRAFT" | "PROPOSAL";
  publishedBody: string | null;
  revision: number | null;
  csrfToken: string;
  bundle: {
    id: string;
    state: string;
    canonicalHash: string;
    repositoryReviewerId: string | null;
    provenanceReady: boolean;
    preparedReviewDate: string | null;
    artifacts: {
      id: string;
      logicalId: string;
      path: string;
      changeKind: string;
      candidateHash: string;
      body: string;
    }[];
    comments: { id: string; body: string; blocking: boolean }[];
  } | null;
  approvalId: string | null;
  publicationRequest: {
    id: string;
    state: string;
    previewCommitSha: string | null;
    finalConfirmed: boolean;
  } | null;
  permissions: string[];
  lifecycle: string;
  rollbackTarget: { id: string; commitSha: string } | null;
  rollbackRequest: { id: string; state: string; currentStep: string } | null;
};

export function WorkspaceEditor(props: Props) {
  const ownsCheckout =
    props.checkout?.holderUserId === props.userId &&
    props.checkout.custody === "USER";
  const canEdit = Boolean(
    ownsCheckout &&
    props.permissions.includes("draft.update") &&
    props.draftId &&
    props.artifact &&
    props.revision !== null &&
    props.displayedArtifactState === "DRAFT",
  );
  const [body, setBody] = useState(props.artifact?.body ?? "");
  const [checkInPending, setCheckInPending] = useState(false);
  const [preparationPending, setPreparationPending] = useState(false);
  const [reauthenticationRequest, setReauthenticationRequest] = useState<{
    actionLabel: string;
    retry: () => Promise<void>;
  } | null>(null);
  const hasUnsavedChanges = body !== (props.artifact?.body ?? "");
  const [status, setStatus] = useState(
    canEdit
      ? `Draft revision ${props.revision} · ready to edit`
      : props.displayedArtifactState === "PUBLISHED"
        ? "Published baseline · read-only"
        : `${props.displayedArtifactState === "PROPOSAL" ? "Proposal" : "Draft"} candidate revision ${props.revision} · read-only · not published`,
  );
  const [view, setView] = useState<"guidance" | "source">("guidance");
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const expandSourceButtonRef = useRef<HTMLButtonElement>(null);
  const closeSourceButtonRef = useRef<HTMLButtonElement>(null);
  const sourcePanelRef = useRef<HTMLDivElement>(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [lifecycleAttempted, setLifecycleAttempted] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [blockingComment, setBlockingComment] = useState(true);
  const lifecycleReasonError =
    lifecycleAttempted && archiveReason.trim().length < 8
      ? "Enter a specific reason of at least 8 characters."
      : "";
  const closeExpandedSource = useCallback(() => {
    setSourceExpanded(false);
    window.requestAnimationFrame(() => expandSourceButtonRef.current?.focus());
  }, []);

  async function requestReauthentication(
    response: Response,
    actionLabel: string,
    retry: () => Promise<void>,
  ): Promise<boolean> {
    if (response.status !== 403) return false;
    const result = (await response
      .clone()
      .json()
      .catch(() => null)) as { error?: string } | null;
    if (result?.error !== "recent reauthentication required") return false;
    setStatus("Confirm your password to continue this sensitive action.");
    setReauthenticationRequest({ actionLabel, retry });
    return true;
  }

  useEffect(() => {
    if (!ownsCheckout || !props.checkout) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(
        `/api/checkouts/${props.checkout?.id}/heartbeat`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": props.csrfToken,
          },
          body: JSON.stringify({ fencingToken: props.checkout?.fencingToken }),
        },
      );
      if (!response.ok)
        setStatus(
          "Checkout expired or transferred — reload to continue read-only",
        );
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [ownsCheckout, props.checkout, props.csrfToken]);

  useEffect(() => {
    if (!sourceExpanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeSourceButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeExpandedSource();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        sourcePanelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeExpandedSource, sourceExpanded]);

  async function checkout() {
    setStatus("Acquiring exclusive checkout…");
    const response = await fetch(
      `/api/situations/${props.situationId}/checkout`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": props.csrfToken,
        },
        body: JSON.stringify({ mode: "EDITING" }),
      },
    );
    if (response.ok) location.reload();
    else
      setStatus(
        response.status === 423
          ? "Another user owns this checkout."
          : "Checkout failed.",
      );
  }

  async function save() {
    if (
      !props.draftId ||
      !props.checkout ||
      !props.artifact ||
      props.revision === null
    )
      return;
    setStatus("Saving revision…");
    const response = await fetch(`/api/drafts/${props.draftId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": props.csrfToken,
        "if-match": `"draft-${props.draftId}-${props.revision}"`,
      },
      body: JSON.stringify({
        checkoutId: props.checkout.id,
        fencingToken: props.checkout.fencingToken,
        clientMutationId: crypto.randomUUID(),
        artifactId: props.artifact.id,
        body,
      }),
    });
    if (response.ok) {
      const result = (await response.json()) as { revision: number };
      setStatus(`Saved immutable revision ${result.revision}`);
      location.reload();
    } else
      setStatus(
        response.status === 409
          ? "A newer revision exists. Reload before saving."
          : response.status === 423
            ? "Checkout expired or transferred."
            : "Save failed.",
      );
  }

  async function checkIn() {
    if (!ownsCheckout || !props.checkout) return;
    if (
      hasUnsavedChanges &&
      !window.confirm(
        "Check in and discard your unsaved source changes? Saved revisions will remain available.",
      )
    ) {
      setStatus("Check-in cancelled · your checkout remains active");
      return;
    }

    setCheckInPending(true);
    setStatus("Checking in and releasing the exclusive checkout…");
    const response = await fetch(
      `/api/checkouts/${props.checkout.id}/release`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": props.csrfToken,
        },
        body: JSON.stringify({ fencingToken: props.checkout.fencingToken }),
      },
    );
    if (response.ok) location.reload();
    else {
      setCheckInPending(false);
      setStatus(
        response.status === 423
          ? "Checkout expired or transferred · reload to see the current owner"
          : "Check-in failed · your checkout remains active",
      );
    }
  }

  async function review() {
    if (!props.draftId || !props.checkout) return;
    setStatus("Creating durable complete-review job…");
    const response = await fetch("/api/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": props.csrfToken,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        situationId: props.situationId,
        draftId: props.draftId,
        checkoutId: props.checkout.id,
        fencingToken: props.checkout.fencingToken,
      }),
    });
    if (response.ok) location.reload();
    else
      setStatus(
        "Review could not start. Check provider mode and checkout state.",
      );
  }

  async function approve() {
    if (!props.bundle) return;
    setStatus("Approving exact validated bundle…");
    const response = await fetch(`/api/bundles/${props.bundle.id}/approve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": props.csrfToken,
      },
      body: "{}",
    });
    if (
      await requestReauthentication(
        response,
        "approve this exact bundle",
        approve,
      )
    )
      return;
    if (response.ok) location.reload();
    else
      setStatus(
        "Approval was blocked by permissions, reauthentication, comments, validation, or staleness.",
      );
  }

  async function prepareApproval() {
    if (!props.bundle) return;
    setPreparationPending(true);
    setStatus("Writing your reviewer identity into a new exact bundle…");
    const response = await fetch(
      `/api/bundles/${props.bundle.id}/prepare-approval`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": props.csrfToken,
        },
        body: "{}",
      },
    );
    if (
      await requestReauthentication(
        response,
        "prepare this exact bundle for approval",
        prepareApproval,
      )
    ) {
      setPreparationPending(false);
      return;
    }
    if (response.ok) location.reload();
    else {
      const result = (await response.json()) as { error?: string };
      setPreparationPending(false);
      setStatus(
        result.error ??
          "Approval preparation was blocked by identity, validation, or staleness.",
      );
    }
  }

  async function stage() {
    if (!props.bundle || !props.approvalId) return;
    setStatus("Staging the exact approved bundle…");
    const response = await fetch("/api/publications", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": props.csrfToken,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        bundleId: props.bundle.id,
        approvalId: props.approvalId,
        target: "protected-beta",
      }),
    });
    if (
      await requestReauthentication(response, "stage this exact bundle", stage)
    )
      return;
    if (response.ok) location.reload();
    else
      setStatus(
        "Staging unavailable. Production publisher credentials are never used by the web process.",
      );
  }

  async function confirmPublication() {
    if (!props.publicationRequest) return;
    setStatus("Confirming previewed commit and promoting the exact release…");
    const response = await fetch(
      `/api/publications/${props.publicationRequest.id}/confirm`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": props.csrfToken,
        },
        body: "{}",
      },
    );
    if (
      await requestReauthentication(
        response,
        "publish this reviewed bundle",
        confirmPublication,
      )
    )
      return;
    if (response.ok) location.reload();
    else setStatus("Final publication confirmation failed.");
  }

  const publicationPending =
    props.publicationRequest &&
    ![
      "AWAITING_CONFIRMATION",
      "FAILED_PREVIEW",
      "RECONCILIATION_REQUIRED",
      "RECONCILED",
    ].includes(props.publicationRequest.state);

  async function changeLifecycle(
    action: "ARCHIVE" | "RESTORE",
    alreadyConfirmed = false,
  ) {
    setLifecycleAttempted(true);
    const reason = archiveReason.trim();
    if (reason.length < 8) {
      setStatus("A specific lifecycle reason is required before this action.");
      return;
    }
    const confirmed =
      alreadyConfirmed ||
      window.confirm(
        action === "ARCHIVE"
          ? "Archive this situation? It will leave the active inventory until restored."
          : "Restore this situation to its previous lifecycle state?",
      );
    if (!confirmed) {
      setStatus("Lifecycle change cancelled. No request was sent.");
      return;
    }
    setStatus(`${action === "ARCHIVE" ? "Archiving" : "Restoring"} situation…`);
    const response = await fetch(
      `/api/situations/${props.situationId}/lifecycle`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": props.csrfToken,
        },
        body: JSON.stringify({
          action,
          reason,
        }),
      },
    );
    if (
      await requestReauthentication(
        response,
        `${action === "ARCHIVE" ? "archive" : "restore"} this situation`,
        () => changeLifecycle(action, true),
      )
    )
      return;
    if (response.ok) location.reload();
    else
      setStatus(
        "Lifecycle change was blocked by permissions, reauthentication, an active checkout, or a missing reason.",
      );
  }

  async function rollback() {
    if (!props.rollbackTarget) return;
    setStatus("Rolling back to the selected verified publication…");
    const response = await fetch(
      `/api/publications/${props.rollbackTarget.id}/rollback`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": props.csrfToken,
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          reason:
            "Operator rollback from the Situation Studio history control.",
        }),
      },
    );
    if (
      await requestReauthentication(
        response,
        "roll back to this prior release",
        rollback,
      )
    )
      return;
    if (response.ok) location.reload();
    else
      setStatus(
        "Rollback was blocked by permissions, reauthentication, or the publisher boundary.",
      );
  }

  async function addComment() {
    if (!props.bundle || !commentBody.trim()) return;
    setStatus("Adding review comment…");
    const response = await fetch(`/api/bundles/${props.bundle.id}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": props.csrfToken,
      },
      body: JSON.stringify({ body: commentBody, blocking: blockingComment }),
    });
    if (response.ok) location.reload();
    else setStatus("Comment could not be added.");
  }

  async function resolveComment(commentId: string) {
    setStatus("Resolving review comment…");
    const response = await fetch(`/api/comments/${commentId}/resolve`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": props.csrfToken,
      },
      body: JSON.stringify({
        resolution: "Resolved during exact-bundle review.",
      }),
    });
    if (response.ok) location.reload();
    else setStatus("Comment could not be resolved.");
  }

  return (
    <section className="panel editorPanel">
      <div className="panelHeader">
        <h2>
          {props.displayedArtifactState === "PUBLISHED"
            ? "Guidance"
            : props.displayedArtifactState === "PROPOSAL"
              ? "Proposal candidate"
              : "Draft candidate"}
        </h2>
      </div>
      <div className="panelBody">
        <div className="saveBar primaryActionBar">
          <span role="status" aria-live="polite">
            {status}
          </span>
          <div className="workspaceActions">
            {!props.checkout &&
              props.permissions.includes("draft.update") &&
              props.lifecycle !== "ARCHIVED" && (
                <button className="button" type="button" onClick={checkout}>
                  Check out for editing
                </button>
              )}
            {canEdit && (
              <button
                className="button"
                type="button"
                onClick={save}
                disabled={checkInPending}
              >
                Save revision
              </button>
            )}
            {ownsCheckout && (
              <button
                className="button secondary"
                type="button"
                onClick={checkIn}
                disabled={checkInPending}
                title="Release the checkout while preserving saved draft revisions"
              >
                {checkInPending ? "Checking in…" : "Check in"}
              </button>
            )}
            {ownsCheckout &&
              props.permissions.includes("ai.run") &&
              !props.bundle && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={review}
                  disabled={checkInPending}
                >
                  Run complete review
                </button>
              )}
            {props.bundle?.state === "HUMAN_REVIEW" &&
              props.permissions.includes("publication.approve") &&
              (props.bundle.provenanceReady ? (
                <button
                  className="button"
                  type="button"
                  onClick={approve}
                  disabled={props.bundle.comments.some(
                    (comment) => comment.blocking,
                  )}
                  title={
                    props.bundle.comments.some((comment) => comment.blocking)
                      ? "Resolve blocking comments before approval"
                      : "Approve this exact validated bundle"
                  }
                >
                  Approve exact bundle
                </button>
              ) : (
                <button
                  className="button"
                  type="button"
                  onClick={prepareApproval}
                  disabled={
                    preparationPending || !props.bundle.repositoryReviewerId
                  }
                  title={
                    props.bundle.repositoryReviewerId
                      ? "Create a new immutable bundle with your repository reviewer identity and rerun exact-byte validation"
                      : "An administrator must map this account to a repository reviewer identity"
                  }
                >
                  {preparationPending
                    ? "Preparing exact bundle…"
                    : props.bundle.repositoryReviewerId
                      ? "Prepare exact bundle for my approval"
                      : "Reviewer identity required"}
                </button>
              ))}
            {props.bundle?.state === "APPROVED" &&
              props.permissions.includes("publication.publish") &&
              !props.publicationRequest && (
                <button className="button warn" type="button" onClick={stage}>
                  Stage approved bundle
                </button>
              )}
            {props.publicationRequest?.state === "AWAITING_CONFIRMATION" &&
              !props.publicationRequest.finalConfirmed &&
              props.permissions.includes("publication.publish") && (
                <button
                  className="button warn"
                  type="button"
                  onClick={confirmPublication}
                >
                  Publish this reviewed bundle
                </button>
              )}
            {publicationPending && (
              <button
                className="button secondary"
                type="button"
                onClick={() => location.reload()}
              >
                Refresh publication status
              </button>
            )}
          </div>
        </div>

        {props.publicationRequest && (
          <p className="artifactStateNotice candidate" role="status">
            {props.publicationRequest.state === "AWAITING_CONFIRMATION"
              ? props.publicationRequest.finalConfirmed
                ? "Final confirmation recorded. The trusted publisher is promoting the exact previewed release."
                : "Preview verified. Inspect the protected preview, then explicitly publish this exact commit."
              : props.publicationRequest.state === "FAILED_PREVIEW"
                ? "Preview staging failed before cutover. The live release is unchanged and your checkout has been returned."
                : props.publicationRequest.state === "RECONCILIATION_REQUIRED"
                  ? "Cutover needs reconciliation. Further publication is blocked until Git, the live marker, and Studio agree."
                  : props.publicationRequest.state === "RECONCILED"
                    ? "Publication reconciled against the live release marker."
                    : `Publisher stage: ${props.publicationRequest.state.toLowerCase().replaceAll("_", " ")}.`}{" "}
            {props.publicationRequest.previewCommitSha && (
              <>
                Candidate commit{" "}
                <code>
                  {props.publicationRequest.previewCommitSha.slice(0, 12)}
                </code>
                .{" "}
                {props.publicationRequest.state === "AWAITING_CONFIRMATION" &&
                  !props.publicationRequest.finalConfirmed && (
                    <a
                      href="https://leadership-preview.timsprototypes.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open protected preview
                    </a>
                  )}
              </>
            )}
          </p>
        )}
        {props.rollbackRequest && (
          <p className="artifactStateNotice candidate" role="status">
            {props.rollbackRequest.state === "RECONCILED"
              ? "Rollback reconciled. The selected prior tree is live as a new audited publication."
              : props.rollbackRequest.state === "FAILED_PREVIEW"
                ? "Rollback preview failed before cutover. The live release is unchanged."
                : props.rollbackRequest.state === "RECONCILIATION_REQUIRED"
                  ? "Rollback cutover needs reconciliation before another publication action."
                  : `Rollback in progress: ${props.rollbackRequest.currentStep.toLowerCase().replaceAll("_", " ")}.`}
          </p>
        )}

        <p
          className={`artifactStateNotice ${
            props.displayedArtifactState === "PUBLISHED"
              ? "published"
              : "candidate"
          }`}
        >
          {props.displayedArtifactState === "PUBLISHED"
            ? "Published guidance · this rendered view and Source MDX are the live baseline."
            : props.displayedArtifactState === "PROPOSAL"
              ? `Exact proposal bundle ${props.bundle?.canonicalHash.slice(0, 12) ?? "unavailable"} · revision ${props.revision} · not published.${props.bundle?.provenanceReady ? ` Reviewer ${props.bundle.repositoryReviewerId} · review date ${props.bundle.preparedReviewDate}.` : " Reviewer provenance must be finalized before approval."} The published baseline remains separate below.`
              : `Draft candidate revision ${props.revision} · not published. The published baseline remains separate below.`}
        </p>

        <div className="viewToolbar">
          <div aria-label="Guidance view" className="viewTabs" role="tablist">
            <button
              aria-controls="guidance-view"
              aria-selected={view === "guidance"}
              className={view === "guidance" ? "active" : undefined}
              id="guidance-tab"
              role="tab"
              type="button"
              onClick={() => setView("guidance")}
            >
              Rendered guidance
            </button>
            <button
              aria-controls="source-view"
              aria-selected={view === "source"}
              className={view === "source" ? "active" : undefined}
              id="source-tab"
              role="tab"
              type="button"
              onClick={() => setView("source")}
            >
              Source MDX
            </button>
          </div>
          {view === "source" && !sourceExpanded && (
            <button
              ref={expandSourceButtonRef}
              className="button secondary compactButton"
              type="button"
              onClick={() => setSourceExpanded(true)}
            >
              Expand source
            </button>
          )}
        </div>

        {view === "guidance" ? (
          <div
            aria-labelledby="guidance-tab"
            id="guidance-view"
            role="tabpanel"
            tabIndex={0}
          >
            <RenderedGuidance body={body} />
          </div>
        ) : (
          <div
            ref={sourcePanelRef}
            aria-label={sourceExpanded ? "Expanded Source MDX" : undefined}
            aria-labelledby={sourceExpanded ? undefined : "source-tab"}
            aria-modal={sourceExpanded || undefined}
            className={`sourcePanel ${sourceExpanded ? "expanded" : ""}`}
            id="source-view"
            role={sourceExpanded ? "dialog" : "tabpanel"}
          >
            {sourceExpanded && (
              <header className="expandedSourceHeader">
                <div>
                  <p className="eyebrow">Exact artifact bytes</p>
                  <h2>Source MDX</h2>
                </div>
                <button
                  ref={closeSourceButtonRef}
                  className="button secondary"
                  type="button"
                  onClick={closeExpandedSource}
                >
                  Close expanded source
                </button>
              </header>
            )}
            <label className="field" htmlFor="situation-source">
              <span className="srOnly">Situation MDX</span>
              <textarea
                className="sourceTextarea"
                id="situation-source"
                value={body}
                onChange={(event) => {
                  const nextBody = event.target.value;
                  setBody(nextBody);
                  setStatus(
                    nextBody === (props.artifact?.body ?? "")
                      ? `Draft revision ${props.revision} · ready to edit`
                      : "Unsaved draft changes · save them or check in to discard them",
                  );
                }}
                readOnly={!canEdit}
              />
            </label>
          </div>
        )}
        {props.publishedBody !== null && props.publishedBody !== body && (
          <details className="diffPanel">
            <summary>
              Compare published and {props.displayedArtifactState.toLowerCase()}{" "}
              bytes
            </summary>
            <SynchronizedDiff
              candidate={body}
              candidateLabel={
                props.displayedArtifactState === "PROPOSAL"
                  ? "Exact proposal"
                  : "Draft revision"
              }
              published={props.publishedBody}
            />
          </details>
        )}
        {props.bundle && (
          <details className="panel exactBundlePanel">
            <summary>
              <span>
                <strong>Inspect every exact bundle artifact</strong>
                <small>
                  {props.bundle.artifacts.length} immutable candidate
                  {props.bundle.artifacts.length === 1 ? "" : "s"} bound to the
                  displayed bundle hash
                </small>
              </span>
              <span className="badge">
                {
                  props.bundle.artifacts.filter(
                    (artifact) => artifact.changeKind !== "NO_CHANGE",
                  ).length
                }{" "}
                changed
              </span>
            </summary>
            <div className="panelBody exactBundleArtifacts">
              {props.bundle.artifacts.map((artifact) => (
                <details key={artifact.id}>
                  <summary>
                    <span>
                      <strong>{artifact.path}</strong>
                      <small>
                        {artifact.logicalId} ·{" "}
                        {artifact.changeKind.toLowerCase()}
                      </small>
                    </span>
                    <code>{artifact.candidateHash.slice(0, 12)}…</code>
                  </summary>
                  <pre>{artifact.body}</pre>
                </details>
              ))}
            </div>
          </details>
        )}
        {props.bundle && props.permissions.includes("proposal.review") && (
          <section className="commentPanel">
            <h3>Bundle review comments</h3>
            {props.bundle.comments.length ? (
              <ul className="timeline">
                {props.bundle.comments.map((comment) => (
                  <li key={comment.id}>
                    <div>
                      <strong>{comment.blocking ? "Blocking" : "Note"}</strong>
                      <br />
                      {comment.body}
                    </div>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => resolveComment(comment.id)}
                    >
                      Resolve
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">No open comments.</p>
            )}
            <label className="field">
              New comment
              <textarea
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
              />
            </label>
            <label className="confirmation">
              <input
                type="checkbox"
                checked={blockingComment}
                onChange={(event) => setBlockingComment(event.target.checked)}
              />
              <span>Block approval until this comment is resolved.</span>
            </label>
            <button
              className="button secondary"
              type="button"
              onClick={addComment}
            >
              Add review comment
            </button>
          </section>
        )}
        {props.permissions.includes("situation.archive") && !props.checkout && (
          <section className="dangerArea" aria-labelledby="lifecycle-heading">
            <div>
              <p className="eyebrow">Separated destructive action</p>
              <h3 id="lifecycle-heading">
                {props.lifecycle === "ARCHIVED"
                  ? "Restore situation"
                  : "Archive situation"}
              </h3>
              <p>
                {props.lifecycle === "ARCHIVED"
                  ? "Restoration returns this situation to its previous lifecycle state and records the reason."
                  : "Archiving removes this situation from active use without deleting its published history."}
              </p>
            </div>
            <label className="field" htmlFor="lifecycle-reason">
              Required reason
              <span className="fieldHelp" id="lifecycle-reason-help">
                Enter at least 8 characters. You will confirm before any request
                is sent.
              </span>
              <input
                id="lifecycle-reason"
                value={archiveReason}
                onChange={(event) => {
                  setArchiveReason(event.target.value);
                  if (lifecycleAttempted) setLifecycleAttempted(true);
                }}
                onBlur={() => setLifecycleAttempted(true)}
                placeholder={
                  props.lifecycle === "ARCHIVED"
                    ? "Reason for restoration"
                    : "Required reason for archive"
                }
                required
                minLength={8}
                maxLength={500}
                aria-describedby={`lifecycle-reason-help${lifecycleReasonError ? " lifecycle-reason-error" : ""}`}
                aria-invalid={lifecycleReasonError ? true : undefined}
              />
              {lifecycleReasonError && (
                <span className="fieldError" id="lifecycle-reason-error">
                  {lifecycleReasonError}
                </span>
              )}
            </label>
            <button
              className={
                props.lifecycle === "ARCHIVED"
                  ? "button secondary"
                  : "button warn"
              }
              type="button"
              disabled={archiveReason.trim().length < 8}
              onClick={() =>
                changeLifecycle(
                  props.lifecycle === "ARCHIVED" ? "RESTORE" : "ARCHIVE",
                )
              }
            >
              {props.lifecycle === "ARCHIVED"
                ? "Restore situation"
                : "Archive situation"}
            </button>
          </section>
        )}
        {props.rollbackTarget &&
          props.permissions.includes("publication.publish") &&
          !props.checkout && (
            <div className="lifecycleBar">
              <span>
                Prior verified publication{" "}
                <code>{props.rollbackTarget.commitSha.slice(0, 8)}</code>
              </span>
              <button className="button warn" type="button" onClick={rollback}>
                Rollback to prior release
              </button>
            </div>
          )}
      </div>
      {reauthenticationRequest && (
        <ReauthenticationDialog
          actionLabel={reauthenticationRequest.actionLabel}
          csrfToken={props.csrfToken}
          onCancel={() => {
            setPreparationPending(false);
            setReauthenticationRequest(null);
            setStatus("Sensitive action cancelled. No change was made.");
          }}
          onReauthenticated={async () => {
            const request = reauthenticationRequest;
            setReauthenticationRequest(null);
            await request.retry();
          }}
        />
      )}
    </section>
  );
}
