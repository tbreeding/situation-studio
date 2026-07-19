"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export function PublicationConfirmationDialog({
  baselineCommitSha,
  candidateCommitSha,
  onCancel,
  onConfirm,
  submitting,
}: {
  baselineCommitSha: string;
  candidateCommitSha: string;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  submitting: boolean;
}) {
  const [reviewed, setReviewed] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
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
  }, [onCancel, submitting]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewed || submitting) return;
    await onConfirm();
  }

  return (
    <div className="modalBackdrop" role="presentation">
      <section
        ref={dialogRef}
        aria-describedby="publication-confirmation-description"
        aria-labelledby="publication-confirmation-title"
        aria-modal="true"
        className="publicationConfirmationDialog"
        role="dialog"
      >
        <p className="eyebrow">Final publication decision</p>
        <h2 id="publication-confirmation-title">
          Make candidate {candidateCommitSha.slice(0, 8)} official?
        </h2>
        <p id="publication-confirmation-description">
          Leadership already displays this reviewed candidate. Confirming makes
          it the official published baseline in protected Git and Situation
          Studio.
        </p>

        <div className="publicationVersionChange" aria-label="Version change">
          <div>
            <span>Official baseline now</span>
            <strong>{baselineCommitSha.slice(0, 8)}</strong>
            <small>Protected Git main</small>
          </div>
          <span aria-hidden="true">→</span>
          <div>
            <span>Official baseline after</span>
            <strong>{candidateCommitSha.slice(0, 8)}</strong>
            <small>Reviewed staged candidate</small>
          </div>
        </div>

        <div className="publicationEffects">
          <strong>This confirmation will:</strong>
          <ul>
            <li>re-verify the exact staged release;</li>
            <li>advance protected Git main to this candidate;</li>
            <li>record the new official baseline and release custody.</li>
          </ul>
          <p>
            It will not build another version or create another Leadership site.
            The previous baseline remains available for audited rollback.
          </p>
        </div>

        <a
          className="publicationReviewLink"
          href="https://leadership.timsprototypes.com"
          target="_blank"
          rel="noreferrer"
        >
          Review the staged candidate on Leadership ↗
        </a>

        <form onSubmit={submit}>
          <label className="publicationReviewConfirmation">
            <input
              autoFocus
              checked={reviewed}
              disabled={submitting}
              type="checkbox"
              onChange={(event) => setReviewed(event.target.checked)}
            />
            <span>I reviewed the staged candidate and want to publish it.</span>
          </label>
          <div className="workspaceActions">
            <button
              className="button secondary"
              disabled={submitting}
              type="button"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              className="button warn"
              disabled={!reviewed || submitting}
              type="submit"
            >
              {submitting
                ? "Recording confirmation…"
                : `Confirm and publish ${candidateCommitSha.slice(0, 8)}`}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
