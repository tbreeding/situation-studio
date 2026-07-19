import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@situation-studio/db";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { attestationKeyMatches } from "@/lib/service-auth";

const schema = z.object({
  snapshotId: z.string().uuid(),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/u),
  observationKind: z.enum(["CANDIDATE", "OFFICIAL", "RESTORATION"]),
  cacheSource: z.enum(["DATABASE", "LAST_KNOWN_GOOD"]),
  healthResult: z.enum(["HEALTHY", "DEGRADED", "UNHEALTHY"]),
  applicationReleaseIdentity: z.string().min(1).max(200),
  routeProbeHash: z.string().regex(/^[a-f0-9]{64}$/u),
  attestationKeyId: z.string().min(1).max(100),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  observedAt: z.string().datetime(),
});

function signedBody(publicationId: string, value: z.infer<typeof schema>) {
  return JSON.stringify({
    publicationId,
    snapshotId: value.snapshotId,
    snapshotHash: value.snapshotHash,
    observationKind: value.observationKind,
    cacheSource: value.cacheSource,
    healthResult: value.healthResult,
    applicationReleaseIdentity: value.applicationReleaseIdentity,
    routeProbeHash: value.routeProbeHash,
    attestationKeyId: value.attestationKeyId,
    observedAt: value.observedAt,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
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
    .update(signedBody(id, parsed.data))
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
  });
  if (!publication)
    return NextResponse.json({ error: "not found" }, { status: 404 });
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
