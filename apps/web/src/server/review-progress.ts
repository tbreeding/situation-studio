import { database } from "@/server/database";
import type {
  ReviewJobSnapshot,
  ReviewJobState,
} from "@/lib/review-presentation";

export async function reviewJobSnapshotById(jobId: string): Promise<{
  ownerId: string;
  situationId: string;
  snapshot: ReviewJobSnapshot;
} | null> {
  const job = await database().aiJob.findUnique({
    where: { id: jobId },
    include: { steps: { orderBy: { createdAt: "asc" } } },
  });
  if (!job) return null;
  return {
    ownerId: job.ownerId,
    situationId: job.situationId,
    snapshot: {
      id: job.id,
      state: job.state as ReviewJobState,
      stage: job.stage,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      observedAt: new Date().toISOString(),
      steps: job.steps.map((step) => ({
        role: step.role,
        state: step.state,
        updatedAt: step.updatedAt.toISOString(),
      })),
    },
  };
}
