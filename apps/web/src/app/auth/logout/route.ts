import { NextResponse, type NextRequest } from "next/server";
import { environment, isSecureOrigin } from "@/server/environment";
import { currentSession, SESSION_COOKIE } from "@/server/auth/sessions";
import { equalText } from "@/server/auth/crypto";
import { database } from "@/server/database";

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const session = await currentSession();
  if (
    session &&
    request.headers.get("origin") === environment().SITUATION_STUDIO_ORIGIN &&
    equalText(String(form.get("csrfToken") ?? ""), session.csrfToken)
  )
    await database().session.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), revokedReason: "LOGOUT" },
    });
  const response = NextResponse.redirect(
    new URL("/login", environment().SITUATION_STUDIO_ORIGIN),
    303,
  );
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
