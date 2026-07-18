"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

export function ReauthenticationDialog({
  actionLabel,
  csrfToken,
  onCancel,
  onReauthenticated,
}: {
  actionLabel: string;
  csrfToken: string;
  onCancel: () => void;
  onReauthenticated: () => Promise<void> | void;
}) {
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
  }, [onCancel]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setStatus("Confirming your identity…");
    let response: Response;
    try {
      response = await fetch("/api/auth/reauthenticate", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ password }),
      });
    } catch {
      setSubmitting(false);
      setStatus("Identity confirmation could not connect. Try again.");
      return;
    }
    if (response.ok) {
      setPassword("");
      setStatus("Identity confirmed. Continuing…");
      await onReauthenticated();
      return;
    }
    setSubmitting(false);
    setStatus(
      response.status === 401
        ? "That password was not accepted. Try again."
        : response.status === 429
          ? "Too many attempts. Try again later."
          : "Identity confirmation failed. Try again.",
    );
  }

  return (
    <div className="modalBackdrop" role="presentation">
      <section
        ref={dialogRef}
        aria-describedby="reauthentication-description"
        aria-labelledby="reauthentication-title"
        aria-modal="true"
        className="reauthenticationDialog"
        role="dialog"
      >
        <p className="eyebrow">Sensitive action</p>
        <h2 id="reauthentication-title">Confirm your password</h2>
        <p id="reauthentication-description">
          Your session is still active. Re-enter your Situation Studio password
          to {actionLabel}.
        </p>
        <form className="stack" onSubmit={submit}>
          <label className="field">
            Password
            <input
              autoFocus
              autoComplete="current-password"
              maxLength={1024}
              minLength={12}
              name="password"
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <p aria-live="polite" className="formStatus" role="status">
            {status}
          </p>
          <div className="workspaceActions">
            <button
              className="button secondary"
              disabled={submitting}
              type="button"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button className="button" disabled={submitting} type="submit">
              {submitting ? "Confirming…" : "Confirm and continue"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
