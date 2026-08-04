import { describe, expect, it } from "vitest";
import {
  changedWorkspaceSections,
  currentWorkspaceBody,
  parseWorkspaceSections,
} from "@/workspace-source-state";

const sectionNames = ["The short answer", "Next move"];
const retainedLegacyBody =
  "\n## The short answer\n\nKeep the exact saved bytes.\n\n## Next move\n\nCompare the retained source.\n";

describe("workspace source state", () => {
  it("preserves an untouched retained source byte-for-byte", () => {
    const sections = parseWorkspaceSections(sectionNames, retainedLegacyBody);

    expect(
      currentWorkspaceBody({
        bodyTouched: false,
        rawMode: false,
        rawBody: retainedLegacyBody,
        sectionNames,
        sections,
      }),
    ).toBe(retainedLegacyBody);
    expect(
      changedWorkspaceSections(
        sectionNames,
        retainedLegacyBody,
        retainedLegacyBody,
      ),
    ).toEqual([]);
  });

  it("canonicalizes only after the editor changes body content", () => {
    const sections = parseWorkspaceSections(sectionNames, retainedLegacyBody);

    expect(
      currentWorkspaceBody({
        bodyTouched: true,
        rawMode: false,
        rawBody: retainedLegacyBody,
        sectionNames,
        sections,
      }),
    ).toBe(retainedLegacyBody.slice(1));
  });
});
