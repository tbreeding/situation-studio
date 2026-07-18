import { sha256 } from "@situation-studio/domain";
import type { DatabaseClient } from "@situation-studio/db";

const LEASE_MS = 30 * 60 * 1000;

export async function acquireCheckout(
  database: DatabaseClient,
  input: {
    situationId: string;
    userId: string;
    mode: "EDITING" | "HUMAN_REVIEW" | "APPROVED" | "ARCHIVING" | "RESTORING";
  },
  now = new Date(),
) {
  return database.$transaction(
    async (transaction) => {
      await transaction.$executeRaw`SELECT id FROM situations WHERE id = ${input.situationId}::uuid FOR UPDATE`;
      const situation = await transaction.situation.findUniqueOrThrow({
        where: { id: input.situationId },
        include: { currentPublication: true },
      });
      const active = await transaction.situationCheckout.findFirst({
        where: { situationId: input.situationId, releasedAt: null },
        include: { holder: true },
      });
      if (active && active.custody === "USER" && active.expiresAt <= now) {
        await transaction.situationCheckout.update({
          where: { id: active.id },
          data: { releasedAt: now, releaseReason: "LEASE_EXPIRED" },
        });
        await transaction.checkoutResource.updateMany({
          where: { checkoutId: active.id, releasedAt: null },
          data: { releasedAt: now },
        });
      } else if (active) {
        return { ok: false as const, checkout: active };
      }

      let draft = await transaction.draft.findFirst({
        where: { situationId: input.situationId, active: true },
        include: {
          revisions: {
            orderBy: { revision: "desc" },
            take: 1,
            include: { artifacts: true },
          },
        },
      });
      if (!draft) {
        const baseVersion = situation.currentPublication?.versionId
          ? await transaction.situationVersion.findUniqueOrThrow({
              where: { id: situation.currentPublication.versionId },
              include: { artifacts: true },
            })
          : await transaction.situationVersion.findFirstOrThrow({
              where: { situationId: input.situationId },
              orderBy: { createdAt: "asc" },
              include: { artifacts: true },
            });
        draft = await transaction.draft.create({
          data: {
            situationId: input.situationId,
            baseVersionId: baseVersion.id,
            baseSnapshotId: baseVersion.snapshotId,
            currentRevision: 1,
            state: "DRAFTING",
          },
          include: { revisions: { include: { artifacts: true } } },
        });
        const revision = await transaction.draftRevision.create({
          data: {
            draftId: draft.id,
            revision: 1,
            manifestHash: baseVersion.manifestHash,
            actorId: input.userId,
            materialChange: false,
            semanticChange: false,
          },
        });
        for (const artifact of baseVersion.artifacts)
          await transaction.draftArtifact.create({
            data: {
              revisionId: revision.id,
              artifactId: artifact.artifactId,
              path: artifact.path,
              type: artifact.type,
              contentHash: artifact.contentHash,
              changeKind: "NO_CHANGE",
            },
          });
      }
      const fencingToken = situation.fence + 1n;
      await transaction.situation.update({
        where: { id: input.situationId },
        data: { fence: fencingToken },
      });
      const checkout = await transaction.situationCheckout.create({
        data: {
          situationId: input.situationId,
          holderUserId: input.userId,
          mode: input.mode,
          custody: "USER",
          draftId: draft.id,
          fencingToken,
          acquiredAt: now,
          renewedAt: now,
          expiresAt: new Date(now.getTime() + LEASE_MS),
        },
      });
      await transaction.checkoutResource.create({
        data: {
          checkoutId: checkout.id,
          situationId: input.situationId,
          resourceKey: `situation:${input.situationId}`,
          purpose: input.mode,
        },
      });
      return { ok: true as const, checkout, draft };
    },
    { isolationLevel: "Serializable", timeout: 10_000 },
  );
}

export async function renewCheckout(
  database: DatabaseClient,
  input: { checkoutId: string; userId: string; fencingToken: bigint },
  now = new Date(),
) {
  const checkout = await database.situationCheckout.findUnique({
    where: { id: input.checkoutId },
  });
  if (
    !checkout ||
    checkout.releasedAt ||
    checkout.holderUserId !== input.userId ||
    checkout.fencingToken !== input.fencingToken ||
    checkout.custody !== "USER" ||
    checkout.expiresAt <= now
  )
    return false;
  await database.situationCheckout.update({
    where: { id: checkout.id },
    data: { renewedAt: now, expiresAt: new Date(now.getTime() + LEASE_MS) },
  });
  return true;
}

export async function saveDraft(
  database: DatabaseClient,
  input: {
    draftId: string;
    checkoutId: string;
    userId: string;
    fencingToken: bigint;
    expectedRevision: number;
    clientMutationId: string;
    artifactId: string;
    body: string;
  },
  now = new Date(),
) {
  return database.$transaction(
    async (transaction) => {
      const checkout = await transaction.situationCheckout.findUnique({
        where: { id: input.checkoutId },
      });
      if (
        !checkout ||
        checkout.releasedAt ||
        checkout.expiresAt <= now ||
        checkout.custody !== "USER" ||
        checkout.holderUserId !== input.userId ||
        checkout.fencingToken !== input.fencingToken ||
        checkout.draftId !== input.draftId
      )
        return { ok: false as const, status: 423 as const };
      const draft = await transaction.draft.findUniqueOrThrow({
        where: { id: input.draftId },
      });
      if (draft.currentRevision !== input.expectedRevision)
        return {
          ok: false as const,
          status: 409 as const,
          revision: draft.currentRevision,
        };
      const prior = await transaction.draftRevision.findUniqueOrThrow({
        where: {
          draftId_revision: {
            draftId: draft.id,
            revision: draft.currentRevision,
          },
        },
        include: { artifacts: true },
      });
      if (
        !prior.artifacts.some(
          (artifact) => artifact.artifactId === input.artifactId,
        )
      )
        throw new Error("Artifact is not part of this draft");
      const contentHash = sha256(input.body);
      await transaction.contentBlob.upsert({
        where: { hash: contentHash },
        create: {
          hash: contentHash,
          body: input.body,
          byteLength: Buffer.byteLength(input.body),
        },
        update: {},
      });
      const nextRevision = draft.currentRevision + 1;
      const manifestHash = sha256(
        JSON.stringify(
          prior.artifacts
            .map((artifact) => ({
              artifactId: artifact.artifactId,
              hash:
                artifact.artifactId === input.artifactId
                  ? contentHash
                  : artifact.contentHash,
            }))
            .sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
        ),
      );
      const revision = await transaction.draftRevision.create({
        data: {
          draftId: draft.id,
          revision: nextRevision,
          parentRevisionId: prior.id,
          manifestHash,
          actorId: input.userId,
          clientMutationId: input.clientMutationId,
        },
      });
      for (const artifact of prior.artifacts)
        await transaction.draftArtifact.create({
          data: {
            revisionId: revision.id,
            artifactId: artifact.artifactId,
            path: artifact.path,
            type: artifact.type,
            contentHash:
              artifact.artifactId === input.artifactId
                ? contentHash
                : artifact.contentHash,
            changeKind:
              artifact.artifactId === input.artifactId
                ? "MODIFY"
                : artifact.changeKind,
          },
        });
      const updated = await transaction.draft.updateMany({
        where: { id: draft.id, currentRevision: input.expectedRevision },
        data: { currentRevision: nextRevision, state: "DRAFTING" },
      });
      if (updated.count !== 1) throw new Error("STALE_DRAFT");
      await transaction.approval.updateMany({
        where: { bundle: { draftId: draft.id }, invalidatedAt: null },
        data: { invalidatedAt: now, invalidationReason: "MATERIAL_DRAFT_EDIT" },
      });
      await transaction.proposedBundle.updateMany({
        where: { draftId: draft.id, state: { notIn: ["STALE", "PUBLISHED"] } },
        data: { state: "STALE" },
      });
      return {
        ok: true as const,
        revision: nextRevision,
        etag: `"draft-${draft.id}-${nextRevision}"`,
        contentHash,
      };
    },
    { isolationLevel: "Serializable", timeout: 10_000 },
  );
}
