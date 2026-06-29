// IdP redirects here with a `code`. We:
//   1. Verify the state cookie (CSRF defense)
//   2. Exchange the code for tokens (TimeBack: PKCE no-secret / Google: secret)
//   3. Verify the id_token signature + claims; enforce the email domain
//   4. Sign a session cookie (incl. sourcedId for TimeBack) and redirect home

import {
  signSession,
  parseCookies,
  serializeCookie,
  verifyGoogleIdToken,
  verifyOidcIdToken,
  isTombstoned,
  safeNextPath,
} from "../../lib/session.js";
import { recordLogin, setOnerosterId } from "../../lib/store.js";
import { TIMEBACK_SSO, authProvider } from "../../lib/timeback-sso.js";

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

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    return res.end("Auth not configured: AUTH_SECRET missing.");
  }
  const allowedDomains = (process.env.ALLOWED_DOMAIN || "alpha.school")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const redirectUri = `${proto}://${host}/api/auth/callback`;
  const provider = authProvider();

  // payload = verified id_token claims; sourcedId is the TimeBack OneRoster id
  // (TimeBack provider only). hdDomain is the Google Workspace hint.
  let payload, sourcedId = null, hdDomain = "";

  if (provider === "timeback") {
    // ── Sign in with TimeBack (PKCE token exchange, NO client secret) ──────
    const verifier = cookies.rs_pkce_verifier;
    if (!verifier) return redirect(res, "/?auth_error=missing_verifier");
    let tokens;
    try {
      const tokenRes = await fetch(TIMEBACK_SSO.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: TIMEBACK_SSO.clientId,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
        }),
      });
      if (!tokenRes.ok) return redirect(res, "/?auth_error=token_exchange_failed");
      tokens = await tokenRes.json();
    } catch {
      return redirect(res, "/?auth_error=token_exchange_network");
    }
    if (!tokens.id_token) return redirect(res, "/?auth_error=no_id_token");
    try {
      payload = await verifyOidcIdToken(tokens.id_token, {
        jwksUrl: TIMEBACK_SSO.jwksUrl,
        issuers: [TIMEBACK_SSO.issuer],
        audience: TIMEBACK_SSO.clientId,
      });
    } catch (err) {
      return redirect(res, `/?auth_error=${encodeURIComponent(String(err?.message || "invalid_id_token"))}`);
    }
    // The bundle: the id_token's `sourcedId` claim IS the student's OneRoster
    // id. Cognito may namespace it (custom:sourcedId) or carry it as `sub`.
    // Check the documented names, then a broad scan for any *sourced*/*oneroster*
    // claim so an unexpected name doesn't silently break attribution.
    sourcedId =
      payload.sourcedId ||
      payload["custom:sourcedId"] ||
      payload["custom:sourcedId".toLowerCase()] ||
      null;
    if (!sourcedId) {
      for (const [k, v] of Object.entries(payload)) {
        if (/sourced|oneroster/i.test(k) && v) { sourcedId = String(v); break; }
      }
    }
    // Diagnostic (keys only, no values) — so we can see in logs exactly which
    // claims TimeBack returns and whether sourcedId resolved. Remove once the
    // claim name is confirmed stable.
    try {
      console.log("[sso_idtoken] claims=", Object.keys(payload).join(","),
        "| sourcedIdResolved=", !!sourcedId, "| sub=", payload.sub ? "present" : "absent");
    } catch {}
  } else {
    // ── Legacy Google OAuth (client-secret exchange) ──────────────────────
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain");
      return res.end("Auth not configured: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing.");
    }
    let tokens;
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: clientId, client_secret: clientSecret,
          redirect_uri: redirectUri, grant_type: "authorization_code",
        }),
      });
      if (!tokenRes.ok) return redirect(res, "/?auth_error=token_exchange_failed");
      tokens = await tokenRes.json();
    } catch {
      return redirect(res, "/?auth_error=token_exchange_network");
    }
    if (!tokens.id_token) return redirect(res, "/?auth_error=no_id_token");
    try {
      payload = await verifyGoogleIdToken(tokens.id_token, clientId);
    } catch (err) {
      return redirect(res, `/?auth_error=${encodeURIComponent(String(err?.message || "invalid_id_token"))}`);
    }
    if (!payload.email_verified) {
      return redirect(res, "/?auth_error=email_unverified");
    }
    hdDomain = String(payload.hd || "").toLowerCase();
  }

  // Hard domain enforcement — accept if the verified email is on the allow
  // list (works for both providers), OR (Google) the `hd` workspace claim is.
  const emailDomain = String(payload.email || "").toLowerCase().split("@")[1] || "";
  const domainAllowed =
    (emailDomain && allowedDomains.includes(emailDomain)) ||
    (hdDomain && allowedDomains.includes(hdDomain));
  if (!domainAllowed) {
    res.setHeader("Set-Cookie", [
      serializeCookie("rs_oauth_state", "", { maxAge: 0 }),
      serializeCookie("rs_pkce_verifier", "", { maxAge: 0 }),
    ]);
    return redirect(
      res,
      `/?auth_error=domain&got=${encodeURIComponent(payload.email || hdDomain || "")}`
    );
  }

  // #13 — don't resurrect an admin-deleted account. If the email is
  // tombstoned (deleted within the ~30-day window), refuse a new session
  // rather than silently re-creating the profile via recordLogin below.
  if (await isTombstoned(payload.email)) {
    res.setHeader("Set-Cookie", [
      serializeCookie("rs_oauth_state", "", { maxAge: 0 }),
      serializeCookie("rs_pkce_verifier", "", { maxAge: 0 }),
    ]);
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
    hd: payload.hd || null,
    // TimeBack SSO: the student's OneRoster id, carried on every Caliper event
    // (actor/assignee). Null for Google logins. This is THE identity source
    // for XP/accuracy/time reporting.
    sourcedId: sourcedId || null,
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

  // Persist the sourcedId on the Redis profile too, so emit sites can recover
  // it even if a request arrives without it on the session (belt + braces).
  if (sourcedId) {
    setOnerosterId(payload.email, sourcedId).catch(() => {});
  }

  // Recover the post-login "next" path encoded into state. safeNextPath
  // rejects protocol-relative / backslash values (open-redirect fix, #12).
  const next = safeNextPath(state.split(":").slice(1).join(":") || "/");

  res.setHeader("Set-Cookie", [
    serializeCookie("rs_session", token, {
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    }),
    serializeCookie("rs_oauth_state", "", { maxAge: 0 }),
    serializeCookie("rs_pkce_verifier", "", { maxAge: 0 }),
  ]);
  redirect(res, next);
}

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}
