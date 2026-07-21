import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@situation-studio/db";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { attestationKeyMatches } from "@/lib/service-auth";
import {
  leadershipObservationSchema,
  leadershipObservationSignedBody,
} from "@/lib/leadership-observation";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = leadershipObservationSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success)
    return NextResponse.json({ error: "invalid receipt" }, { status: 400 });
  const observedAt = new Date(parsed.data.observedAt);
  if (
    observedAt.getTime() < Date.now() - 5 * 60 * 1000 ||
    observedAt.getTime() > Date.now() + 60 * 1000
  )
    return NextResponse.json({ error: "stale receipt" }, { status: 409 });
  const secret = environment().LEADERSHIP_ATTESTATION_SECRET;
  if (!secret)
    return NextResponse.json(
      { error: "attestation disabled" },
      { status: 503 },
    );
  if (
    !attestationKeyMatches(
      environment().LEADERSHIP_ATTESTATION_KEY_ID,
      parsed.data.attestationKeyId,
    )
  )
    return NextResponse.json({ error: "invalid attestation" }, { status: 403 });
  const expected = createHmac("sha256", secret)
    .update(leadershipObservationSignedBody(id, parsed.data))
    .digest();
  const supplied = Buffer.from(parsed.data.receiptDigest, "hex");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return NextResponse.json({ error: "invalid attestation" }, { status: 403 });
  const publication = await database().databasePublication.findFirst({
    where: {
      OR: [{ publicationRequestId: id }, { rollbackRequestId: id }],
    },
    include: {
      target: true,
      candidateSnapshot: { select: { manifestHash: true } },
    },
  });
  if (!publication)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  if (
    parsed.data.observationKind === "CANDIDATE" &&
    (publication.candidateSnapshotId !== parsed.data.snapshotId ||
      publication.candidateSnapshot?.manifestHash !==
        parsed.data.snapshotHash ||
      publication.target.candidateSnapshotId !== parsed.data.snapshotId ||
      publication.target.currentDatabasePublicationId !== publication.id ||
      (publication.publicationRequestId === id
        ? publication.target.candidatePublicationRequestId !== id ||
          publication.target.candidateRollbackRequestId !== null
        : publication.rollbackRequestId !== id ||
          publication.target.candidateRollbackRequestId !== id ||
          publication.target.candidatePublicationRequestId !== null) ||
      ![
        "CANDIDATE_AVAILABLE",
        "CANDIDATE_VERIFIED",
        "AWAITING_CONFIRMATION",
      ].includes(publication.state))
  )
    return NextResponse.json(
      { error: "receipt does not match active candidate" },
      { status: 409 },
    );
  const existing = await database().leadershipObservationReceipt.findUnique({
    where: { receiptDigest: parsed.data.receiptDigest },
  });
  if (existing)
    return NextResponse.json({ receiptId: existing.id, reused: true });
  let receipt;
  try {
    receipt = await database().leadershipObservationReceipt.create({
      data: {
        targetId: publication.targetId,
        databasePublicationId: publication.id,
        snapshotId: parsed.data.snapshotId,
        snapshotHash: parsed.data.snapshotHash,
        observationKind: parsed.data.observationKind,
        cacheSource: parsed.data.cacheSource,
        healthResult: parsed.data.healthResult,
        applicationReleaseIdentity: parsed.data.applicationReleaseIdentity,
        routeProbeHash: parsed.data.routeProbeHash,
        attestationKeyId: parsed.data.attestationKeyId,
        receiptDigest: parsed.data.receiptDigest,
        observedAt,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced =
        await database().leadershipObservationReceipt.findUniqueOrThrow({
          where: { receiptDigest: parsed.data.receiptDigest },
        });
      return NextResponse.json({ receiptId: raced.id, reused: true });
    }
    throw error;
  }
  return NextResponse.json(
    { receiptId: receipt.id, reused: false },
    { status: 201 },
  );
}
