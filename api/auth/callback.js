// Google redirects here with a `code`. We:
//   1. Verify the state cookie (CSRF defense)
//   2. Exchange the code for tokens at Google's token endpoint
//   3. Decode the id_token and enforce hd === alpha.school
//   4. Sign a session cookie and redirect home

import {
  signSession,
  parseCookies,
  serializeCookie,
  verifyGoogleIdToken,
  isTombstoned,
  safeNextPath,
} from "../../lib/session.js";
import { recordLogin } from "../../lib/store.js";

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
  // Comma-separated list of acceptable domains (e.g. "alpha.school,trilogy.com").
  const allowedDomains = (process.env.ALLOWED_DOMAIN || "alpha.school")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
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

  // #58 — verify the Google id_token's signature against Google's JWKS
  // and validate iss/aud/exp/iat. Previously we decoded the payload
  // unchecked on the assumption that the channel was authenticated by
  // our client_secret-protected token exchange — which is mostly true
  // but doesn't defend against bugs that ever accept an id_token from
  // an untrusted source (e.g., a future client-side path). Defense in
  // depth: verify every time.
  let payload;
  try {
    payload = await verifyGoogleIdToken(tokens.id_token, clientId);
  } catch (err) {
    const code = String(err?.message || "invalid_id_token");
    return redirect(res, `/?auth_error=${encodeURIComponent(code)}`);
  }

  // Hard domain enforcement — accept the user if EITHER the `hd` claim
  // (Workspace orgs) OR the verified email address is on our allow list.
  // Email is set + verified by Google for every account, so this works for
  // both Workspace and any non-Workspace orgs we ever add.
  if (!payload.email_verified) {
    return redirect(res, "/?auth_error=email_unverified");
  }
  const emailDomain = String(payload.email || "")
    .toLowerCase()
    .split("@")[1] || "";
  const hdDomain = String(payload.hd || "").toLowerCase();
  const domainAllowed =
    (hdDomain && allowedDomains.includes(hdDomain)) ||
    (emailDomain && allowedDomains.includes(emailDomain));
  if (!domainAllowed) {
    res.setHeader(
      "Set-Cookie",
      serializeCookie("rs_oauth_state", "", { maxAge: 0 })
    );
    return redirect(
      res,
      `/?auth_error=domain&got=${encodeURIComponent(payload.email || hdDomain || "")}`
    );
  }

  // #13 — don't resurrect an admin-deleted account. If the email is
  // tombstoned (deleted within the ~30-day window), refuse a new session
  // rather than silently re-creating the profile via recordLogin below.
  if (await isTombstoned(payload.email)) {
    res.setHeader("Set-Cookie", serializeCookie("rs_oauth_state", "", { maxAge: 0 }));
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.end(
      "<!doctype html><html><head><meta charset=\"utf-8\"><title>Account removed</title></head>" +
      "<body style=\"font-family:system-ui,sans-serif;max-width:30rem;margin:15vh auto;text-align:center;padding:0 1rem\">" +
      "<h1 style=\"font-size:1.35rem\">Account removed</h1>" +
      "<p style=\"color:#555\">This account has been removed. Please contact your teacher or administrator if you think this is a mistake.</p>" +
      "</body></html>"
    );
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

  // Fire-and-forget login tracking for the admin user list. No-op if Redis
  // isn't configured yet.
  recordLogin({
    email: payload.email,
    name: session.name,
    picture: payload.picture,
    hd: payload.hd,
  }).catch(() => {});

  // Recover the post-login "next" path encoded into state. safeNextPath
  // rejects protocol-relative / backslash values (open-redirect fix, #12).
  const next = safeNextPath(state.split(":").slice(1).join(":") || "/");

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
