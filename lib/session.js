// Shared session helpers — works on both Edge (middleware) and Node (functions)
// runtimes. Uses only Web Crypto and base64 primitives that exist in both.

const enc = new TextEncoder();
const dec = new TextDecoder();

// #36 — AUTH_SECRET is the key behind session signing, email
// fingerprints, and quiz answer-token HMACs. If it's missing in
// PRODUCTION we must NOT silently fall back to a public constant —
// that would make every hash + token forgeable. Hard-fail instead so
// the deploy crashes loudly rather than shipping guessable secrets.
// In non-production (local/dev/preview without the var) we tolerate a
// clearly-marked fallback so the app still boots for development.
const AUTH_SECRET_DEV_FALLBACK = "dev-fallback-DO-NOT-SHIP";
function authSecret() {
  const s = process.env.AUTH_SECRET;
  if (s) return s;
  if ((process.env.VERCEL_ENV || "").toLowerCase() === "production") {
    throw new Error(
      "AUTH_SECRET is not set in production — refusing to use a guessable " +
        "fallback for session/HMAC signing. Set AUTH_SECRET in the Vercel " +
        "production environment."
    );
  }
  return AUTH_SECRET_DEV_FALLBACK;
}

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

// #19 audit follow-up: tombstone gate for write paths. deleteUserData()
// adds the email to `users:tombstoned`; this helper lets the write
// routes (/api/activity, /api/quiz) reject any session that survived
// the cookie clear (typically a concurrent tab mid-request). Read-only
// routes don't need this — they just see empty data after the wipe.
// Not folded into verifySession because middleware.js runs on Edge and
// would hit Redis on every page navigation. Fails OPEN on Redis blip
// so a transient outage doesn't lock every kid out.
export async function isTombstoned(email) {
  if (!email) return false;
  try {
    const { redis } = await import("./store.js");
    const r = redis();
    if (!r) return false;
    const tomb = await r.sismember(
      "users:tombstoned",
      String(email).toLowerCase()
    );
    return tomb === 1 || tomb === true;
  } catch {
    return false;
  }
}

// Validate a post-login redirect target. Only a SAME-ORIGIN, single-slash-
// rooted local path is allowed. Rejects protocol-relative ("//evil.com") and
// backslash ("/\evil.com") values that browsers resolve cross-origin — the
// open-redirect vector (#12). Returns "/" for anything unsafe.
export function safeNextPath(next) {
  const s = String(next || "");
  if (!s.startsWith("/")) return "/";
  if (s.startsWith("//") || s.startsWith("/\\")) return "/";
  try {
    const u = new URL(s, "http://localhost");
    if (u.origin !== "http://localhost") return "/";
    return (u.pathname || "/") + u.search + u.hash;
  } catch {
    return "/";
  }
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
  // #19 audit follow-up: bound the JWKS fetch so a slow Google response
  // can't stall the whole login function until Vercel's gateway kills
  // it. 3 s is generous — typical JWKS reply is sub-100 ms.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  let r;
  try {
    r = await fetch(GOOGLE_JWKS_URL, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!r.ok) throw new Error(`jwks_fetch_failed_${r.status}`);
  const data = await r.json();
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  // #19: don't cache an empty array. If Google has ever returned a 200
  // with no keys (their docs say this shouldn't happen but it has
  // during incidents), pinning [] for an hour would 100% fail every
  // login. On empty: throw so the caller's retry path runs, AND don't
  // mutate the cache.
  if (keys.length === 0) {
    throw new Error("jwks_empty_response");
  }
  _jwksCache = keys;
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

// #47 — peer-facing display name. Reduce a kid's full name to "First L."
// (first name + last initial + period). Used everywhere a student name
// is rendered in front of other students: comments, leaderboard rows,
// "X just earned a badge" toasts, etc. Admin/teacher views render the
// full name server-side via separate codepaths.
//
// Edge cases:
//   - Single word ("Alex")          → "Alex"
//   - Multi-word last ("De La Cruz")→ takes the FIRST char of the last
//                                     space-delimited token: "Alex C."
//   - Already-redacted ("Alex C.")  → returned unchanged
//   - Email passed in instead       → uses the local-part before @
//   - Empty / null                  → "Reader"
export function displayName(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return "Reader";
  // Already a "First L." form
  if (/^\S+ [A-Z]\.$/.test(s)) return s;
  // Email shape
  const localPart = s.includes("@") ? s.split("@")[0] : s;
  const cleaned = localPart.replace(/[._\-]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "Reader";
  if (parts.length === 1) {
    // Title-case the single token
    const w = parts[0];
    return w.charAt(0).toUpperCase() + w.slice(1);
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const firstCap = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  const lastInit = last.charAt(0).toUpperCase();
  return `${firstCap} ${lastInit}.`;
}

// #52 — one-way email fingerprint for storage in admin-facing queues
// (held comments, future moderation log entries). HMAC-SHA-256 with
// AUTH_SECRET so the same email → same fingerprint deterministically
// (admins can group repeat offenders) but the value isn't reversible
// without the server secret. Returns a 16-char hex prefix — long
// enough for collision resistance in our scale, short enough to read.
export async function emailHash(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return "";
  const secret = authSecret();
  try {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(e));
    const bytes = new Uint8Array(sig);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex.slice(0, 16);
  } catch {
    return "";
  }
}

// Self-contained quiz-answer signing. Replaces the fragile Redis
// pool-cache lookup at grade time. The server signs (bookId, qText,
// correctIdx) with AUTH_SECRET when /api/quiz generates the pool;
// the token rides on each question alongside q.options. At grade
// time, /api/activity quiz_submit recomputes the HMAC for the kid's
// CHOSEN index — if it matches the token they were given, they
// picked correctly. No server-side state needed.
//
// Security model (#16 hardened):
//   - Kid sees the token but can't decode the correctIdx from it
//     (HMAC is one-way).
//   - The token is now bound to the STUDENT (email) and a DAILY time
//     bucket. So a token can't be:
//       * shared/replayed across different kids' accounts (email-bound)
//       * replayed on a later day to auto-pass without reading
//         (day-bucket-bound; verify accepts today + yesterday only,
//         so a legit fetch-before-midnight / submit-after still works)
//   - Tokens are generated PER-REQUEST at serve time (not stored in
//     the shared Redis pool), so each kid gets their own bound set.
//   - Brute force: kid could submit each idx 0..3 to find the correct
//     one, but the per-day 2-attempt cap + dedup-per-question cap that.
//
// `opts.email` (lowercased) + `opts.dayBucket` (defaults to the current
// UTC day) are folded into the HMAC payload. Callers that omit them get
// the legacy unbound token (kept only so a stale cached pool doesn't
// hard-fail mid-deploy; SCHEMA_VERSION bump retires those quickly).
export function quizDayBucket(ts = Date.now()) {
  return Math.floor(ts / 86_400_000); // UTC day index
}
export async function signQuizAnswer(bookId, qText, correctIdx, opts = {}) {
  const secret = authSecret();
  const email = opts.email ? String(opts.email).toLowerCase() : "";
  const bucket = opts.dayBucket != null ? opts.dayBucket : (opts.email ? quizDayBucket() : "");
  // Legacy payload shape when no email is supplied (back-compat);
  // bound shape when it is.
  const payload = email
    ? `${bookId}|${qText}|${Number(correctIdx)}|${email}|${bucket}`
    : `${bookId}|${qText}|${Number(correctIdx)}`;
  try {
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
    const bytes = new Uint8Array(sig);
    let hex = "";
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex.slice(0, 32);
  } catch {
    return "";
  }
}
export async function verifyQuizAnswer(bookId, qText, chosenIdx, token, opts = {}) {
  if (!token || typeof token !== "string") return false;
  // When an email is supplied, accept a token bound to TODAY or
  // YESTERDAY (covers a quiz fetched just before a UTC midnight and
  // submitted just after). Without an email, fall back to the legacy
  // unbound check.
  if (opts.email) {
    const today = quizDayBucket();
    for (const bucket of [today, today - 1]) {
      const expected = await signQuizAnswer(bookId, qText, chosenIdx, {
        email: opts.email, dayBucket: bucket,
      });
      if (expected && expected === token) return true;
    }
    return false;
  }
  const expected = await signQuizAnswer(bookId, qText, chosenIdx);
  return expected && expected === token;
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

// Hard-coded bypass-list for the time-based quiz holds (started-recently
// timer + WCPM speed check). Granted for demo / VIP accounts that need
// to run through the kid flow rapidly without waiting 15-60 minutes.
// This is NOT admin permission — these users still can't access the
// admin panel, set anyone else's grade, view held-XP, etc. They only
// get the time-check exemption. The reopen-pattern lookup detector
// still applies.
//
// Maintained as a code-level list (vs env var) so it's reviewable in
// git history and survives Vercel env-var migrations. Add new entries
// here as needed; case-insensitive match.
const HARDCODED_BYPASS_QUIZ_HOLDS = new Set([
  "andy.montgomery@alpha.school",
  "andy.montgomery@trilogy.com",
]);
export function isHardcodedBypassQuizHolds(email) {
  if (!email) return false;
  return HARDCODED_BYPASS_QUIZ_HOLDS.has(String(email).toLowerCase());
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
