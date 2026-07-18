"use client";

import { useEffect, useState } from "react";

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
  publishedBody: string | null;
  revision: number | null;
  csrfToken: string;
  bundle: {
    id: string;
    state: string;
    comments: { id: string; body: string; blocking: boolean }[];
  } | null;
  approvalId: string | null;
  publicationRequest: { id: string; state: string } | null;
  permissions: string[];
  lifecycle: string;
  rollbackTarget: { id: string; commitSha: string } | null;
};

export function WorkspaceEditor(props: Props) {
  const [body, setBody] = useState(props.artifact?.body ?? "");
  const [status, setStatus] = useState("All saved");
  const [archiveReason, setArchiveReason] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [blockingComment, setBlockingComment] = useState(true);
  const ownsCheckout =
    props.checkout?.holderUserId === props.userId &&
    props.checkout.custody === "USER";
  const canEdit =
    ownsCheckout &&
    props.permissions.includes("draft.update") &&
    props.draftId &&
    props.artifact &&
    props.revision !== null;

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
    if (response.ok) location.reload();
    else
      setStatus(
        "Approval was blocked by permissions, reauthentication, comments, validation, or staleness.",
      );
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
    if (response.ok) location.reload();
    else setStatus("Final publication confirmation failed.");
  }

  async function changeLifecycle(action: "ARCHIVE" | "RESTORE") {
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
          reason:
            archiveReason ||
            (action === "RESTORE" ? "Restored for renewed use." : ""),
        }),
      },
    );
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
        <h2>Situation artifact</h2>
      </div>
      <div className="panelBody">
        <label className="field">
          <span className="srOnly">Situation MDX</span>
          <textarea
            value={body}
            onChange={(event) => {
              setBody(event.target.value);
              setStatus("Unsaved changes");
            }}
            readOnly={!canEdit}
          />
        </label>
        {props.publishedBody !== null && props.publishedBody !== body && (
          <details className="diffPanel">
            <summary>Compare published and draft bytes</summary>
            <div className="diffGrid">
              <section>
                <h3>Published</h3>
                <pre>{props.publishedBody}</pre>
              </section>
              <section>
                <h3>Draft revision</h3>
                <pre>{body}</pre>
              </section>
            </div>
          </details>
        )}
        <div className="saveBar">
          <span role="status" aria-live="polite">
            {status}
          </span>
          <div className="workspaceActions">
            {!props.checkout &&
              props.permissions.includes("draft.update") &&
              props.lifecycle !== "ARCHIVED" && (
                <button className="button secondary" onClick={checkout}>
                  Check out for editing
                </button>
              )}
            {canEdit && (
              <button className="button" onClick={save}>
                Save revision
              </button>
            )}
            {ownsCheckout &&
              props.permissions.includes("ai.run") &&
              !props.bundle && (
                <button className="button secondary" onClick={review}>
                  Run complete review
                </button>
              )}
            {props.bundle?.state === "HUMAN_REVIEW" &&
              props.permissions.includes("publication.approve") && (
                <button
                  className="button"
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
              )}
            {props.bundle?.state === "APPROVED" &&
              props.permissions.includes("publication.publish") &&
              !props.publicationRequest && (
                <button className="button warn" onClick={stage}>
                  Stage approved bundle
                </button>
              )}
            {props.publicationRequest?.state === "AWAITING_CONFIRMATION" &&
              props.permissions.includes("publication.publish") && (
                <button className="button warn" onClick={confirmPublication}>
                  Publish this reviewed bundle
                </button>
              )}
          </div>
        </div>
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
          <div className="lifecycleBar">
            <label className="field">
              Lifecycle reason
              <input
                value={archiveReason}
                onChange={(event) => setArchiveReason(event.target.value)}
                placeholder={
                  props.lifecycle === "ARCHIVED"
                    ? "Reason for restoration"
                    : "Required reason for archive"
                }
              />
            </label>
            <button
              className="button secondary"
              type="button"
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
          </div>
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
    </section>
  );
}
