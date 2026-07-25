"use client";

import { Fragment } from "react";

export type RenderedGuidanceDiff = {
  kind: "added" | "removed";
  lines: ReadonlySet<number>;
};

function inline(value: string) {
  const parts = value.split(/(\*\*[^*]+\*\*)/gu);
  return parts.map((part, index) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={`${part}-${index}`}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={`${part}-${index}`}>{part}</Fragment>
    ),
  );
}

function diffProperties(
  diff: RenderedGuidanceDiff | undefined,
  lineNumbers: number[],
) {
  if (!diff || !lineNumbers.some((lineNumber) => diff.lines.has(lineNumber)))
    return {};
  const label = diff.kind === "added" ? "Added content: " : "Removed content: ";
  return {
    className: `renderDiffLine renderDiff${diff.kind === "added" ? "Added" : "Removed"}`,
    cue: <span className="srOnly">{label}</span>,
  };
}

export function RenderedGuidance({
  body,
  compact = false,
  diff,
}: {
  body: string;
  compact?: boolean;
  diff?: RenderedGuidanceDiff;
}) {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const nodes: React.ReactNode[] = [];
  let paragraph: Array<{ lineNumber: number; value: string }> = [];
  let list: Array<{ lineNumber: number; value: string }> = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const value = paragraph
      .map((line) => line.value)
      .join(" ")
      .trim();
    const properties = diffProperties(
      diff,
      paragraph.map((line) => line.lineNumber),
    );
    if (value)
      nodes.push(
        <p key={`p-${nodes.length}`} className={properties.className}>
          {properties.cue}
          {inline(value)}
        </p>,
      );
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {list.map((item, index) => {
          const properties = diffProperties(diff, [item.lineNumber]);
          return (
            <li key={`${item.value}-${index}`} className={properties.className}>
              {properties.cue}
              {inline(item.value)}
            </li>
          );
        })}
      </ul>,
    );
    list = [];
  };

  for (const [lineNumber, line] of lines.entries()) {
    if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      const properties = diffProperties(diff, [lineNumber]);
      nodes.push(
        <h2 key={`h-${nodes.length}`} className={properties.className}>
          {properties.cue}
          {line.slice(3)}
        </h2>,
      );
    } else if (/^[-*] /u.test(line)) {
      flushParagraph();
      list.push({ lineNumber, value: line.slice(2) });
    } else if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      const properties = diffProperties(diff, [lineNumber]);
      nodes.push(
        <blockquote key={`q-${nodes.length}`} className={properties.className}>
          {properties.cue}
          {inline(line.slice(2))}
        </blockquote>,
      );
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (!line.startsWith("---"))
      paragraph.push({ lineNumber, value: line.trim() });
  }
  flushParagraph();
  flushList();

  return (
    <article className={`renderedGuidance${compact ? " compact" : ""}`}>
      {nodes}
    </article>
  );
}
