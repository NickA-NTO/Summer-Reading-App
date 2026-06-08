// Shared session helpers — works on both Edge (middleware) and Node (functions)
// runtimes. Uses only Web Crypto and base64 primitives that exist in both.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(input) {
  const bytes = input instanceof Uint8Array
    ? input
    : new Uint8Array(input.buffer ? input : []);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  let s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// Returns "<base64url(payload)>.<base64url(hmac)>"
export async function signSession(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifySession(token, secret) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  try {
    const key = await hmacKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sig),
      enc.encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(body)));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Decode a Google ID token (JWT) — UNVERIFIED. Kept only for emergency
// fallback inside verifyGoogleIdToken below if Google's JWKS endpoint is
// unreachable AND the request came through our own server-side token
// exchange (which already authenticates the channel with our
// client_secret). Direct callers should use verifyGoogleIdToken instead.
export function decodeIdToken(idToken) {
  const parts = String(idToken).split(".");
  if (parts.length !== 3) throw new Error("malformed id_token");
  return JSON.parse(dec.decode(b64urlDecode(parts[1])));
}

// ---- Google JWKS verification (#58) ----
//
// Verifies a Google-issued id_token end-to-end:
//   1. Fetch Google's JWKS (RSA public keys), 1-hr in-memory TTL.
//   2. Parse the token header to get `kid`; look up the matching key.
//      If unknown, refetch JWKS once (handles key rotation).
//   3. Import the JWK as RSASSA-PKCS1-v1_5 / SHA-256 and verify the
//      signature over header.payload.
//   4. Validate claims: iss is one of Google's two issuers, aud is our
//      client_id, exp is in the future (30 s skew allowed), iat is
//      not in the future (30 s skew allowed).
//
// All using Web Crypto + fetch — no external library, runs identically
// on Edge runtime (middleware.js) and Node functions.
//
// Throws Error with a short reason code on failure.
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_JWKS_TTL_MS = 60 * 60 * 1000; // 1 hr
const GOOGLE_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);
let _jwksCache = null;
let _jwksFetchedAt = 0;

async function fetchGoogleJwks(forceRefresh = false) {
  if (!forceRefresh && _jwksCache &&
      Date.now() - _jwksFetchedAt < GOOGLE_JWKS_TTL_MS) {
    return _jwksCache;
  }
  const r = await fetch(GOOGLE_JWKS_URL);
  if (!r.ok) throw new Error(`jwks_fetch_failed_${r.status}`);
  const data = await r.json();
  _jwksCache = Array.isArray(data?.keys) ? data.keys : [];
  _jwksFetchedAt = Date.now();
  return _jwksCache;
}

export async function verifyGoogleIdToken(idToken, audience) {
  if (!idToken || typeof idToken !== "string") {
    throw new Error("invalid_id_token");
  }
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed_id_token");

  // (1) header
  let header;
  try {
    header = JSON.parse(dec.decode(b64urlDecode(parts[0])));
  } catch {
    throw new Error("invalid_header");
  }
  if (header.alg !== "RS256") {
    // Algorithm-confusion defense: reject HS256 / none / EdDSA / etc.
    throw new Error("unexpected_alg");
  }
  if (!header.kid) throw new Error("missing_kid");

  // (2) JWKS lookup with one refresh-and-retry on miss (key rotation).
  let keys = await fetchGoogleJwks(false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await fetchGoogleJwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error("unknown_kid");

  // (3) Import + verify
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = enc.encode(`${parts[0]}.${parts[1]}`);
  const signature = b64urlDecode(parts[2]);
  const sigOk = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    cryptoKey,
    signature,
    signed
  );
  if (!sigOk) throw new Error("invalid_signature");

  // (4) Claims
  let payload;
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));
  } catch {
    throw new Error("invalid_payload");
  }
  if (!payload || typeof payload !== "object") throw new Error("invalid_payload");

  if (!GOOGLE_ISSUERS.has(payload.iss)) throw new Error("invalid_iss");
  if (audience && payload.aud !== audience) throw new Error("invalid_aud");

  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSec - 30) throw new Error("expired");
  if (payload.iat && payload.iat > nowSec + 30) throw new Error("future_iat");

  return payload;
}

export function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

// Returns true if `email` is in the comma-separated ADMIN_EMAILS env var.
// Case-insensitive match on the full address.
export function isAdmin(email) {
  if (!email) return false;
  const list = String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(email).toLowerCase());
}

export function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  parts.push(`Path=${opts.path || "/"}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${opts.sameSite || "Lax"}`);
  return parts.join("; ");
}
