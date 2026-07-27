import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import {
  WorkflowError,
  decideProposalChange,
  editProposalChange,
} from "@/server/workflows/situations";

const inputSchema = z.object({
  checkoutId: z.uuid(),
  fence: z.string().regex(/^\d+$/u),
  decision: z.enum(["ACCEPT", "REJECT"]),
});

const editInputSchema = z.object({
  checkoutId: z.uuid(),
  fence: z.string().regex(/^\d+$/u),
  editedBody: z.string().min(1).max(512_000),
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
    const result = await decideProposalChange({
      actorId: auth.session.userId,
      checkoutId: input.checkoutId,
      fence: BigInt(input.fence),
      changeId: id,
      decision: input.decision,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Invalid proposal decision." },
        { status: 422 },
      );
    throw error;
  }
}

export async function PATCH(
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
    const input = editInputSchema.parse(await request.json());
    const result = await editProposalChange({
      actorId: auth.session.userId,
      checkoutId: input.checkoutId,
      fence: BigInt(input.fence),
      changeId: id,
      editedBody: input.editedBody,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Invalid suggestion edit." },
        { status: 422 },
      );
    throw error;
  }
}
