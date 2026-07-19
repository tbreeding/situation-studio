import { sha256 } from "@situation-studio/domain";
import { describe, expect, it } from "vitest";
import {
  createFakePublication,
  InjectedCrash,
  publicationSteps,
  resumeFakePublication,
} from "../src/saga";

describe("publication crash recovery", () => {
  it("starts from the official baseline with no staged side effects", () => {
    const state = createFakePublication("publication-new", "b".repeat(64));
    expect(state).toEqual({
      publicationId: "publication-new",
      bundleHash: "b".repeat(64),
      baseHead: "a".repeat(40),
      remoteHead: "a".repeat(40),
      previousRelease: "release:previous",
      commitSha: null,
      previewRelease: null,
      liveRelease: "release:previous",
      completed: [],
      cutoverCount: 0,
    });
  });

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

  it.each(publicationSteps)(
    "records every step through %s before an injected crash",
    (crashStep) => {
      const state = createFakePublication(
        `publication-prefix-${crashStep}`,
        "c".repeat(64),
      );
      expect(() => resumeFakePublication(state, crashStep)).toThrowError(
        `Injected crash after ${crashStep}`,
      );
      const index = publicationSteps.indexOf(crashStep);
      expect(state.completed).toEqual(publicationSteps.slice(0, index + 1));
      expect(new Set(state.completed).size).toBe(state.completed.length);
    },
  );

  it.each(["WORKTREE_READY", "APPLIED", "VALIDATED"] as const)(
    "does not invent a commit after crashing at %s",
    (crashStep) => {
      const state = createFakePublication(
        `publication-no-commit-${crashStep}`,
        "d".repeat(64),
      );
      expect(() => resumeFakePublication(state, crashStep)).toThrow(
        InjectedCrash,
      );
      expect(state.commitSha).toBeNull();
      expect(state.previewRelease).toBeNull();
      expect(state.remoteHead).toBe(state.baseHead);
      expect(state.liveRelease).toBe(state.previousRelease);
    },
  );

  it.each([
    "COMMITTED",
    "PUSHED",
    "PREVIEW_BUILT",
    "PREVIEW_VERIFIED",
  ] as const)("does not cut over after crashing at %s", (crashStep) => {
    const state = createFakePublication(
      `publication-no-cutover-${crashStep}`,
      "e".repeat(64),
    );
    expect(() => resumeFakePublication(state, crashStep)).toThrow(
      InjectedCrash,
    );
    expect(state.commitSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(state.cutoverCount).toBe(0);
    expect(state.liveRelease).toBe(state.previousRelease);
  });

  it.each(["CUTOVER", "LIVE_VERIFIED", "RECONCILED"] as const)(
    "never repeats cutover after crashing at %s",
    (crashStep) => {
      const state = createFakePublication(
        `publication-cutover-${crashStep}`,
        "f".repeat(64),
      );
      expect(() => resumeFakePublication(state, crashStep)).toThrow(
        InjectedCrash,
      );
      const liveRelease = state.liveRelease;
      resumeFakePublication(state);
      resumeFakePublication(state);
      expect(state.cutoverCount).toBe(1);
      expect(state.liveRelease).toBe(liveRelease);
      expect(state.liveRelease).toBe(state.previewRelease);
    },
  );

  it("computes a stable commit identity from the publication and bundle", () => {
    const first = createFakePublication("publication-stable", "1".repeat(64));
    const second = createFakePublication("publication-stable", "1".repeat(64));
    resumeFakePublication(first);
    resumeFakePublication(second);
    expect(first.commitSha).toBe(second.commitSha);
    expect(first.commitSha).toBe(
      sha256(`publication-stable:${"1".repeat(64)}`).slice(0, 40),
    );
  });

  it.each([
    ["publication-different", "1".repeat(64)],
    ["publication-stable", "2".repeat(64)],
  ])("changes commit identity when identity inputs change", (id, hash) => {
    const baseline = createFakePublication(
      "publication-stable",
      "1".repeat(64),
    );
    const changed = createFakePublication(id, hash);
    resumeFakePublication(baseline);
    resumeFakePublication(changed);
    expect(changed.commitSha).not.toBe(baseline.commitSha);
  });

  it("accepts an idempotent preview push when remote already has the commit", () => {
    const state = createFakePublication(
      "publication-existing-push",
      "3".repeat(64),
    );
    expect(() => resumeFakePublication(state, "COMMITTED")).toThrow(
      InjectedCrash,
    );
    state.remoteHead = state.commitSha!;
    resumeFakePublication(state);
    expect(state.completed).toEqual(publicationSteps);
    expect(state.remoteHead).toBe(state.commitSha);
    expect(state.cutoverCount).toBe(1);
  });

  it("blocks compare-and-swap when remote head advances", () => {
    const state = createFakePublication("publication-cas", "4".repeat(64));
    state.remoteHead = "d".repeat(40);
    expect(() => resumeFakePublication(state)).toThrow("REMOTE_HEAD_ADVANCED");
    expect(state.completed).toEqual([
      "WORKTREE_READY",
      "APPLIED",
      "VALIDATED",
      "COMMITTED",
    ]);
    expect(state.previewRelease).toBeNull();
    expect(state.liveRelease).toBe(state.previousRelease);
    expect(state.cutoverCount).toBe(0);
  });

  it("preserves a caller-supplied baseline through publication", () => {
    const baseHead = "9".repeat(40);
    const state = createFakePublication(
      "publication-base",
      "5".repeat(64),
      baseHead,
    );
    resumeFakePublication(state);
    expect(state.baseHead).toBe(baseHead);
    expect(state.remoteHead).toBe(state.commitSha);
  });

  it("declares a unique, ordered, terminal saga", () => {
    expect(new Set(publicationSteps).size).toBe(publicationSteps.length);
    expect(publicationSteps[0]).toBe("WORKTREE_READY");
    expect(publicationSteps.at(-1)).toBe("RECONCILED");
    expect(publicationSteps.indexOf("PUSHED")).toBeLessThan(
      publicationSteps.indexOf("CUTOVER"),
    );
    expect(publicationSteps.indexOf("PREVIEW_VERIFIED")).toBeLessThan(
      publicationSteps.indexOf("CUTOVER"),
    );
  });
});
