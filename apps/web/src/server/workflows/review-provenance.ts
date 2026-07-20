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

export function exactBundleBaseMatchesOfficialSnapshot(
  artifacts: readonly {
    artifactId: string;
    baseHash: string | null;
    changeKind: string;
  }[],
  officialArtifacts: readonly {
    artifactId: string;
    contentHash: string;
  }[],
): boolean {
  const officialByArtifactId = new Map(
    officialArtifacts.map((artifact) => [artifact.artifactId, artifact]),
  );
  return artifacts.every((artifact) => {
    const official = officialByArtifactId.get(artifact.artifactId);
    if (artifact.changeKind === "ADD") return official === undefined;
    return Boolean(
      artifact.baseHash && official?.contentHash === artifact.baseHash,
    );
  });
}

function exactManifestMatchesBundleArtifacts(
  manifest: BundleManifest,
  artifacts: readonly {
    path: string;
    type: string;
    baseHash: string | null;
    candidateHash: string;
    changeKind: string;
    noChangeRationale: string | null;
    artifact: { logicalId: string };
  }[],
): boolean {
  if (manifest.artifacts.length !== artifacts.length) return false;
  const manifestByLogicalId = new Map(
    manifest.artifacts.map((artifact) => [artifact.logicalId, artifact]),
  );
  return artifacts.every((artifact) => {
    const recorded = manifestByLogicalId.get(artifact.artifact.logicalId);
    return Boolean(
      recorded &&
      recorded.path === artifact.path &&
      recorded.type === artifact.type &&
      recorded.baseHash === artifact.baseHash &&
      recorded.candidateHash === artifact.candidateHash &&
      recorded.changeKind === artifact.changeKind &&
      recorded.noChangeRationale === artifact.noChangeRationale,
    );
  });
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
    recoveryTargetCode?: string;
    now?: Date;
  },
) {
  if (!isRepositoryReviewerId(input.repositoryReviewerId))
    throw new Error("REVIEWER_IDENTITY_REQUIRED");
  const now = input.now ?? new Date();

  for (let attempt = 1; attempt <= 3; attempt += 1)
    try {
      return await database.$transaction(
        async (transaction) => {
          await transaction.$executeRaw`SELECT id FROM proposed_bundles WHERE id = ${input.bundleId}::uuid FOR UPDATE`;
          const source = await transaction.proposedBundle.findUnique({
            where: { id: input.bundleId },
            include: {
              artifacts: { include: { artifact: true, content: true } },
              validations: true,
              comments: { where: { status: "OPEN" } },
              draft: true,
              approvals: {
                orderBy: { approvedAt: "desc" },
                take: 1,
              },
              publicationRequests: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { databasePublication: true },
              },
            },
          });
          if (
            !source ||
            !["HUMAN_REVIEW", "APPROVED"].includes(source.state) ||
            source.draft.staleReason
          )
            throw new Error("BUNDLE_NOT_REVIEWABLE");

          const parsedSourceManifest = bundleManifestSchema.safeParse(
            source.manifest,
          );
          if (
            !parsedSourceManifest.success ||
            canonicalBundleHash(parsedSourceManifest.data) !==
              source.canonicalHash ||
            !exactManifestMatchesBundleArtifacts(
              parsedSourceManifest.data,
              source.artifacts,
            ) ||
            !exactArtifactsMatchStoredHashes(source.artifacts)
          )
            throw new Error("SOURCE_MANIFEST_MISMATCH");

          const alreadyPrepared = readPreparedReviewProvenance(
            source.decisionLedger,
          );
          const latestPublicationRequest = source.publicationRequests[0];
          const recoveringFailedPreview = Boolean(
            input.recoveryTargetCode &&
            latestPublicationRequest?.state === "FAILED_PREVIEW",
          );
          const reviewDate =
            recoveringFailedPreview && alreadyPrepared
              ? alreadyPrepared.reviewDate
              : calendarDate(now);
          if (
            source.state === "HUMAN_REVIEW" &&
            !recoveringFailedPreview &&
            alreadyPrepared?.repositoryReviewerId ===
              input.repositoryReviewerId &&
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
            return {
              bundle: source,
              created: false,
              provenance: alreadyPrepared,
              recovered: false,
            };

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
          if (source.state === "APPROVED" && !recoveringFailedPreview)
            throw new Error("DATABASE_RECOVERY_REQUIRED");

          let recovery:
            | {
                requestId: string;
                targetId: string;
                baseContentSnapshotId: string;
                baseContentSnapshotHash: string;
              }
            | undefined;
          if (recoveringFailedPreview) {
            if (!input.recoveryTargetCode)
              throw new Error("DATABASE_RECOVERY_REQUIRED");
            await transaction.$executeRaw`SELECT id FROM publication_targets WHERE code = ${input.recoveryTargetCode} FOR UPDATE`;
            const target = await transaction.publicationTarget.findUnique({
              where: { code: input.recoveryTargetCode },
              include: { officialSnapshot: true },
            });
            const failedRequest = latestPublicationRequest;
            const approval = source.approvals[0];
            const activeCheckout =
              await transaction.situationCheckout.findFirst({
                where: { situationId: source.situationId, releasedAt: null },
              });
            const activePublication = target
              ? await transaction.publicationRequest.findFirst({
                  where: {
                    publicationTargetId: target.id,
                    state: {
                      notIn: [
                        "RECONCILED",
                        "FAILED_PREVIEW",
                        "AUTO_ROLLED_BACK",
                      ],
                    },
                  },
                  select: { id: true },
                })
              : null;
            const activeRollback = target
              ? await transaction.rollbackRequest.findFirst({
                  where: {
                    publicationTargetId: target.id,
                    state: {
                      notIn: [
                        "RECONCILED",
                        "FAILED_PREVIEW",
                        "AUTO_ROLLED_BACK",
                      ],
                    },
                  },
                  select: { id: true },
                })
              : null;
            const officialArtifacts = target?.officialSnapshot
              ? await transaction.contentSnapshotArtifact.findMany({
                  where: {
                    snapshotId: target.officialSnapshot.id,
                    artifactId: {
                      in: source.artifacts.map(
                        (artifact) => artifact.artifactId,
                      ),
                    },
                  },
                  select: { artifactId: true, contentHash: true },
                })
              : [];
            if (
              !target?.officialSnapshot ||
              target.officialSnapshot.validationState !== "VALIDATED" ||
              target.candidateSnapshotId ||
              target.candidatePublicationRequestId ||
              target.candidateRollbackRequestId ||
              activePublication ||
              activeRollback ||
              !failedRequest ||
              failedRequest.state !== "FAILED_PREVIEW" ||
              failedRequest.finalConfirmedAt ||
              failedRequest.bundleHash !== source.canonicalHash ||
              (failedRequest.databasePublication &&
                (failedRequest.databasePublication.state !== "FAILED_PREVIEW" ||
                  failedRequest.databasePublication.terminalOutcome !==
                    "FAILED_BEFORE_CONFIRMATION")) ||
              !approval ||
              approval.bundleHash !== source.canonicalHash ||
              approval.baseCommit !== source.baseCommit ||
              approval.approvedById !== input.userId ||
              approval.repositoryReviewerId !== input.repositoryReviewerId ||
              (source.state === "APPROVED"
                ? approval.invalidatedAt !== null
                : !approval.invalidatedAt ||
                  approval.invalidationReason !== "BLOCKING_COMMENT_ADDED") ||
              source.comments.some((comment) => comment.blocking) ||
              !alreadyPrepared ||
              alreadyPrepared.preparedByUserId !== input.userId ||
              alreadyPrepared.repositoryReviewerId !==
                input.repositoryReviewerId ||
              alreadyPrepared.parentBundleId !== source.parentBundleId ||
              approval.contentReviewDate !== alreadyPrepared.reviewDate ||
              !source.validations.some(
                (validation) =>
                  validation.validator === "human-review-provenance" &&
                  validation.state === "PASSED" &&
                  validation.bundleHash === source.canonicalHash,
              ) ||
              !exactArtifactsMatchReviewProvenance(
                source.artifacts,
                alreadyPrepared,
              ) ||
              !activeCheckout ||
              activeCheckout.holderUserId !== input.userId ||
              activeCheckout.custody !== "USER" ||
              activeCheckout.draftId !== source.draftId ||
              activeCheckout.expiresAt <= now ||
              parsedSourceManifest.data.relationshipChanges.length !== 0 ||
              !exactBundleBaseMatchesOfficialSnapshot(
                source.artifacts,
                officialArtifacts,
              )
            )
              throw new Error("FAILED_PREVIEW_RECOVERY_PRECONDITIONS_FAILED");
            recovery = {
              requestId: failedRequest.id,
              targetId: target.id,
              baseContentSnapshotId: target.officialSnapshot.id,
              baseContentSnapshotHash: target.officialSnapshot.manifestHash,
            };
          }
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
                : artifact.changeKind === "DELETE"
                  ? ("DELETE" as const)
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
          if (candidateFindings.length)
            throw new Error("CANDIDATE_SAFETY_FAILED");

          const priorManifest = parsedSourceManifest.data as BundleManifest;
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
            recovery
              ? `human-review-provenance-v1:${source.canonicalHash}:${recovery.baseContentSnapshotId}`
              : `human-review-provenance-v1:${source.canonicalHash}`,
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
              baseContentSnapshotId:
                recovery?.baseContentSnapshotId ?? source.baseContentSnapshotId,
              baseManifestHash: source.baseManifestHash,
              briefHash: source.briefHash,
              graphHash: source.graphHash,
              canonicalHash,
              manifest,
              decisionLedger: asInputJson({
                ...priorLedger,
                humanReviewProvenance: provenance,
                ...(recovery
                  ? {
                      databaseFailedPreviewRecovery: {
                        recoveredFromRequestId: recovery.requestId,
                        publicationTargetId: recovery.targetId,
                        baseContentSnapshotId: recovery.baseContentSnapshotId,
                        baseContentSnapshotHash:
                          recovery.baseContentSnapshotHash,
                        recoveredAt: now.toISOString(),
                      },
                    }
                  : {}),
              }),
              ...(source.contradictionMatrix !== null
                ? {
                    contradictionMatrix: asInputJson(
                      source.contradictionMatrix,
                    ),
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
            ...(recovery
              ? [
                  {
                    validator: "database-base-recovery",
                    summary: `Recovered failed preview ${recovery.requestId} only after every affected artifact base matched official snapshot ${recovery.baseContentSnapshotHash}.`,
                  },
                ]
              : []),
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
          if (recovery)
            await transaction.draft.update({
              where: { id: source.draftId },
              data: { state: "HUMAN_REVIEW" },
            });
          return {
            bundle: child,
            created: true,
            provenance,
            recovered: Boolean(recovery),
          };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (
        attempt === 3 ||
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034"
      )
        throw error;
    }
  throw new Error("SERIALIZABLE_RETRY_EXHAUSTED");
}
