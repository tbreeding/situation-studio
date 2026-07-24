declare global {
  var situationStudioObservationTimer: NodeJS.Timeout | undefined;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reconcileLeadershipRelease } =
    await import("@/server/leadership-sync");
  if (!globalThis.situationStudioObservationTimer) {
    const timer = setInterval(() => {
      void reconcileLeadershipRelease({ force: true }).catch(() => undefined);
    }, 30_000);
    timer.unref();
    globalThis.situationStudioObservationTimer = timer;
  }
}
