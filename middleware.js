// Gates every page request. If the visitor isn't authenticated, redirects to
// /api/auth/login. Lets /api/auth/* through untouched so the OAuth flow can run.

import { verifySession, parseCookies } from "./lib/session.js";

export const config = {
  // Run on every path EXCEPT /api/auth/*, Vercel internals, and favicon.
  matcher: "/((?!api/auth|_vercel|favicon\\.ico).*)",
};

export default async function middleware(request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return new Response("Auth not configured: AUTH_SECRET missing.", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const cookies = parseCookies(request.headers.get("cookie"));
  const session = await verifySession(cookies.rs_session, secret);
  if (session) return; // authenticated — let it through

  // Unauthenticated — redirect to the login starter, preserving the requested path
  const reqUrl = new URL(request.url);
  const login = new URL("/api/auth/login", request.url);
  if (reqUrl.pathname && reqUrl.pathname !== "/") {
    login.searchParams.set("next", reqUrl.pathname + reqUrl.search);
  }
  return Response.redirect(login, 302);
}
