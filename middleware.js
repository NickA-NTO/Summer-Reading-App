// Page-request gate. Used to redirect EVERY unauthenticated request
// straight to /api/auth/login, which prevented the welcome screen (#26)
// from ever rendering — a K student would land on Google's account
// picker without any kid-friendly read-aloud preamble. Now the root
// path (`/`) is allowed through unauthenticated so the SPA can render
// the welcome screen itself (it calls /api/auth/me and falls into
// renderWelcomeScreen() when it sees 401). Any other path still
// redirects, preserving deep-link auth behavior for future routes.

import { verifySession, parseCookies } from "./lib/session.js";

export const config = {
  // Run on every path EXCEPT /api/* (each endpoint does its own auth check
  // and returns 401 JSON rather than redirecting), Vercel internals, and
  // favicon.
  matcher: "/((?!api/|_vercel|favicon\\.ico).*)",
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

  // Unauthenticated. Root path → let the SPA serve the welcome screen
  // (it'll detect the missing session via /api/auth/me and render
  // renderWelcomeScreen). Any other path still redirects to login so
  // a deep link from an email or share doesn't accidentally render
  // the SPA shell without auth.
  const reqUrl = new URL(request.url);
  if (reqUrl.pathname === "/" || reqUrl.pathname === "") return;

  const login = new URL("/api/auth/login", request.url);
  login.searchParams.set("next", reqUrl.pathname + reqUrl.search);
  return Response.redirect(login, 302);
}
