export const WORKSPACE_TABS = ["edit", "review", "history", "context"] as const;

export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];

export function workspaceTabFromSearchParam(
  value: string | string[] | undefined,
): WorkspaceTab {
  return typeof value === "string" &&
    WORKSPACE_TABS.includes(value as WorkspaceTab)
    ? (value as WorkspaceTab)
    : "edit";
}

export function workspaceTabPath(currentHref: string, tab: WorkspaceTab) {
  const url = new URL(currentHref);
  if (tab === "edit") url.searchParams.delete("tab");
  else url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}${url.hash}`;
}
