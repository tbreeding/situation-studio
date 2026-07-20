import type { DatabaseClient } from "@situation-studio/db";

export async function createReviewComment(
  database: DatabaseClient,
  input: {
    bundleId: string;
    authorId: string;
    body: string;
    blocking: boolean;
    now?: Date;
  },
) {
  return database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT id FROM proposed_bundles WHERE id = ${input.bundleId}::uuid FOR UPDATE`;
      const bundle = await transaction.proposedBundle.findUnique({
        where: { id: input.bundleId },
      });
      if (!bundle || !["HUMAN_REVIEW", "APPROVED"].includes(bundle.state))
        throw new Error("BUNDLE_NOT_REVIEWABLE");
      const comment = await transaction.comment.create({
        data: {
          bundleId: bundle.id,
          authorId: input.authorId,
          body: input.body,
          blocking: input.blocking,
        },
      });
      if (input.blocking && bundle.state === "APPROVED") {
        const now = input.now ?? new Date();
        await transaction.approval.updateMany({
          where: { bundleId: bundle.id, invalidatedAt: null },
          data: {
            invalidatedAt: now,
            invalidationReason: "BLOCKING_COMMENT_ADDED",
          },
        });
        await transaction.proposedBundle.update({
          where: { id: bundle.id },
          data: { state: "HUMAN_REVIEW" },
        });
        await transaction.draft.update({
          where: { id: bundle.draftId },
          data: { state: "HUMAN_REVIEW" },
        });
      }
      return { comment, bundle };
    },
    { isolationLevel: "Serializable" },
  );
}
