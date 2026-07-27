"use client";

import { diffLines } from "diff";
import { useMemo, useRef } from "react";
import { RenderedGuidance } from "@/components/rendered-guidance";

export type RenderedComparisonLines = {
  draft: ReadonlySet<number>;
  production: ReadonlySet<number>;
};

function normalized(value: string) {
  return value.replace(/\r\n?/gu, "\n");
}

export function synchronizedScrollTop(
  sourceScrollTop: number,
  sourceRange: number,
  targetRange: number,
) {
  if (sourceRange <= 0 || targetRange <= 0) return 0;
  return Math.min(
    targetRange,
    Math.max(0, (sourceScrollTop / sourceRange) * targetRange),
  );
}

export function renderedComparisonLines(
  production: string,
  draft: string,
): RenderedComparisonLines {
  const productionLines = new Set<number>();
  const draftLines = new Set<number>();
  let productionLine = 0;
  let draftLine = 0;

  for (const change of diffLines(normalized(production), normalized(draft))) {
    const lineCount = change.count ?? 0;
    if (change.removed) {
      for (let offset = 0; offset < lineCount; offset += 1)
        productionLines.add(productionLine + offset);
      productionLine += lineCount;
    } else if (change.added) {
      for (let offset = 0; offset < lineCount; offset += 1)
        draftLines.add(draftLine + offset);
      draftLine += lineCount;
    } else {
      productionLine += lineCount;
      draftLine += lineCount;
    }
  }

  return { draft: draftLines, production: productionLines };
}

export function RenderedComparison({
  production,
  draft,
  productionRevision,
  draftRevision = "Working copy",
  productionLabel = "Current production",
  draftLabel = "Saved draft",
  ariaLabel = "Synchronized rendered comparison",
}: {
  production: string;
  draft: string;
  productionRevision: string;
  draftRevision?: string;
  productionLabel?: string;
  draftLabel?: string;
  ariaLabel?: string;
}) {
  const productionPane = useRef<HTMLElement>(null);
  const draftPane = useRef<HTMLElement>(null);
  const synchronizingPane = useRef<HTMLElement | null>(null);
  const differenceLines = useMemo(
    () => renderedComparisonLines(production, draft),
    [draft, production],
  );
  const hasRenderedDifferences =
    differenceLines.production.size > 0 || differenceLines.draft.size > 0;

  const synchronizeScroll = (
    source: HTMLElement,
    target: HTMLElement | null,
  ) => {
    if (!target || synchronizingPane.current === source) return;

    const sourceRange = source.scrollHeight - source.clientHeight;
    const targetRange = target.scrollHeight - target.clientHeight;
    const nextScrollTop = synchronizedScrollTop(
      source.scrollTop,
      sourceRange,
      targetRange,
    );
    if (Math.abs(target.scrollTop - nextScrollTop) < 1) return;

    synchronizingPane.current = target;
    target.scrollTop = nextScrollTop;
    requestAnimationFrame(() => {
      if (synchronizingPane.current === target)
        synchronizingPane.current = null;
    });
  };

  return (
    <section className="renderedComparison" aria-label={ariaLabel}>
      <div className="renderCompareToolbar">
        <span className="linkedScrollStatus">
          <span aria-hidden="true">↕</span>
          Scroll linked
        </span>
        {hasRenderedDifferences ? (
          <span className="renderDiffLegend" aria-label="Difference legend">
            <span className="diffLegendRemoved">
              <i aria-hidden="true">−</i>
              Removed
            </span>
            <span className="diffLegendAdded">
              <i aria-hidden="true">+</i>
              Added
            </span>
          </span>
        ) : (
          <span className="renderDiffEmpty">Rendered content matches</span>
        )}
      </div>
      <div className="renderCompare">
        <article
          ref={productionPane}
          tabIndex={0}
          aria-label={`Scrollable ${productionLabel.toLowerCase()}`}
          onScroll={(event) =>
            synchronizeScroll(event.currentTarget, draftPane.current)
          }
        >
          <header>
            <span>{productionLabel}</span>
            <code>{productionRevision}</code>
          </header>
          <RenderedGuidance
            body={production}
            compact
            diff={{ kind: "removed", lines: differenceLines.production }}
          />
        </article>
        <article
          ref={draftPane}
          tabIndex={0}
          aria-label={`Scrollable ${draftLabel.toLowerCase()}`}
          onScroll={(event) =>
            synchronizeScroll(event.currentTarget, productionPane.current)
          }
        >
          <header>
            <span>{draftLabel}</span>
            <code>{draftRevision}</code>
          </header>
          <RenderedGuidance
            body={draft}
            compact
            diff={{ kind: "added", lines: differenceLines.draft }}
          />
        </article>
      </div>
    </section>
  );
}
