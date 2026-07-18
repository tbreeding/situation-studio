import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { saveDraft } from "@/server/workflows/checkouts";
import { audit } from "@/server/audit";

const schema = z.object({
  checkoutId: z.string().uuid(),
  fencingToken: z.string().regex(/^\d+$/u),
  clientMutationId: z.string().uuid(),
  artifactId: z.string().uuid(),
  body: z.string().min(1).max(1_000_000),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "draft.update");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const { id } = await params;
  const match = request.headers
    .get("if-match")
    ?.match(new RegExp(`^"draft-${id}-(\\d+)"$`, "u"));
  if (!match?.[1])
    return NextResponse.json(
      { error: "precondition required" },
      { status: 428 },
    );
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  try {
    const result = await saveDraft(database(), {
      draftId: id,
      userId: auth.session.userId,
      expectedRevision: Number(match[1]),
      checkoutId: parsed.data.checkoutId,
      fencingToken: BigInt(parsed.data.fencingToken),
      clientMutationId: parsed.data.clientMutationId,
      artifactId: parsed.data.artifactId,
      body: parsed.data.body,
    });
    if (!result.ok)
      return NextResponse.json(
        {
          error: result.status === 423 ? "locked" : "stale",
          revision: "revision" in result ? result.revision : undefined,
        },
        { status: result.status },
      );
    await audit({
      actorId: auth.session.userId,
      permissions: [...auth.session.permissions],
      action: "draft.revision.create",
      targetType: "draft",
      targetId: id,
      targetVersion: String(result.revision),
      outcome: "SUCCEEDED",
      after: {
        artifactId: parsed.data.artifactId,
        contentHash: result.contentHash,
      },
    });
    return NextResponse.json(result, { headers: { ETag: result.etag } });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message === "STALE_DRAFT"
            ? "stale"
            : "save failed",
      },
      {
        status:
          error instanceof Error && error.message === "STALE_DRAFT" ? 409 : 500,
      },
    );
  }
}
