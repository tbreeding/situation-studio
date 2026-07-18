import { Prisma, type DatabaseClient } from "@situation-studio/db";
import {
  bundleManifestSchema,
  canonicalBundleHash,
  finalizeHumanReviewProvenance,
  hasHumanReviewProvenance,
  isIsoReviewDate,
  isRepositoryReviewerId,
  requiresHumanReviewProvenance,
  sha256,
  type BundleManifest,
} from "@situation-studio/domain";
import { inspectCandidateText } from "@situation-studio/validator";

export type PreparedReviewProvenance = {
  repositoryReviewerId: string;
  reviewDate: string;
  preparedByUserId: string;
  preparedAt: string;
  parentBundleId: string;
};

export function calendarDate(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function readPreparedReviewProvenance(
  decisionLedger: unknown,
): PreparedReviewProvenance | null {
  if (
    !decisionLedger ||
    typeof decisionLedger !== "object" ||
    Array.isArray(decisionLedger)
  )
    return null;
  const candidate = (decisionLedger as { humanReviewProvenance?: unknown })
    .humanReviewProvenance;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
    return null;
  const value = candidate as Record<string, unknown>;
  if (
    typeof value.repositoryReviewerId !== "string" ||
    !isRepositoryReviewerId(value.repositoryReviewerId) ||
    typeof value.reviewDate !== "string" ||
    !isIsoReviewDate(value.reviewDate) ||
    typeof value.preparedByUserId !== "string" ||
    typeof value.preparedAt !== "string" ||
    Number.isNaN(new Date(value.preparedAt).getTime()) ||
    typeof value.parentBundleId !== "string"
  )
    return null;
  return {
    repositoryReviewerId: value.repositoryReviewerId,
    reviewDate: value.reviewDate,
    preparedByUserId: value.preparedByUserId,
    preparedAt: value.preparedAt,
    parentBundleId: value.parentBundleId,
  };
}

export function exactArtifactsMatchReviewProvenance(
  artifacts: readonly {
    path: string;
    changeKind: string;
    content: { body: string };
  }[],
  provenance: Pick<
    PreparedReviewProvenance,
    "repositoryReviewerId" | "reviewDate"
  >,
): boolean {
  return artifacts
    .filter(
      (artifact) =>
        !["NO_CHANGE", "DELETE"].includes(artifact.changeKind) &&
        requiresHumanReviewProvenance(artifact.path),
    )
    .every((artifact) =>
      hasHumanReviewProvenance(artifact.content.body, {
        reviewer: provenance.repositoryReviewerId,
        lastReviewed: provenance.reviewDate,
      }),
    );
}

export function exactArtifactsMatchStoredHashes(
  artifacts: readonly {
    candidateHash: string;
    contentHash: string;
    content: { body: string };
  }[],
): boolean {
  return artifacts.every(
    (artifact) =>
      artifact.candidateHash === artifact.contentHash &&
      sha256(artifact.content.body) === artifact.candidateHash,
  );
}

function asInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function prepareBundleForHumanApproval(
  database: DatabaseClient,
  input: {
    bundleId: string;
    userId: string;
    repositoryReviewerId: string;
    now?: Date;
  },
) {
  if (!isRepositoryReviewerId(input.repositoryReviewerId))
    throw new Error("REVIEWER_IDENTITY_REQUIRED");
  const now = input.now ?? new Date();
  const reviewDate = calendarDate(now);

  return database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT id FROM proposed_bundles WHERE id = ${input.bundleId}::uuid FOR UPDATE`;
      const source = await transaction.proposedBundle.findUnique({
        where: { id: input.bundleId },
        include: {
          artifacts: { include: { artifact: true, content: true } },
          validations: true,
          comments: { where: { status: "OPEN" } },
          draft: true,
        },
      });
      if (
        !source ||
        source.state !== "HUMAN_REVIEW" ||
        source.draft.staleReason
      )
        throw new Error("BUNDLE_NOT_REVIEWABLE");

      const alreadyPrepared = readPreparedReviewProvenance(
        source.decisionLedger,
      );
      if (
        alreadyPrepared?.repositoryReviewerId === input.repositoryReviewerId &&
        alreadyPrepared.preparedByUserId === input.userId &&
        source.validations.some(
          (validation) =>
            validation.validator === "human-review-provenance" &&
            validation.state === "PASSED" &&
            validation.bundleHash === source.canonicalHash,
        ) &&
        exactArtifactsMatchReviewProvenance(
          source.artifacts,
          alreadyPrepared,
        ) &&
        exactArtifactsMatchStoredHashes(source.artifacts)
      )
        return { bundle: source, created: false, provenance: alreadyPrepared };

      await transaction.$executeRaw`SELECT id FROM situations WHERE id = ${source.situationId}::uuid FOR UPDATE`;
      const current = await transaction.proposedBundle.findFirst({
        where: {
          draftId: source.draftId,
          state: { notIn: ["STALE", "PUBLISHED"] },
        },
        orderBy: { revision: "desc" },
        select: { id: true },
      });
      if (current?.id !== source.id) throw new Error("BUNDLE_NOT_CURRENT");
      if (
        !source.validations.length ||
        source.validations.some(
          (validation) =>
            validation.state !== "PASSED" ||
            validation.bundleHash !== source.canonicalHash,
        )
      )
        throw new Error("SOURCE_VALIDATION_FAILED");
      for (const requiredValidator of [
        "required-role-completion",
        "candidate-safety",
        "contradiction-audit",
      ])
        if (
          !source.validations.some(
            (validation) => validation.validator === requiredValidator,
          )
        )
          throw new Error("SOURCE_VALIDATION_POLICY_INCOMPLETE");

      const latest = await transaction.proposedBundle.aggregate({
        where: { situationId: source.situationId },
        _max: { revision: true },
      });
      const revision = (latest._max.revision ?? 0) + 1;
      const bundleItems = source.artifacts.map((artifact) => {
        const shouldFinalize =
          !["NO_CHANGE", "DELETE"].includes(artifact.changeKind) &&
          requiresHumanReviewProvenance(artifact.path);
        const body = shouldFinalize
          ? finalizeHumanReviewProvenance(artifact.content.body, {
              reviewer: input.repositoryReviewerId,
              lastReviewed: reviewDate,
            })
          : artifact.content.body;
        const candidateHash = sha256(body);
        const changeKind =
          artifact.changeKind === "ADD"
            ? ("ADD" as const)
            : candidateHash === artifact.baseHash
              ? ("NO_CHANGE" as const)
              : ("MODIFY" as const);
        return {
          ...artifact,
          body,
          candidateHash,
          contentHash: candidateHash,
          changeKind,
          noChangeRationale:
            changeKind === "NO_CHANGE"
              ? (artifact.noChangeRationale ??
                "Reviewed by the complete workflow; no repository change required.")
              : null,
        };
      });
      const candidateFindings = bundleItems.flatMap((artifact) => {
        if (/\.(?:md|mdx)$/u.test(artifact.path))
          return inspectCandidateText(artifact.path, artifact.body);
        if (/\.json$/u.test(artifact.path))
          try {
            JSON.parse(artifact.body);
          } catch {
            return [
              {
                code: "INVALID_JSON",
                path: artifact.path,
                message: "Candidate JSON could not be parsed.",
              },
            ];
          }
        return [];
      });
      if (candidateFindings.length) throw new Error("CANDIDATE_SAFETY_FAILED");

      const priorManifest = bundleManifestSchema.parse(
        source.manifest,
      ) as BundleManifest;
      const manifest: BundleManifest = {
        ...priorManifest,
        revision,
        artifacts: bundleItems.map((artifact) => ({
          logicalId: artifact.artifact.logicalId,
          type: artifact.type,
          path: artifact.path,
          baseHash: artifact.baseHash,
          candidateHash: artifact.candidateHash,
          changeKind: artifact.changeKind,
          noChangeRationale: artifact.noChangeRationale,
        })),
      };
      const canonicalHash = canonicalBundleHash(manifest);
      const provenance: PreparedReviewProvenance = {
        repositoryReviewerId: input.repositoryReviewerId,
        reviewDate,
        preparedByUserId: input.userId,
        preparedAt: now.toISOString(),
        parentBundleId: source.id,
      };
      const priorLedger =
        source.decisionLedger &&
        typeof source.decisionLedger === "object" &&
        !Array.isArray(source.decisionLedger)
          ? source.decisionLedger
          : {};
      const environmentHash = sha256(
        `human-review-provenance-v1:${source.canonicalHash}`,
      );
      const child = await transaction.proposedBundle.create({
        data: {
          situationId: source.situationId,
          parentBundleId: source.id,
          revision,
          snapshotId: source.snapshotId,
          draftId: source.draftId,
          briefId: source.briefId,
          baseCommit: source.baseCommit,
          baseManifestHash: source.baseManifestHash,
          briefHash: source.briefHash,
          graphHash: source.graphHash,
          canonicalHash,
          manifest,
          decisionLedger: asInputJson({
            ...priorLedger,
            humanReviewProvenance: provenance,
          }),
          ...(source.contradictionMatrix !== null
            ? {
                contradictionMatrix: asInputJson(source.contradictionMatrix),
              }
            : {}),
          state: "HUMAN_REVIEW",
        },
      });
      for (const artifact of bundleItems) {
        await transaction.contentBlob.upsert({
          where: { hash: artifact.contentHash },
          create: {
            hash: artifact.contentHash,
            body: artifact.body,
            byteLength: Buffer.byteLength(artifact.body),
          },
          update: {},
        });
        await transaction.bundleArtifact.create({
          data: {
            bundleId: child.id,
            artifactId: artifact.artifactId,
            path: artifact.path,
            type: artifact.type,
            baseHash: artifact.baseHash,
            candidateHash: artifact.candidateHash,
            contentHash: artifact.contentHash,
            changeKind: artifact.changeKind,
            noChangeRationale: artifact.noChangeRationale,
          },
        });
      }
      for (const comment of source.comments)
        await transaction.comment.create({
          data: {
            bundleId: child.id,
            artifactId: comment.artifactId,
            authorId: comment.authorId,
            body: comment.body,
            blocking: comment.blocking,
            ...(comment.anchor !== null
              ? { anchor: asInputJson(comment.anchor) }
              : {}),
          },
        });
      const validationSummaries = [
        {
          validator: "required-role-completion",
          summary: `Inherited completed AI role evidence from parent bundle ${source.canonicalHash}.`,
        },
        {
          validator: "candidate-safety",
          summary:
            "The exact provenance-finalized candidate bytes passed instant safety checks.",
        },
        {
          validator: "contradiction-audit",
          summary: `Inherited contradiction evidence from parent bundle ${source.canonicalHash}; only reviewer provenance changed.`,
        },
        {
          validator: "human-review-provenance",
          summary: `Changed public MDX identifies ${input.repositoryReviewerId} with review date ${reviewDate}.`,
        },
      ];
      for (const validation of validationSummaries)
        await transaction.validationRun.create({
          data: {
            bundleId: child.id,
            bundleHash: canonicalHash,
            validator: validation.validator,
            version: "provenance-v1",
            environmentHash,
            state: "PASSED",
            summary: validation.summary,
            outputHash: sha256(validation.summary),
            startedAt: now,
            finishedAt: now,
          },
        });
      await transaction.proposedBundle.update({
        where: { id: source.id },
        data: { state: "STALE" },
      });
      return { bundle: child, created: true, provenance };
    },
    { isolationLevel: "Serializable" },
  );
}
