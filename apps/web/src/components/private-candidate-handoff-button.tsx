"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { privateCandidateHandoffDestination } from "@/lib/publication-presentation";

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
  const [bootstrapUrl, setBootstrapUrl] = useState<string | null>(null);
  const startHandoffRef = useRef<() => Promise<void>>(async () => undefined);

  const startHandoff = useCallback(async () => {
    if (pending) return;
    setPending(true);
    setBootstrapUrl(null);
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
          body: JSON.stringify({ situationSlug }),
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
      bootstrapUrl?: string;
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
    if (!response.ok || !result?.bootstrapUrl) {
      setPending(false);
      onStatus(result?.error ?? "Private candidate authorization failed.");
      return;
    }

    try {
      setBootstrapUrl(privateCandidateHandoffDestination(result.bootstrapUrl));
      setPending(false);
      onStatus(
        "Secure Leadership handoff ready. Continue in this tab for exact review.",
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

  return bootstrapUrl ? (
    <a
      className={className}
      href={bootstrapUrl}
      onClick={() =>
        onStatus("Establishing the private candidate session with Leadership…")
      }
    >
      Continue securely to Leadership
    </a>
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
