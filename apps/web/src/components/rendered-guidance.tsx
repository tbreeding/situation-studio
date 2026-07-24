"use client";

import { Fragment } from "react";

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

export function RenderedGuidance({
  body,
  compact = false,
}: {
  body: string;
  compact?: boolean;
}) {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const nodes: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const value = paragraph.join(" ").trim();
    if (value) nodes.push(<p key={`p-${nodes.length}`}>{inline(value)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    nodes.push(
      <ul key={`ul-${nodes.length}`}>
        {list.map((item, index) => (
          <li key={`${item}-${index}`}>{inline(item)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      nodes.push(<h2 key={`h-${nodes.length}`}>{line.slice(3)}</h2>);
    } else if (/^[-*] /u.test(line)) {
      flushParagraph();
      list.push(line.slice(2));
    } else if (line.startsWith("> ")) {
      flushParagraph();
      flushList();
      nodes.push(
        <blockquote key={`q-${nodes.length}`}>
          {inline(line.slice(2))}
        </blockquote>,
      );
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else if (!line.startsWith("---")) paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();

  return (
    <article className={`renderedGuidance${compact ? " compact" : ""}`}>
      {nodes}
    </article>
  );
}
