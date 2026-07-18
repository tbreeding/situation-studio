"use client";

import { useState } from "react";

export function JobActions(props: {
  jobId: string;
  state: string;
  csrfToken: string;
}) {
  const [pending, setPending] = useState(false);
  const cancellable = ["QUEUED", "RETRY_SCHEDULED", "RUNNING"].includes(
    props.state,
  );
  if (!cancellable && props.state !== "CANCELLING") return null;
  async function cancel() {
    if (!window.confirm("Cancel this complete review and return its checkout?"))
      return;
    setPending(true);
    const response = await fetch(`/api/jobs/${props.jobId}/cancel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": props.csrfToken,
      },
      body: "{}",
    });
    if (response.ok) location.reload();
    else setPending(false);
  }
  return (
    <button
      className="button secondary"
      type="button"
      onClick={cancel}
      disabled={pending || props.state === "CANCELLING"}
    >
      {pending || props.state === "CANCELLING"
        ? "Cancelling…"
        : "Cancel review"}
    </button>
  );
}
