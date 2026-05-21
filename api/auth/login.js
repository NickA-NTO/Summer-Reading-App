// Kicks off the Google OAuth flow. Sets a short-lived state cookie so we can
// CSRF-check the redirect back, then bounces the user to Google.

import { serializeCookie } from "../../lib/session.js";

export default function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    return res.end(
      "Auth not configured: GOOGLE_CLIENT_ID is missing in this environment."
    );
  }

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const redirectUri = `${proto}://${host}/api/auth/callback`;

  // Generate a random state token for CSRF protection
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = Array.from(stateBytes, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

  // If middleware redirected here with a "next" param, preserve it through the
  // OAuth dance via the state payload.
  const url = new URL(req.url, `${proto}://${host}`);
  const next = url.searchParams.get("next") || "/";
  // Embed the next path into state as `<csrf>:<next>` (cookie stores same).
  const stateValue = `${state}:${next}`;

  // ALLOWED_DOMAIN is a comma-separated list (e.g. "alpha.school,trilogy.com").
  // If exactly one domain is configured, pass it as `hd` to filter the Google
  // account picker to that workspace. With multiple, pass `hd=*` so the picker
  // hides personal @gmail.com accounts but still shows all the user's
  // workspace accounts. Real enforcement happens in the callback.
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

  res.setHeader(
    "Set-Cookie",
    serializeCookie("rs_oauth_state", stateValue, { maxAge: 600 })
  );
  res.statusCode = 302;
  res.setHeader(
    "Location",
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  );
  res.end();
}
