import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { sha256 } from "@situation-studio/domain";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { audit } from "@/server/audit";

const paramsSchema = z.object({ id: z.string().uuid() });

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
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const publication = await database().publicationRequest.findUnique({
    where: { id: parsed.data.id },
    include: { databasePublication: true, publicationTarget: true },
  });
  if (
    !publication?.databasePublication?.candidateSnapshotId ||
    !publication.candidateContentSnapshotHash ||
    !publication.publicationTarget ||
    publication.publicationTarget.candidateSnapshotId !==
      publication.databasePublication.candidateSnapshotId ||
    ![
      "CANDIDATE_AVAILABLE",
      "CANDIDATE_VERIFIED",
      "AWAITING_CONFIRMATION",
    ].includes(publication.databasePublication.state)
  )
    return NextResponse.json(
      { error: "candidate is unavailable" },
      { status: 409 },
    );
  const exchangeToken = randomBytes(32).toString("hex");
  const authorization = await database().candidateAuthorization.create({
    data: {
      publicationRequestId: publication.id,
      targetId: publication.publicationTarget.id,
      snapshotId: publication.databasePublication.candidateSnapshotId,
      snapshotHash: publication.candidateContentSnapshotHash,
      reviewerId: auth.session.userId,
      exchangeTokenHash: sha256(exchangeToken),
      audience: environment().LEADERSHIP_CANDIDATE_AUDIENCE,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "publication.candidate_authorize",
    targetType: "candidate_authorization",
    targetId: authorization.id,
    targetVersion: publication.candidateContentSnapshotHash,
    outcome: "SUCCEEDED",
    after: {
      publicationRequestId: publication.id,
      expiresAt: authorization.expiresAt,
    },
  });
  return NextResponse.json({
    exchangeToken,
    candidateUrl: new URL(
      "/candidate",
      environment().LEADERSHIP_CANDIDATE_ORIGIN,
    ).toString(),
    expiresAt: authorization.expiresAt,
  });
}
