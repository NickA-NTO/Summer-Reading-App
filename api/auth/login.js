// Kicks off the login OAuth flow. Two providers, selected by AUTH_PROVIDER:
//   • "timeback" — Sign in with TimeBack (Cognito), Authorization Code + PKCE,
//      no client secret. The id_token carries the student's `sourcedId`.
//   • "google"   — legacy Google OAuth (kept behind the flag for rollback).
// Sets a short-lived state cookie (CSRF) + (TimeBack only) a PKCE verifier
// cookie, then bounces to the IdP.

import { serializeCookie, safeNextPath } from "../../lib/session.js";
import { TIMEBACK_SSO, authProvider, makeCodeVerifier, codeChallengeFor } from "../../lib/timeback-sso.js";

export default async function handler(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  // CSRF state token
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes, (b) => b.toString(16).padStart(2, "0")).join("");

  // Preserve a post-login "next" path through the OAuth dance via state.
  const url = new URL(req.url, `${proto}://${host}`);
  const next = safeNextPath(url.searchParams.get("next"));
  const stateValue = `${state}:${next}`;

  if (authProvider() === "timeback") {
    // ── Sign in with TimeBack (PKCE) ──────────────────────────────────────
    const verifier = makeCodeVerifier();
    const challenge = await codeChallengeFor(verifier);
    const params = new URLSearchParams({
      client_id: TIMEBACK_SSO.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: TIMEBACK_SSO.scopes,
      state: stateValue,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    res.setHeader("Set-Cookie", [
      serializeCookie("rs_oauth_state", stateValue, { maxAge: 600 }),
      // PKCE verifier — httpOnly, SameSite=Lax so it survives the IdP redirect
      // back. Consumed + cleared in the callback.
      serializeCookie("rs_pkce_verifier", verifier, { maxAge: 600, sameSite: "Lax" }),
    ]);
    res.statusCode = 302;
    res.setHeader("Location", `${TIMEBACK_SSO.authorizeEndpoint}?${params.toString()}`);
    return res.end();
  }

  // ── Legacy Google OAuth ─────────────────────────────────────────────────
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    return res.end("Auth not configured: GOOGLE_CLIENT_ID is missing in this environment.");
  }
  const allowedDomains = (process.env.ALLOWED_DOMAIN || "alpha.school")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const hdParam = allowedDomains.length === 1 ? allowedDomains[0] : "*";
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: stateValue,
    prompt: "select_account",
    hd: hdParam,
    access_type: "online",
    include_granted_scopes: "true",
  });
  res.setHeader("Set-Cookie", serializeCookie("rs_oauth_state", stateValue, { maxAge: 600 }));
  res.statusCode = 302;
  res.setHeader("Location", `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  res.end();
}
