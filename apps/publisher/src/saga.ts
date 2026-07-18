import { sha256 } from "@situation-studio/domain";

export const publicationSteps = [
  "WORKTREE_READY",
  "APPLIED",
  "VALIDATED",
  "COMMITTED",
  "PUSHED",
  "PREVIEW_BUILT",
  "PREVIEW_VERIFIED",
  "CUTOVER",
  "LIVE_VERIFIED",
  "RECONCILED",
] as const;
export type PublicationStepName = (typeof publicationSteps)[number];

export type FakePublicationState = {
  publicationId: string;
  bundleHash: string;
  baseHead: string;
  remoteHead: string;
  previousRelease: string;
  commitSha: string | null;
  previewRelease: string | null;
  liveRelease: string;
  completed: PublicationStepName[];
  cutoverCount: number;
};

export class InjectedCrash extends Error {
  constructor(public readonly afterStep: PublicationStepName) {
    super(`Injected crash after ${afterStep}`);
  }
}

export function createFakePublication(
  publicationId: string,
  bundleHash: string,
  baseHead = "a".repeat(40),
): FakePublicationState {
  return {
    publicationId,
    bundleHash,
    baseHead,
    remoteHead: baseHead,
    previousRelease: "release:previous",
    commitSha: null,
    previewRelease: null,
    liveRelease: "release:previous",
    completed: [],
    cutoverCount: 0,
  };
}

function applyStep(state: FakePublicationState, step: PublicationStepName) {
  if (step === "COMMITTED")
    state.commitSha ??= sha256(
      `${state.publicationId}:${state.bundleHash}`,
    ).slice(0, 40);
  if (step === "PUSHED") {
    if (
      state.remoteHead !== state.baseHead &&
      state.remoteHead !== state.commitSha
    )
      throw new Error("REMOTE_HEAD_ADVANCED");
    state.remoteHead = state.commitSha!;
  }
  if (step === "PREVIEW_BUILT")
    state.previewRelease ??= `preview:${state.commitSha}`;
  if (step === "CUTOVER" && state.liveRelease !== state.previewRelease) {
    state.liveRelease = state.previewRelease!;
    state.cutoverCount += 1;
  }
  state.completed.push(step);
}

export function resumeFakePublication(
  state: FakePublicationState,
  crashAfter?: PublicationStepName,
): FakePublicationState {
  for (const step of publicationSteps) {
    if (state.completed.includes(step)) continue;
    applyStep(state, step);
    if (crashAfter === step) throw new InjectedCrash(step);
  }
  return state;
}
