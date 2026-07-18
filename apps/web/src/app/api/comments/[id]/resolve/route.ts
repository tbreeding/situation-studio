import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authenticateMutation } from "@/server/auth/request";
import { database } from "@/server/database";
import { audit } from "@/server/audit";

const schema = z.object({ resolution: z.string().trim().min(3).max(2000) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateMutation(request, "proposal.review");
  if (!auth.ok)
    return NextResponse.json({ error: "denied" }, { status: auth.status });
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json({ error: "resolution required" }, { status: 400 });
  const { id } = await params;
  const comment = await database().comment.findUnique({ where: { id } });
  if (!comment || comment.status !== "OPEN")
    return NextResponse.json({ error: "comment not open" }, { status: 409 });
  const now = new Date();
  await database().comment.update({
    where: { id },
    data: {
      status: "RESOLVED",
      resolvedById: auth.session.userId,
      resolution: parsed.data.resolution,
      resolvedAt: now,
    },
  });
  await audit({
    actorId: auth.session.userId,
    permissions: [...auth.session.permissions],
    action: "comment.resolve",
    targetType: "comment",
    targetId: id,
    outcome: "SUCCEEDED",
    after: { resolvedAt: now.toISOString() },
  });
  return NextResponse.json({ status: "RESOLVED" });
}
