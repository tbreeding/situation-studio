import type { ReactNode } from "react";

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "quote"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "embed"; component: string; detail: string };

function bodyWithoutFrontmatter(body: string) {
  if (!body.startsWith("---")) return body;
  const closing = body.indexOf("\n---", 3);
  return closing === -1 ? body : body.slice(closing + 4).replace(/^\s+/u, "");
}

function isSpecial(line: string) {
  return (
    /^#{1,6}\s/u.test(line) ||
    /^>\s?/u.test(line) ||
    /^[-*]\s/u.test(line) ||
    /^\d+\.\s/u.test(line) ||
    /^<[A-Z][A-Za-z0-9]*/u.test(line)
  );
}

function parse(body: string): Block[] {
  const lines = bodyWithoutFrontmatter(body).split(/\r?\n/u);
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]?.trim() ?? "";
    if (!line) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]?.length ?? 2,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while ((lines[index]?.trim() ?? "").startsWith(">")) {
        quote.push((lines[index]?.trim() ?? "").replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push({ type: "quote", text: quote.join(" ") });
      continue;
    }
    if (/^[-*]\s/u.test(line) || /^\d+\.\s/u.test(line)) {
      const ordered = /^\d+\.\s/u.test(line);
      const items: string[] = [];
      const pattern = ordered ? /^\d+\.\s+/u : /^[-*]\s+/u;
      while (pattern.test(lines[index]?.trim() ?? "")) {
        items.push((lines[index]?.trim() ?? "").replace(pattern, ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const component = /^<([A-Z][A-Za-z0-9]*)([^>]*)\/?\s*>$/u.exec(line);
    if (component) {
      const attributes = [
        ...(component[2] ?? "").matchAll(/([A-Za-z]+)="([^"]+)"/gu),
      ]
        .map((match) => `${match[1]}: ${match[2]}`)
        .join(" · ");
      blocks.push({
        type: "embed",
        component: component[1] ?? "Connected component",
        detail: attributes,
      });
      index += 1;
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]?.trim() ?? "";
      if (!next || isSpecial(next)) break;
      paragraph.push(next);
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

function inline(text: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/gu);
  return tokens.filter(Boolean).map((token, index) => {
    if (token.startsWith("**") && token.endsWith("**"))
      return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`"))
      return <code key={index}>{token.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
    if (link) {
      const href = link[2] ?? "";
      const safe =
        href.startsWith("/") ||
        href.startsWith("#") ||
        href.startsWith("https://") ||
        href.startsWith("http://");
      return safe ? (
        <a href={href} key={index}>
          {link[1]}
        </a>
      ) : (
        <span key={index}>{link[1]}</span>
      );
    }
    return token;
  });
}

export function RenderedGuidance({ body }: { body: string }) {
  const blocks = parse(body);
  if (!blocks.length)
    return <p className="empty">No guidance content is available.</p>;
  return (
    <article className="renderedGuidance" aria-label="Rendered guidance">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          if (block.level <= 2)
            return <h2 key={index}>{inline(block.text)}</h2>;
          if (block.level === 3)
            return <h3 key={index}>{inline(block.text)}</h3>;
          return <h4 key={index}>{inline(block.text)}</h4>;
        }
        if (block.type === "paragraph")
          return <p key={index}>{inline(block.text)}</p>;
        if (block.type === "quote")
          return <blockquote key={index}>{inline(block.text)}</blockquote>;
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inline(item)}</li>
              ))}
            </List>
          );
        }
        return (
          <aside className="previewEmbed" key={index}>
            <span className="badge">Connected learning surface</span>
            <strong>
              {block.component.replace(/([a-z])([A-Z])/gu, "$1 $2")}
            </strong>
            {block.detail && <small>{block.detail}</small>}
          </aside>
        );
      })}
    </article>
  );
}
