import { describe, expect, it } from "vitest";
import {
  createFakePublication,
  InjectedCrash,
  publicationSteps,
  resumeFakePublication,
} from "../src/saga";

describe("publication crash recovery", () => {
  it.each(publicationSteps)("resumes idempotently after %s", (crashStep) => {
    const state = createFakePublication(
      `publication-${crashStep}`,
      "b".repeat(64),
    );
    expect(() => resumeFakePublication(state, crashStep)).toThrow(
      InjectedCrash,
    );
    resumeFakePublication(state);
    resumeFakePublication(state);
    expect(state.completed).toEqual(publicationSteps);
    expect(state.cutoverCount).toBe(1);
    expect(state.remoteHead).toBe(state.commitSha);
    expect(state.liveRelease).toBe(state.previewRelease);
  });

  it("blocks compare-and-swap when remote head advances", () => {
    const state = createFakePublication("publication-cas", "c".repeat(64));
    state.remoteHead = "d".repeat(40);
    expect(() => resumeFakePublication(state)).toThrow("REMOTE_HEAD_ADVANCED");
    expect(state.liveRelease).toBe(state.previousRelease);
  });
});
