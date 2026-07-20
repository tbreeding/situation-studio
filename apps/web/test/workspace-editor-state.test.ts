import { describe, expect, it } from "vitest";
import { reconcileDisplayedArtifactBody } from "../src/lib/workspace-editor-state";

describe("workspace editor state", () => {
  it("adopts a refreshed proposal body when the user has not edited locally", () => {
    expect(
      reconcileDisplayedArtifactBody({
        currentBody: "saved draft",
        previousArtifactBody: "saved draft",
        nextArtifactBody: "reviewed proposal",
      }),
    ).toBe("reviewed proposal");
  });

  it("preserves genuine unsaved edits across a server refresh", () => {
    expect(
      reconcileDisplayedArtifactBody({
        currentBody: "local unsaved edit",
        previousArtifactBody: "saved draft",
        nextArtifactBody: "reviewed proposal",
      }),
    ).toBe("local unsaved edit");
  });
});
