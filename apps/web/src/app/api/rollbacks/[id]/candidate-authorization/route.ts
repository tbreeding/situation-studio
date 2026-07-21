import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { environment, isSecureOrigin } from "@/server/environment";
import { CANDIDATE_HANDOFF_STATE_COOKIE } from "@/server/publication/candidate-handoff";

const bodySchema = z.object({
  situationSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "publication.publish");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  if (
    !auth.session.reauthenticatedAt ||
    auth.session.reauthenticatedAt.getTime() < Date.now() - 15 * 60 * 1000
  )
    return NextResponse.json(
      { error: "recent reauthentication required" },
      { status: 403 },
    );
  const parsed = z.object({ id: z.string().uuid() }).safeParse(await params);
  if (!parsed.success)
    return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return NextResponse.json({ error: "invalid handoff" }, { status: 400 });
  const state = randomBytes(32).toString("hex");
  const callback = new URL(
    "/api/candidates/handoff",
    environment().SITUATION_STUDIO_ORIGIN,
  );
  callback.searchParams.set("requestId", parsed.data.id);
  callback.searchParams.set("requestKind", "rollback");
  callback.searchParams.set("situationSlug", body.data.situationSlug);
  callback.searchParams.set("state", state);
  const bootstrap = new URL(
    "/candidate/bootstrap",
    environment().LEADERSHIP_CANDIDATE_ORIGIN,
  );
  bootstrap.searchParams.set("callback", callback.toString());
  bootstrap.searchParams.set("state", state);
  const response = NextResponse.json({
    bootstrapUrl: bootstrap.toString(),
  });
  response.cookies.set(CANDIDATE_HANDOFF_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: 5 * 60,
  });
  return response;
}
