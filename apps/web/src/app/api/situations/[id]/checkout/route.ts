import { NextResponse } from "next/server";
import { requireMutationSession, hasRole } from "@/server/auth/request";
import {
  WorkflowError,
  checkoutSituation,
} from "@/server/workflows/situations";
import { database } from "@/server/database";

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
    await checkoutSituation({ situationId: id, actorId: auth.session.userId });
    const situation = await database().situation.findUniqueOrThrow({
      where: { id },
      select: { slug: true },
    });
    return NextResponse.json({ slug: situation.slug });
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    throw error;
  }
}
