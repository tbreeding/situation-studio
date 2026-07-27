import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import {
  acceptAllProposalChanges,
  WorkflowError,
} from "@/server/workflows/situations";

const inputSchema = z.object({
  checkoutId: z.uuid(),
  fence: z.string().regex(/^\d+$/u),
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
    return NextResponse.json(
      await acceptAllProposalChanges({
        actorId: auth.session.userId,
        checkoutId: input.checkoutId,
        fence: BigInt(input.fence),
        proposalId: id,
      }),
    );
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Invalid bulk suggestion decision." },
        { status: 422 },
      );
    throw error;
  }
}
