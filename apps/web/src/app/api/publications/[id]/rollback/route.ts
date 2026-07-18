import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { sha256 } from "@situation-studio/domain";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { audit } from "@/server/audit";

const schema = z.object({ reason: z.string().trim().min(8).max(500) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "publication.publish");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  if (
    !auth.session.reauthenticatedAt ||
    auth.session.reauthenticatedAt.getTime() < Date.now() - 15 * 60 * 1000
  )
    return NextResponse.json(
      { error: "recent reauthentication required" },
      { status: 403 },
    );
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      { error: "rollback reason required" },
      { status: 400 },
    );
  if (environment().PROVIDER_EXECUTION_MODE !== "fake")
    return NextResponse.json(
      { error: "rollback must be executed by the publisher service" },
      { status: 503 },
    );
  const { id } = await params;
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey || idempotencyKey.length > 120)
    return NextResponse.json(
      { error: "idempotency key required" },
      { status: 400 },
    );
  const route = `/api/publications/${id}/rollback`;
  const requestHash = sha256(`${id}\0${parsed.data.reason}`);
  const replay = await database().idempotencyKey.findUnique({
    where: {
      actorId_route_key: {
        actorId: auth.session.userId,
        route,
        key: idempotencyKey,
      },
    },
  });
  if (replay) {
    if (replay.requestHash !== requestHash)
      return NextResponse.json(
        { error: "idempotency key reused with different input" },
        { status: 409 },
      );
    const publication = replay.responseRef
      ? await database().publication.findUnique({
          where: { id: replay.responseRef },
        })
      : null;
    if (publication)
      return NextResponse.json({
        publicationId: publication.id,
        commitSha: publication.commitSha,
        state: "ROLLED_BACK",
        reused: true,
      });
  }
  const target = await database().publication.findUnique({
    where: { id },
    include: { situation: true },
  });
  if (
    !target ||
    target.situation.currentPublicationId === target.id ||
    ![
      "IMPORTED_BASELINE",
      "VERIFIED_FAKE_ACCEPTANCE",
      "VERIFIED",
      "ROLLED_BACK_VERIFIED",
    ].includes(target.healthState)
  )
    return NextResponse.json(
      { error: "rollback preconditions failed" },
      { status: 409 },
    );
  const rollbackId = randomUUID();
  const commitSha = sha256(`rollback:${rollbackId}:${target.commitSha}`).slice(
    0,
    40,
  );
  const now = new Date();
  let publication;
  try {
    publication = await database().$transaction(
      async (transaction) => {
        const current = await transaction.situation.findUniqueOrThrow({
          where: { id: target.situationId },
        });
        const row = await transaction.publication.create({
          data: {
            situationId: target.situationId,
            versionId: target.versionId,
            kind: "ROLLBACK",
            commitSha,
            manifestHash: target.manifestHash,
            releaseId: `fake-rollback:${rollbackId}:${target.releaseId}`,
            previousPublicationId: current.currentPublicationId,
            publishedById: auth.session.userId,
            cutoverAt: now,
            healthState: "ROLLED_BACK_VERIFIED",
          },
        });
        await transaction.situation.update({
          where: { id: target.situationId },
          data: {
            currentPublicationId: row.id,
            publicationState: "ROLLED_BACK",
          },
        });
        await transaction.idempotencyKey.create({
          data: {
            actorId: auth.session.userId,
            route,
            key: idempotencyKey,
            requestHash,
            responseRef: row.id,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        return row;
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    const concurrentReplay = await database().idempotencyKey.findUnique({
      where: {
        actorId_route_key: {
          actorId: auth.session.userId,
          route,
          key: idempotencyKey,
        },
      },
    });
    if (
      concurrentReplay?.requestHash === requestHash &&
      concurrentReplay.responseRef
    ) {
      const existingPublication = await database().publication.findUnique({
        where: { id: concurrentReplay.responseRef },
      });
      if (existingPublication)
        return NextResponse.json({
          publicationId: existingPublication.id,
          commitSha: existingPublication.commitSha,
          state: "ROLLED_BACK",
          reused: true,
        });
    }
    throw error;
  }
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "publication.rollback",
    targetType: "publication",
    targetId: publication.id,
    targetVersion: target.manifestHash,
    outcome: "SUCCEEDED",
    reason: parsed.data.reason,
    after: {
      targetPublicationId: target.id,
      targetCommit: target.commitSha,
      rollbackCommit: commitSha,
    },
  });
  return NextResponse.json(
    { publicationId: publication.id, commitSha, state: "ROLLED_BACK" },
    { status: 201 },
  );
}
