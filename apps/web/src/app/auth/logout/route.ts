import { NextResponse } from "next/server";
import { safeEqual, sha256 } from "@/server/auth/crypto";
import { publicUrl } from "@/server/auth/public-url";
import {
  clearSessionCookie,
  currentSession,
  revokeSession,
} from "@/server/auth/sessions";

export async function POST(request: Request) {
  const session = await currentSession();
  if (session) {
    const form = await request.formData();
    const csrf = String(form.get("csrf") ?? "");
    if (!safeEqual(sha256(csrf), session.csrfHash))
      return NextResponse.json(
        { error: "Request verification failed." },
        { status: 403 },
      );
    await revokeSession(session.id, "LOGOUT");
  }
  await clearSessionCookie();
  return NextResponse.redirect(publicUrl("/login"), 303);
}
