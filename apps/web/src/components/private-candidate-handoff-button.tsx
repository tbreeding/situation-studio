"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  privateCandidateExchangeSubmission,
  type PrivateCandidateExchangeSubmission,
} from "@/lib/publication-presentation";

export function PrivateCandidateHandoffButton({
  actionLabel,
  children,
  className,
  csrfToken,
  requestId,
  requestKind,
  situationSlug,
  onReauthenticationRequired,
  onStatus,
}: {
  actionLabel: string;
  children: React.ReactNode;
  className: string;
  csrfToken: string;
  requestId: string;
  requestKind: "publication" | "rollback";
  situationSlug: string;
  onReauthenticationRequired: (input: {
    actionLabel: string;
    retry: () => Promise<void>;
  }) => void;
  onStatus: (status: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [submission, setSubmission] =
    useState<PrivateCandidateExchangeSubmission | null>(null);
  const startHandoffRef = useRef<() => Promise<void>>(async () => undefined);

  const startHandoff = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setSubmission(null);
    onStatus("Creating a one-time private candidate authorization…");
    let response: Response;
    try {
      response = await fetch(
        `/api/${requestKind === "publication" ? "publications" : "rollbacks"}/${requestId}/candidate-authorization`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: "{}",
        },
      );
    } catch {
      setPending(false);
      onStatus(
        "Private candidate authorization could not connect. You are still in Studio; try again.",
      );
      return;
    }

    const result = (await response.json().catch(() => null)) as {
      exchangeToken?: string;
      candidateUrl?: string;
      error?: string;
    } | null;
    if (
      response.status === 403 &&
      result?.error === "recent reauthentication required"
    ) {
      setPending(false);
      onStatus("Confirm your password to continue this sensitive action.");
      onReauthenticationRequired({
        actionLabel,
        retry: () => startHandoffRef.current(),
      });
      return;
    }
    if (!response.ok || !result?.exchangeToken || !result.candidateUrl) {
      setPending(false);
      onStatus(result?.error ?? "Private candidate authorization failed.");
      return;
    }

    try {
      setSubmission(
        privateCandidateExchangeSubmission({
          candidateUrl: result.candidateUrl,
          exchangeToken: result.exchangeToken,
          situationSlug,
        }),
      );
      setPending(false);
      onStatus(
        "Private candidate authorization ready. Continue to Leadership for exact review.",
      );
    } catch {
      setPending(false);
      onStatus("Leadership returned an invalid private candidate destination.");
    }
  }, [
    actionLabel,
    csrfToken,
    onReauthenticationRequired,
    onStatus,
    pending,
    requestId,
    requestKind,
    situationSlug,
  ]);

  useEffect(() => {
    startHandoffRef.current = startHandoff;
  }, [startHandoff]);

  return submission ? (
    <form
      action={submission.action}
      method={submission.method}
      target={submission.target}
      onSubmit={() =>
        onStatus(
          "Opening the private candidate in Leadership for exact review…",
        )
      }
    >
      {Object.entries(submission.fields).map(([name, value]) => (
        <input key={name} name={name} type="hidden" value={value} />
      ))}
      <button className={className} type="submit">
        Continue to private candidate in Leadership
      </button>
    </form>
  ) : (
    <button
      aria-busy={pending}
      className={className}
      disabled={pending}
      type="button"
      onClick={startHandoff}
    >
      {pending ? "Opening private candidate…" : children}
    </button>
  );
}
