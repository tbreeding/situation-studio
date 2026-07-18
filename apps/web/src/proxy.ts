import { NextResponse, type NextRequest } from "next/server";
import { opaqueToken } from "@/server/auth/crypto";
import { LOGIN_CSRF_COOKIE } from "@/server/auth/sessions";

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const contentSecurityPolicy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", contentSecurityPolicy);
  const configuredOrigin = process.env.SITUATION_STUDIO_ORIGIN;
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
