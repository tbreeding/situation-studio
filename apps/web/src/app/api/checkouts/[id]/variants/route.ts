import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import {
  WorkflowError,
  createScopedArtifactEdit,
} from "@/server/workflows/situations";

const inputSchema = z.object({
  fence: z.string().regex(/^\d+$/u),
  originalLogicalId: z.string().min(1).max(240),
  originalContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.enum([
    "GUIDE",
    "PRACTICE",
    "SOURCE",
    "LESSON_PLAN",
    "PREPARATION_PROMPT",
  ]),
  changedBody: z
    .string()
    .min(1)
    .max(2 * 1024 * 1024),
});

export async function POST(
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
    const input = inputSchema.parse(await request.json());
    const result = await createScopedArtifactEdit({
      actorId: auth.session.userId,
      checkoutId: id,
      fence: BigInt(input.fence),
      originalLogicalId: input.originalLogicalId,
      originalContentHash: input.originalContentHash,
      kind: input.kind,
      changedBody: input.changedBody,
    });
    return NextResponse.json({
      revisionId: result.revision.id,
      variantLogicalId: result.variant.logicalId,
    });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Enter valid scoped content for this artifact." },
        { status: 422 },
      );
    throw error;
  }
}
