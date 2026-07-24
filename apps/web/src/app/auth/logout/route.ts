import { NextResponse } from "next/server";
import { safeEqual, sha256 } from "@/server/auth/crypto";
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
  return NextResponse.redirect(new URL("/login", request.url), 303);
}
