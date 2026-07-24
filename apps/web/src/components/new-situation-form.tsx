"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

function slugify(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 160);
}

export function NewSituationForm({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/situations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ title, slug }),
      });
      const payload = (await response.json()) as {
        error?: string;
        slug?: string;
      };
      if (!response.ok) {
        setError(payload.error ?? "The situation could not be created.");
        return;
      }
      router.push(`/situations/${payload.slug}`);
      router.refresh();
    });
  }
  return (
    <form className="newSituationForm" onSubmit={submit}>
      {error ? (
        <p className="formError" role="alert">
          {error}
        </p>
      ) : null}
      <label>
        <span>Working title</span>
        <input
          value={title}
          onChange={(event) => {
            const next = event.target.value;
            setTitle(next);
            if (!slugEdited) setSlug(slugify(next));
          }}
          minLength={20}
          maxLength={300}
          required
          autoFocus
        />
        <small>
          Describe the observable situation, not the desired advice.
        </small>
      </label>
      <label>
        <span>Stable slug</span>
        <div className="prefixField">
          <span>leadership.timsprototypes.com/situations/</span>
          <input
            value={slug}
            onChange={(event) => {
              setSlugEdited(true);
              setSlug(slugify(event.target.value));
            }}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            required
          />
        </div>
        <small>The slug becomes permanent after first publication.</small>
      </label>
      <div className="formActions">
        <Link className="secondaryButton" href="/">
          Cancel
        </Link>
        <button
          className="primaryButton"
          type="submit"
          disabled={pending || title.length < 20 || !slug}
        >
          {pending ? "Creating…" : "Create and check out"}
        </button>
      </div>
    </form>
  );
}
