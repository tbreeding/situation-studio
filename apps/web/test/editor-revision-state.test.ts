import { describe, expect, it } from "vitest";
import {
  exactRevisionCommand,
  preflightMatchesRevision,
  reviewRequiresForcedCheckpoint,
  serverRevisionAdoptionDecision,
  serverRevisionRequiresAdoption,
} from "../src/editor-revision-state";

const first = { id: "revision-1", bundleHash: "a".repeat(64) };
const second = { id: "revision-2", bundleHash: "b".repeat(64) };

describe("editor revision fencing", () => {
  it("adopts a server-side proposal revision instead of retaining stale local state", () => {
    expect(serverRevisionRequiresAdoption(first, second)).toBe(true);
    expect(serverRevisionRequiresAdoption(second, second)).toBe(false);
  });

  it("never overwrites unsaved local edits when a newer server revision arrives", () => {
    expect(serverRevisionAdoptionDecision(first, second, true)).toBe(
      "PRESERVE_LOCAL",
    );
    expect(serverRevisionAdoptionDecision(first, second, false)).toBe("ADOPT");
    expect(serverRevisionAdoptionDecision(second, second, true)).toBe(
      "UNCHANGED",
    );
  });

  it("names the exact revision in every command", () => {
    expect(exactRevisionCommand(second)).toEqual({
      revisionId: second.id,
      bundleHash: second.bundleHash,
    });
  });

  it("forces a clean legacy draft through an authoritative review checkpoint", () => {
    expect(reviewRequiresForcedCheckpoint("situation-bundle-v1")).toBe(true);
    expect(reviewRequiresForcedCheckpoint("unknown-bundle-version")).toBe(true);
    expect(reviewRequiresForcedCheckpoint("situation-bundle-v2")).toBe(false);
  });

  it("invalidates a preflight when either revision identity changes", () => {
    expect(preflightMatchesRevision(second, second)).toBe(true);
    expect(preflightMatchesRevision(first, second)).toBe(false);
    expect(
      preflightMatchesRevision(
        { id: second.id, bundleHash: first.bundleHash },
        second,
      ),
    ).toBe(false);
  });
});
