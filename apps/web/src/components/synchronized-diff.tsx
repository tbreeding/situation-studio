"use client";

import { useMemo, useRef, type UIEvent } from "react";
import { buildLineDiff, type DiffLine } from "@/lib/line-diff";

function DiffLineView({ line }: { line: DiffLine }) {
  return (
    <div className={`diffLine ${line.kind}`}>
      <span aria-hidden="true" className="diffLineNumber">
        {line.number ?? ""}
      </span>
      <code>{line.text || " "}</code>
    </div>
  );
}

export function SynchronizedDiff({
  candidate,
  candidateLabel,
  published,
}: {
  candidate: string;
  candidateLabel: string;
  published: string;
}) {
  const diff = useMemo(
    () => buildLineDiff(published, candidate),
    [candidate, published],
  );
  const publishedRef = useRef<HTMLDivElement>(null);
  const candidateRef = useRef<HTMLDivElement>(null);
  const synchronizing = useRef(false);

  function synchronize(
    event: UIEvent<HTMLDivElement>,
    target: HTMLDivElement | null,
  ) {
    if (!target || synchronizing.current) return;
    synchronizing.current = true;
    target.scrollTop = event.currentTarget.scrollTop;
    target.scrollLeft = event.currentTarget.scrollLeft;
    window.requestAnimationFrame(() => {
      synchronizing.current = false;
    });
  }

  return (
    <>
      <div className="diffLegend" aria-label="Diff summary">
        <span className="diffLegendItem removed">
          {diff.removedCount} removed
        </span>
        <span className="diffLegendItem added">{diff.addedCount} added</span>
        <span className="diffScrollLinked">Scroll linked ↕</span>
      </div>
      <div className="diffGrid">
        <section>
          <h3 id="published-diff-heading">Published</h3>
          <div
            ref={publishedRef}
            aria-labelledby="published-diff-heading"
            className="diffScroller"
            role="region"
            tabIndex={0}
            onScroll={(event) => synchronize(event, candidateRef.current)}
          >
            <div className="diffLines">
              {diff.rows.map((row, index) => (
                <DiffLineView key={index} line={row.left} />
              ))}
            </div>
          </div>
        </section>
        <section>
          <h3 id="candidate-diff-heading">{candidateLabel}</h3>
          <div
            ref={candidateRef}
            aria-labelledby="candidate-diff-heading"
            className="diffScroller"
            role="region"
            tabIndex={0}
            onScroll={(event) => synchronize(event, publishedRef.current)}
          >
            <div className="diffLines">
              {diff.rows.map((row, index) => (
                <DiffLineView key={index} line={row.right} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
