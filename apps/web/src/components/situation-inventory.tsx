"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type InventoryItem = {
  id: string;
  slug: string;
  title: string;
  primary: string;
  activity: string | null;
  checkoutOwner: string | null;
  checkoutOwnerId: string | null;
  draftUpdatedAt: string | null;
  productionAt: string | null;
};

function relativeTime(value: string | null) {
  if (!value) return "—";
  const milliseconds = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SituationInventory({
  items,
  currentUserId,
  csrfToken,
  globalRecoveryRequired,
}: {
  items: InventoryItem[];
  currentUserId: string;
  csrfToken: string;
  globalRecoveryRequired: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "mine" | "drafts" | "retired">(
    "all",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return items.filter((item) => {
      if (
        normalized &&
        !`${item.title} ${item.slug}`.toLowerCase().includes(normalized)
      )
        return false;
      if (scope === "mine") return item.checkoutOwnerId === currentUserId;
      if (scope === "drafts") return item.primary === "Draft saved";
      if (scope === "retired") return item.primary === "Retired";
      return true;
    });
  }, [currentUserId, items, query, scope]);

  async function checkout(item: InventoryItem) {
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/situations/${item.id}/checkout`, {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
      });
      const payload = (await response.json()) as {
        error?: string;
        slug?: string;
      };
      if (!response.ok) {
        setError(payload.error ?? "Checkout failed.");
        router.refresh();
        return;
      }
      router.push(`/situations/${payload.slug ?? item.slug}`);
      router.refresh();
    });
  }

  return (
    <section className="inventorySurface" aria-labelledby="inventory-heading">
      <div className="inventoryTools">
        <label className="searchField">
          <span className="srOnly">Search situations</span>
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            placeholder="Search by title or slug"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘ K</kbd>
        </label>
        <div className="filterTabs" aria-label="Filter situations">
          {(
            [
              ["all", "All"],
              ["mine", "Checked out by me"],
              ["drafts", "Drafts"],
              ["retired", "Retired"],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={scope === value ? "active" : undefined}
              aria-pressed={scope === value}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <p className="inlineAlert" role="alert">
          {error}
        </p>
      ) : null}
      {globalRecoveryRequired ? (
        <p className="inlineAlert" role="alert">
          Studio publication recovery is required. You can inspect saved work,
          but new checkouts and editorial changes stay locked until an
          administrator verifies a known Leadership release.
        </p>
      ) : null}
      <div
        className="inventoryTable"
        role="region"
        aria-labelledby="inventory-heading"
        aria-live="polite"
      >
        <div className="inventoryHeader" aria-hidden="true">
          <span>Situation</span>
          <span>Status</span>
          <span>Last draft</span>
          <span>Production</span>
          <span />
        </div>
        {filtered.map((item) => {
          const mine = item.checkoutOwnerId === currentUserId;
          const available =
            !item.checkoutOwnerId || mine || item.primary === "Draft saved";
          return (
            <article className="inventoryRow" key={item.id}>
              <div className="situationIdentity">
                <a href={`/situations/${item.slug}`}>{item.title}</a>
                <span>{item.slug}</span>
              </div>
              <div>
                <span
                  className={`statusPill status-${item.primary
                    .split(" ")[0]
                    ?.toLowerCase()}`}
                >
                  <span aria-hidden="true" />
                  {item.primary}
                </span>
                {item.activity ? (
                  <span className="activityLabel">{item.activity}</span>
                ) : null}
              </div>
              <span className="timeCell">
                {relativeTime(item.draftUpdatedAt)}
              </span>
              <span className="timeCell">
                {relativeTime(item.productionAt)}
              </span>
              <div className="rowAction">
                {mine ? (
                  <a
                    className="secondaryButton"
                    href={`/situations/${item.slug}`}
                  >
                    Continue
                  </a>
                ) : available && item.primary !== "Retired" ? (
                  <button
                    className="secondaryButton"
                    type="button"
                    disabled={pending || globalRecoveryRequired}
                    onClick={() => checkout(item)}
                  >
                    Check out
                  </button>
                ) : (
                  <a className="textLink" href={`/situations/${item.slug}`}>
                    Inspect
                  </a>
                )}
              </div>
            </article>
          );
        })}
        {!filtered.length ? (
          <div className="emptyState">
            <strong>No situations match this view.</strong>
            <span>Try another search or filter.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}
