import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { audit } from "@/server/audit";
import { currentSession } from "@/server/auth/sessions";
import { database } from "@/server/database";
import { environment, isSecureOrigin } from "@/server/environment";
import {
  CandidateUnavailableError,
  createCandidateAuthorization,
} from "@/server/publication/candidate-authorization";
import {
  CANDIDATE_HANDOFF_STATE_COOKIE,
  candidateHandoffSignatureMatches,
  type CandidateHandoffProof,
} from "@/server/publication/candidate-handoff";

const querySchema = z.object({
  expiresAt: z.string().datetime(),
  handoffId: z.string().uuid(),
  requestId: z.string().uuid(),
  requestKind: z.enum(["publication", "rollback"]),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
  situationSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  state: z.string().regex(/^[a-f0-9]{64}$/u),
  verifierHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

function clearState(response: NextResponse) {
  response.cookies.set(CANDIDATE_HANDOFF_STATE_COOKIE, "", {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}

export async function GET(request: NextRequest) {
  const expected = environment();
  if (request.headers.get("host") !== expected.SITUATION_STUDIO_HOST)
    return NextResponse.json({ error: "denied" }, { status: 403 });
  const session = await currentSession();
  if (!session) return NextResponse.redirect(new URL("/login", request.url));
  if (!session.permissions.has("publication.publish"))
    return NextResponse.json({ error: "denied" }, { status: 403 });
  if (
    !session.reauthenticatedAt ||
    session.reauthenticatedAt.getTime() < Date.now() - 15 * 60 * 1000
  )
    return NextResponse.json(
      { error: "recent reauthentication required" },
      { status: 403 },
    );
  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success)
    return NextResponse.json({ error: "invalid handoff" }, { status: 400 });
  const stateCookie = (await cookies()).get(
    CANDIDATE_HANDOFF_STATE_COOKIE,
  )?.value;
  if (stateCookie !== parsed.data.state)
    return NextResponse.json(
      { error: "invalid handoff state" },
      { status: 403 },
    );
  const proof: CandidateHandoffProof = {
    expiresAt: parsed.data.expiresAt,
    handoffId: parsed.data.handoffId,
    requestId: parsed.data.requestId,
    requestKind: parsed.data.requestKind,
    situationSlug: parsed.data.situationSlug,
    state: parsed.data.state,
    verifierHash: parsed.data.verifierHash,
  };
  const exchangeSecret = expected.LEADERSHIP_CANDIDATE_EXCHANGE_SECRET;
  const expiresAt = new Date(parsed.data.expiresAt);
  if (
    !exchangeSecret ||
    expiresAt <= new Date() ||
    expiresAt.getTime() > Date.now() + 5 * 60 * 1000 ||
    !candidateHandoffSignatureMatches(
      exchangeSecret,
      proof,
      parsed.data.signature,
    )
  )
    return NextResponse.json(
      { error: "invalid handoff proof" },
      { status: 403 },
    );

  let issued;
  try {
    issued = await createCandidateAuthorization(database(), {
      requestId: parsed.data.requestId,
      requestKind: parsed.data.requestKind,
      reviewerId: session.userId,
      audience: expected.LEADERSHIP_CANDIDATE_AUDIENCE,
      handoffId: parsed.data.handoffId,
      handoffVerifierHash: parsed.data.verifierHash,
    });
  } catch (error) {
    if (error instanceof CandidateUnavailableError)
      return NextResponse.json(
        { error: "candidate is unavailable" },
        { status: 409 },
      );
    throw error;
  }
  await audit({
    actorId: session.userId,
    permissions: [...session.permissions],
    action: `${parsed.data.requestKind}.candidate_authorize`,
    targetType: "candidate_authorization",
    targetId: issued.authorization.id,
    targetVersion: issued.authorization.snapshotHash,
    outcome: "SUCCEEDED",
    after: {
      requestId: parsed.data.requestId,
      handoffId: parsed.data.handoffId,
      expiresAt: issued.authorization.expiresAt,
    },
  });
  const completion = new URL(
    "/candidate/complete",
    expected.LEADERSHIP_CANDIDATE_ORIGIN,
  );
  completion.searchParams.set("handoffId", parsed.data.handoffId);
  completion.searchParams.set(
    "returnTo",
    `/situations/${parsed.data.situationSlug}`,
  );
  return clearState(NextResponse.redirect(completion, 303));
}
