"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

export type InventorySituation = {
  id: string;
  slug: string;
  title: string;
  lifecycle: string;
  publicationState: string;
  primarySkill: string;
  tags: string[];
  checkout: {
    mode: string;
    holderName: string;
    renewedAt: string;
  } | null;
  draftState: string | null;
  proposalState: string | null;
  validationBlocked: boolean;
  publicationPending: boolean;
  needsAttention: boolean;
};

const readable = (value: string) => value.toLowerCase().replaceAll("_", " ");

export function SituationInventory({
  situations,
  canCreate,
}: {
  situations: InventorySituation[];
  canCreate: boolean;
}) {
  const [query, setQuery] = useState("");
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [lifecycle, setLifecycle] = useState("ALL");
  const [publication, setPublication] = useState("ALL");
  const [checkout, setCheckout] = useState("ALL");
  const [sort, setSort] = useState("ATTENTION");

  const lifecycleOptions = [
    ...new Set(situations.map((item) => item.lifecycle)),
  ].sort();
  const publicationOptions = [
    ...new Set(situations.map((item) => item.publicationState)),
  ].sort();
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const queryTokens = useMemo(
    () => normalizedQuery.split(/\s+/u).filter(Boolean),
    [normalizedQuery],
  );
  const visible = useMemo(
    () =>
      situations
        .filter((item) => {
          const searchable = [
            item.title,
            item.slug,
            item.primarySkill,
            ...item.tags,
          ]
            .join(" ")
            .toLocaleLowerCase();
          return (
            (!normalizedQuery ||
              queryTokens.every((token) => searchable.includes(token))) &&
            (!attentionOnly || item.needsAttention) &&
            (lifecycle === "ALL" || item.lifecycle === lifecycle) &&
            (publication === "ALL" || item.publicationState === publication) &&
            (checkout === "ALL" ||
              (checkout === "CHECKED_OUT" && Boolean(item.checkout)) ||
              (checkout === "AVAILABLE" && !item.checkout))
          );
        })
        .sort((left, right) => {
          if (
            sort === "ATTENTION" &&
            left.needsAttention !== right.needsAttention
          )
            return left.needsAttention ? -1 : 1;
          return left.title.localeCompare(right.title);
        }),
    [
      attentionOnly,
      checkout,
      lifecycle,
      normalizedQuery,
      publication,
      queryTokens,
      situations,
      sort,
    ],
  );

  function reset() {
    setQuery("");
    setAttentionOnly(false);
    setLifecycle("ALL");
    setPublication("ALL");
    setCheckout("ALL");
    setSort("ATTENTION");
  }

  return (
    <>
      <div className="inventoryToolbar inventorySummary">
        <div className="badges" aria-label="Inventory totals">
          <span className="badge">{situations.length} situations</span>
          <span className="badge gold">
            {situations.filter((item) => item.checkout).length} checked out
          </span>
          <span className="badge rust">
            {situations.filter((item) => item.needsAttention).length} need
            attention
          </span>
        </div>
        {canCreate && (
          <Link className="button" href="/situations/new">
            New situation
          </Link>
        )}
      </div>

      <section className="inventoryControls" aria-labelledby="find-situations">
        <div className="searchField">
          <label htmlFor="inventory-search" id="find-situations">
            Find a situation
          </label>
          <input
            id="inventory-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search title, slug, skill, or topic tag"
          />
        </div>
        <fieldset className="filterGroup">
          <legend>Quick filters</legend>
          <label className="checkFilter">
            <input
              type="checkbox"
              checked={attentionOnly}
              onChange={(event) => setAttentionOnly(event.target.checked)}
            />
            Needs attention
          </label>
          <label>
            <span>Lifecycle</span>
            <select
              aria-label="Lifecycle"
              value={lifecycle}
              onChange={(event) => setLifecycle(event.target.value)}
            >
              <option value="ALL">All lifecycle states</option>
              {lifecycleOptions.map((value) => (
                <option value={value} key={value}>
                  {readable(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Publication</span>
            <select
              aria-label="Publication"
              value={publication}
              onChange={(event) => setPublication(event.target.value)}
            >
              <option value="ALL">All publication states</option>
              {publicationOptions.map((value) => (
                <option value={value} key={value}>
                  {readable(value)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Checkout</span>
            <select
              aria-label="Checkout availability"
              value={checkout}
              onChange={(event) => setCheckout(event.target.value)}
            >
              <option value="ALL">Any checkout state</option>
              <option value="AVAILABLE">Available</option>
              <option value="CHECKED_OUT">Checked out</option>
            </select>
          </label>
          <label>
            <span>Order</span>
            <select
              aria-label="Sort situations"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="ATTENTION">Needs attention first</option>
              <option value="ALPHABETICAL">Alphabetical</option>
            </select>
          </label>
          <button
            className="textButton resetFilters"
            type="button"
            onClick={reset}
          >
            Reset filters
          </button>
        </fieldset>
      </section>

      <p className="resultCount" role="status" aria-live="polite">
        Showing {visible.length} of {situations.length} situations
      </p>

      {visible.length ? (
        <div className="situationGrid">
          {visible.map((situation) => (
            <Link
              className={`situationCard ${situation.needsAttention ? "attentionCard" : "steadyCard"}`}
              href={`/situations/${situation.slug}`}
              key={situation.id}
            >
              <div className="badges">
                {situation.needsAttention ? (
                  <span className="badge rust">Needs attention</span>
                ) : (
                  <span className="badge">Published · available</span>
                )}
                {situation.lifecycle === "ARCHIVED" && (
                  <span className="badge rust">Archived</span>
                )}
                {situation.checkout && (
                  <span className="badge rust">Checked out</span>
                )}
                {situation.draftState && (
                  <span className="badge gold">
                    {readable(situation.draftState)}
                  </span>
                )}
                {situation.validationBlocked && (
                  <span className="badge rust">Validation blocked</span>
                )}
                {situation.publicationPending && (
                  <span className="badge gold">Publication pending</span>
                )}
              </div>
              <h2>{situation.title}</h2>
              <p className="cardMetadata">
                <span>{readable(situation.primarySkill)}</span>
                <code>{situation.slug}</code>
              </p>
              <p>
                {situation.checkout
                  ? `${readable(situation.checkout.mode)} checkout held by ${situation.checkout.holderName}.`
                  : situation.needsAttention
                    ? "Open the workspace to review its current workflow state and next valid action."
                    : "Published baseline ready to read or check out."}
              </p>
              <div className="cardFoot">
                <span>{readable(situation.lifecycle)}</span>
                <span>Open workspace →</span>
              </div>
            </Link>
          ))}
        </div>
      ) : (
        <section className="panel emptyState zeroResults">
          <h2>No situations match</h2>
          <p>Try a broader search or clear the active filters.</p>
          <button className="button secondary" type="button" onClick={reset}>
            Reset all filters
          </button>
        </section>
      )}
    </>
  );
}
