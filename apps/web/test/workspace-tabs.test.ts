import { describe, expect, it } from "vitest";
import {
  workspaceTabFromSearchParam,
  workspaceTabPath,
} from "@/components/workspace-tabs";

describe("workspace tab persistence", () => {
  it("restores only known workspace tabs", () => {
    expect(workspaceTabFromSearchParam("review")).toBe("review");
    expect(workspaceTabFromSearchParam("history")).toBe("history");
    expect(workspaceTabFromSearchParam("context")).toBe("context");
    expect(workspaceTabFromSearchParam("unknown")).toBe("edit");
    expect(workspaceTabFromSearchParam(["review"])).toBe("edit");
    expect(workspaceTabFromSearchParam(undefined)).toBe("edit");
  });

  it("stores non-default tabs while preserving other URL state", () => {
    expect(
      workspaceTabPath(
        "https://studio.example/situations/example?mode=inspect#notes",
        "history",
      ),
    ).toBe("/situations/example?mode=inspect&tab=history#notes");
  });

  it("uses the clean situation URL for the default Edit tab", () => {
    expect(
      workspaceTabPath(
        "https://studio.example/situations/example?tab=review",
        "edit",
      ),
    ).toBe("/situations/example");
  });
});
