import { NextResponse } from "next/server";
import { z } from "zod";
import { hasRole, requireMutationSession } from "@/server/auth/request";
import { WorkflowError, createSituation } from "@/server/workflows/situations";

const createSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
    .max(160),
  title: z.string().min(20).max(300),
});

export async function POST(request: Request) {
  const auth = await requireMutationSession(request);
  if ("error" in auth)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!hasRole(auth.session, "EDITOR"))
    return NextResponse.json(
      { error: "Editor access required." },
      { status: 403 },
    );
  try {
    const input = createSchema.parse(await request.json());
    const created = await createSituation({
      actorId: auth.session.userId,
      slug: input.slug,
      title: input.title,
    });
    return NextResponse.json(
      { id: created.situation.id, slug: created.situation.slug },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof WorkflowError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    if (error instanceof z.ZodError)
      return NextResponse.json(
        { error: "Enter a descriptive title and a valid stable slug." },
        { status: 422 },
      );
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "P2002"
    )
      return NextResponse.json(
        { error: "That slug already belongs to another situation." },
        { status: 409 },
      );
    throw error;
  }
}
