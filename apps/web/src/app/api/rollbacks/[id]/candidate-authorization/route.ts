import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { audit } from "@/server/audit";
import {
  CandidateUnavailableError,
  createCandidateAuthorization,
} from "@/server/publication/candidate-authorization";

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
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await params);
  if (!parsed.success)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  let issued;
  try {
    issued = await createCandidateAuthorization(database(), {
      requestId: parsed.data.id,
      requestKind: "rollback",
      reviewerId: auth.session.userId,
      audience: environment().LEADERSHIP_CANDIDATE_AUDIENCE,
    });
  } catch (error) {
    if (error instanceof CandidateUnavailableError)
      return NextResponse.json(
        { error: "candidate is unavailable" },
        { status: 409 },
      );
    throw error;
  }
  const { authorization, exchangeToken } = issued;
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "rollback.candidate_authorize",
    targetType: "candidate_authorization",
    targetId: authorization.id,
    targetVersion: authorization.snapshotHash,
    outcome: "SUCCEEDED",
    after: {
      rollbackRequestId: parsed.data.id,
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
