// Google redirects here with a `code`. We:
//   1. Verify the state cookie (CSRF defense)
//   2. Exchange the code for tokens at Google's token endpoint
//   3. Decode the id_token and enforce hd === alpha.school
//   4. Sign a session cookie and redirect home

import {
  signSession,
  parseCookies,
  serializeCookie,
  decodeIdToken,
} from "../../lib/session.js";

const SESSION_DAYS = 7;

export default async function handler(req, res) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const url = new URL(req.url, `${proto}://${host}`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) return redirect(res, `/?auth_error=${encodeURIComponent(oauthError)}`);
  if (!code || !state) return redirect(res, "/?auth_error=missing_code");

  // CSRF check
  const cookies = parseCookies(req.headers.cookie);
  if (!cookies.rs_oauth_state || cookies.rs_oauth_state !== state) {
    return redirect(res, "/?auth_error=state_mismatch");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const allowedDomain = process.env.ALLOWED_DOMAIN || "alpha.school";
  const secret = process.env.AUTH_SECRET;
  if (!clientId || !clientSecret || !secret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    return res.end(
      "Auth not configured: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / AUTH_SECRET missing."
    );
  }

  const redirectUri = `${proto}://${host}/api/auth/callback`;

  let tokens;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) {
      return redirect(res, "/?auth_error=token_exchange_failed");
    }
    tokens = await tokenRes.json();
  } catch {
    return redirect(res, "/?auth_error=token_exchange_network");
  }

  if (!tokens.id_token) return redirect(res, "/?auth_error=no_id_token");

  let payload;
  try {
    payload = decodeIdToken(tokens.id_token);
  } catch {
    return redirect(res, "/?auth_error=invalid_id_token");
  }

  // Hard domain enforcement — `hd` is set by Google for Workspace accounts.
  if (payload.hd !== allowedDomain) {
    res.setHeader(
      "Set-Cookie",
      serializeCookie("rs_oauth_state", "", { maxAge: 0 })
    );
    return redirect(
      res,
      `/?auth_error=domain&got=${encodeURIComponent(payload.email || payload.hd || "")}`
    );
  }
  if (!payload.email_verified) {
    return redirect(res, "/?auth_error=email_unverified");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const session = {
    email: payload.email,
    name:
      payload.name ||
      payload.given_name ||
      String(payload.email).split("@")[0],
    picture: payload.picture || null,
    hd: payload.hd,
    iat: nowSec,
    exp: nowSec + SESSION_DAYS * 24 * 60 * 60,
  };
  const token = await signSession(session, secret);

  // Recover the post-login "next" path encoded into state
  const next = (state.split(":").slice(1).join(":") || "/").startsWith("/")
    ? state.split(":").slice(1).join(":") || "/"
    : "/";

  res.setHeader("Set-Cookie", [
    serializeCookie("rs_session", token, {
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    }),
    serializeCookie("rs_oauth_state", "", { maxAge: 0 }),
  ]);
  redirect(res, next);
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}
