import { NextResponse } from "next/server";
import { opaqueToken } from "@/server/auth/crypto";
import { safeReturnTo } from "@/server/auth/return-to";
import { LOGIN_CSRF_COOKIE, currentSession } from "@/server/auth/sessions";
import { isSecureOrigin } from "@/server/environment";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  if (await currentSession())
    return NextResponse.redirect(new URL(returnTo, url));
  const destination = new URL("/login", url);
  if (returnTo !== "/") destination.searchParams.set("returnTo", returnTo);
  const response = NextResponse.redirect(destination);
  response.cookies.set(LOGIN_CSRF_COOKIE, opaqueToken(), {
    httpOnly: true,
    secure: isSecureOrigin(),
    sameSite: "strict",
    path: "/",
    maxAge: 30 * 60,
  });
  return response;
}
