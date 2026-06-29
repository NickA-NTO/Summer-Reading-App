// "Sign in with TimeBack" (Cognito) SSO config + PKCE helpers.
//
// Auth model (from the partner provisioning bundle): OAuth2 Authorization Code
// + PKCE, NO client secret. The student logs in at Cognito; the id_token we
// get back carries a `sourcedId` claim — the student's OneRoster id — which we
// put on every Caliper event's actor/assignee. This is the ONLY way we learn a
// real student's sourcedId (the M2M client can't read the master roster).
//
// All values are overridable by env so a re-provision doesn't need a code
// change; defaults come straight from the bundle.

export const TIMEBACK_SSO = {
  clientId:
    process.env.TIMEBACK_SSO_CLIENT_ID || "6qc3vnmu7s0ip9u6gdqq6nlpcj",
  authorizeEndpoint:
    process.env.TIMEBACK_SSO_AUTHORIZE_URL ||
    "https://prod-beyond-timeback-api-2-idp.auth.us-east-1.amazoncognito.com/oauth2/authorize",
  tokenEndpoint:
    process.env.TIMEBACK_SSO_TOKEN_URL ||
    "https://prod-beyond-timeback-api-2-idp.auth.us-east-1.amazoncognito.com/oauth2/token",
  jwksUrl:
    process.env.TIMEBACK_SSO_JWKS_URL ||
    "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_3uhuoRM3R/.well-known/jwks.json",
  issuer:
    process.env.TIMEBACK_SSO_ISSUER ||
    "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_3uhuoRM3R",
  scopes: process.env.TIMEBACK_SSO_SCOPES || "email openid profile",
};

// Which login provider is active. "timeback" = Sign in with TimeBack (PKCE);
// "google" = the legacy Google flow (kept for instant rollback). Default
// google until prod is flipped + verified.
export function authProvider() {
  return (process.env.AUTH_PROVIDER || "google").toLowerCase();
}

// base64url (no padding) of a byte array.
function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Generate a PKCE code_verifier (43-128 chars) — high-entropy random.
export function makeCodeVerifier() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

// code_challenge = base64url(SHA-256(code_verifier)). S256 method.
export async function codeChallengeFor(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", enc(verifier));
  return b64url(new Uint8Array(digest));
}

function enc(s) {
  return new TextEncoder().encode(s);
}
