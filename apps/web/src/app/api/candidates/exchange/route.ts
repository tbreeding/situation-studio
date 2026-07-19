import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sha256 } from "@situation-studio/domain";
import { database } from "@/server/database";
import { environment } from "@/server/environment";
import { trustedBearerMatches } from "@/lib/service-auth";

const schema = z.object({
  exchangeToken: z
    .string()
    .length(64)
    .regex(/^[a-f0-9]+$/u),
});

export async function POST(request: Request) {
  const authorizationHeader = request.headers.get("authorization") ?? "";
  const exchangeSecret = environment().LEADERSHIP_CANDIDATE_EXCHANGE_SECRET;
  if (!exchangeSecret)
    return NextResponse.json({ error: "exchange disabled" }, { status: 503 });
  if (!trustedBearerMatches(exchangeSecret, authorizationHeader))
    return NextResponse.json({ error: "invalid exchange" }, { status: 403 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "invalid exchange" }, { status: 400 });
  const exchangeHash = sha256(parsed.data.exchangeToken);
  const cookieToken = randomBytes(32).toString("hex");
  const authorization = await database().$transaction(
    async (transaction) => {
      const row = await transaction.candidateAuthorization.findUnique({
        where: { exchangeTokenHash: exchangeHash },
      });
      if (
        !row ||
        row.cookieTokenHash ||
        row.exchangedAt ||
        row.revokedAt ||
        row.expiresAt <= new Date()
      )
        return null;
      const updated = await transaction.candidateAuthorization.updateMany({
        where: {
          id: row.id,
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
