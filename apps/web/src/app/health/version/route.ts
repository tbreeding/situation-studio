import { NextResponse } from "next/server";
import { currentSession } from "@/server/auth/sessions";
import { MODEL_POLICY } from "@situation-studio/domain";
export async function GET() {
  const session = await currentSession();
  if (!session?.permissions.has("system.admin"))
    return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({
    release: process.env.STUDIO_RELEASE_ID ?? "development",
    schema: "1",
    modelPolicy: MODEL_POLICY.version,
  });
}
