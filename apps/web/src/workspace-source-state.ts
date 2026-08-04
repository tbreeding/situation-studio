export function canonicalWorkspaceText(value: string) {
  return `${value.replace(/\r\n?/gu, "\n").replace(/\n+$/u, "")}\n`;
}

export function serializeWorkspaceSections(
  names: string[],
  sections: Record<string, string>,
) {
  return canonicalWorkspaceText(
    names
      .map((name) => `## ${name}\n\n${(sections[name] ?? "").trim()}`)
      .join("\n\n"),
  );
}

export function parseWorkspaceSections(names: string[], body: string) {
  const normalized = canonicalWorkspaceText(body);
  const matches = [...normalized.matchAll(/^##[ \t]+(.+?)[ \t]*$/gmu)];
  const parsed: Record<string, string> = {};
  matches.forEach((match, index) => {
    const name = match[1]?.trim() ?? "";
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    parsed[name] = normalized.slice(start, end).trim();
  });
  if (names.some((name) => !(name in parsed)))
    throw new Error(
      "Raw MDX is missing one or more required section headings.",
    );
  return Object.fromEntries(names.map((name) => [name, parsed[name] ?? ""]));
}

export function currentWorkspaceBody(input: {
  bodyTouched: boolean;
  rawMode: boolean;
  rawBody: string;
  sectionNames: string[];
  sections: Record<string, string>;
}) {
  if (!input.bodyTouched) return input.rawBody;
  return input.rawMode
    ? canonicalWorkspaceText(input.rawBody)
    : serializeWorkspaceSections(input.sectionNames, input.sections);
}

export function changedWorkspaceSections(
  sectionNames: string[],
  productionBody: string,
  draftBody: string,
) {
  return sectionNames.filter((name) => {
    const marker = `## ${name}`;
    const draft = draftBody.split(marker)[1]?.split(/^## /mu)[0]?.trim() ?? "";
    const production =
      productionBody.split(marker)[1]?.split(/^## /mu)[0]?.trim() ?? "";
    return draft !== production;
  });
}
