import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import {
  preflightPublication,
  WorkflowError,
} from "@/server/workflows/situations";

const inputSchema = z.object({
  fence: z.string().regex(/^\d+$/u),
  revisionId: z.uuid(),
  bundleHash: z.string().regex(/^[a-f0-9]{64}$/u),
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
    const receipt = await preflightPublication({
      actorId: auth.session.userId,
      checkoutId: id,
      fence: BigInt(input.fence),
      revisionId: input.revisionId,
      bundleHash: input.bundleHash,
    });
    return NextResponse.json({
      receiptId: receipt.id,
      revisionId: receipt.revisionId,
      bundleHash: receipt.revisionBundleHash,
      candidateHash: receipt.candidateHash,
      manifestHash: receipt.manifestHash,
      situationArtifactHash: receipt.situationArtifactHash,
      baseReleaseId: receipt.baseReleaseId,
      baseManifestHash: receipt.baseManifestHash,
      expectedPointerGeneration: receipt.expectedPointerGeneration.toString(),
      contractDigest: receipt.contractDigest,
      validationResult: receipt.validationResult,
      affectedRoutes: receipt.affectedRoutes,
      candidatePreview: receipt.candidatePreview,
      validatedAt: receipt.createdAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message, code: error.code, details: error.details },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Invalid publication preflight request." },
        { status: 422 },
      );
    throw error;
  }
}
