import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import { WorkflowError, saveDraft } from "@/server/workflows/situations";

const bodySchema = z.object({
  fence: z.string().regex(/^\d+$/u),
  bundle: z.unknown(),
  body: z.string().max(2 * 1024 * 1024),
  expectedParentRevisionId: z.uuid(),
  expectedParentBundleHash: z.string().regex(/^[a-f0-9]{64}$/u),
  namedCheckpoint: z.string().min(1).max(160).optional(),
});

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireMutationSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!hasRole(auth.session, "EDITOR"))
    return NextResponse.json(
      { error: "Editor access required." },
      { status: 403 },
    );
  try {
    const { id } = await params;
    const input = bodySchema.parse(await request.json());
    const revision = await saveDraft({
      actorId: auth.session.userId,
      checkoutId: id,
      fence: BigInt(input.fence),
      bundle: input.bundle,
      body: input.body,
      expectedParentRevisionId: input.expectedParentRevisionId,
      expectedParentBundleHash: input.expectedParentBundleHash,
      ...(input.namedCheckpoint
        ? { namedCheckpoint: input.namedCheckpoint }
        : {}),
    });
    return NextResponse.json({
      revisionId: revision.id,
      revision: revision.revision,
      bundleHash: revision.bundleHash,
      savedAt: revision.createdAt.toISOString(),
      bundle: revision.bundleManifest,
      body:
        revision.artifacts.find((artifact) => artifact.kind === "SITUATION")
          ?.content.textBody ?? input.body,
    });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "The draft payload is not valid." },
        { status: 422 },
      );
    throw error;
  }
}
