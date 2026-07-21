import { NextResponse, type NextRequest } from "next/server";
import { opaqueToken } from "@/server/auth/crypto";
import { LOGIN_CSRF_COOKIE } from "@/server/auth/sessions";
import { studioContentSecurityPolicy } from "@/lib/content-security-policy";

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const contentSecurityPolicy = studioContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const configuredOrigin = process.env.SITUATION_STUDIO_ORIGIN;
  const configuredHost = process.env.SITUATION_STUDIO_HOST;
  if (
    request.nextUrl.pathname === "/" &&
    configuredHost &&
    request.headers.get("host") !== configuredHost
  ) {
    const response = NextResponse.json({ status: "origin-ready" });
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
  }
  const isAuthenticationPage =
    request.nextUrl.pathname === "/login" ||
    request.nextUrl.pathname.startsWith("/activate/");

  if (isAuthenticationPage && !request.cookies.get(LOGIN_CSRF_COOKIE)?.value) {
    const destination = configuredOrigin
      ? new URL(
          `${request.nextUrl.pathname}${request.nextUrl.search}`,
          configuredOrigin,
        )
      : request.nextUrl;
    const response = NextResponse.redirect(destination);
    response.cookies.set(LOGIN_CSRF_COOKIE, opaqueToken(), {
      httpOnly: true,
      secure: configuredOrigin?.startsWith("https://") ?? true,
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60,
    });
    response.headers.set("Content-Security-Policy", contentSecurityPolicy);
    return response;
  }
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
