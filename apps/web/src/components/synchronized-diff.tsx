"use client";

import { diffLines } from "diff";

export function SynchronizedDiff({
  production,
  draft,
}: {
  production: string;
  draft: string;
}) {
  const changes = diffLines(production, draft);
  return (
    <div
      className="sourceDiff"
      aria-label="Exact source difference"
      tabIndex={0}
    >
      {changes.map((change, index) => (
        <pre
          key={`${change.value.slice(0, 24)}-${index}`}
          className={
            change.added ? "diffAdded" : change.removed ? "diffRemoved" : ""
          }
        >
          <span aria-hidden="true">
            {change.added ? "+" : change.removed ? "−" : " "}
          </span>
          {change.value}
        </pre>
      ))}
    </div>
  );
}
