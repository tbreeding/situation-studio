import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sha256 } from "@situation-studio/domain";
import { trustedBearerMatches } from "@/lib/service-auth";
import { database } from "@/server/database";
import { environment } from "@/server/environment";

const schema = z.object({
  handoffId: z.string().uuid(),
  verifier: z.string().regex(/^[a-f0-9]{64}$/u),
});

export async function POST(request: Request) {
  const exchangeSecret = environment().LEADERSHIP_CANDIDATE_EXCHANGE_SECRET;
  if (!exchangeSecret)
    return NextResponse.json({ error: "exchange disabled" }, { status: 503 });
  if (
    !trustedBearerMatches(exchangeSecret, request.headers.get("authorization"))
  )
    return NextResponse.json({ error: "invalid exchange" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "invalid exchange" }, { status: 400 });
  const verifierHash = sha256(parsed.data.verifier);
  const cookieToken = randomBytes(32).toString("hex");
  const authorization = await database().$transaction(
    async (transaction) => {
      const row = await transaction.candidateAuthorization.findUnique({
        where: { handoffId: parsed.data.handoffId },
      });
      if (
        !row ||
        row.handoffVerifierHash !== verifierHash ||
        row.cookieTokenHash ||
        row.exchangedAt ||
        row.revokedAt ||
        row.expiresAt <= new Date()
      )
        return null;
      const updated = await transaction.candidateAuthorization.updateMany({
        where: {
          id: row.id,
          handoffVerifierHash: verifierHash,
          cookieTokenHash: null,
          exchangedAt: null,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { cookieTokenHash: sha256(cookieToken), exchangedAt: new Date() },
      });
      return updated.count === 1 ? row : null;
    },
    { isolationLevel: "Serializable" },
  );
  if (!authorization)
    return NextResponse.json({ error: "invalid exchange" }, { status: 404 });
  return NextResponse.json({
    cookieToken,
    reviewerId: authorization.reviewerId,
    audience: authorization.audience,
    publicationRequestId:
      authorization.publicationRequestId ?? authorization.rollbackRequestId,
    expiresAt: authorization.expiresAt,
  });
}
