// Time-on-task heartbeat proxy.
//
// The client pings this route every ~60s while the app is open + the student
// is active. We forward to TimeBack as a SessionEvent (LoggedIn) on the first
// beat of a session, then /events/1.0/heartbeat on every subsequent beat —
// using the M2M token SERVER-SIDE (the client must never hold the secret).
// TimeBack rolls heartbeats into that calendar day's active-minutes.
//
// Identity: the student's OneRoster sourcedId (SSO session or profile
// backfill). No sourcedId → 204 no-op (nothing to attribute).
//
// Gated by the same enable + sandbox switches as all other emission, and
// per-user rate-limited so a buggy/looping client can't hammer the API.

import { verifySession, parseCookies } from "../lib/session.js";
import { redis, getUserProfile } from "../lib/store.js";
import { checkRateLimit } from "../lib/rate-limit.js";
import { postEventRaw, eventsActive, shouldEmitFor } from "../lib/timeback.js";
import { edAppUrl, onerosterUserUrl } from "../lib/caliper.js";

const CALIPER_CONTEXT = "http://purl.imsglobal.org/ctx/caliper/v1p2";
// Server-side TimeBack session record TTL. If no beat arrives within this
// window the session lapses; the next beat opens a fresh one (which is how a
// new calendar day / a tab reopened after a break starts cleanly).
const TB_SESSION_TTL_SEC = 5 * 60; // 5 min
const HEARTBEAT_LIMIT = { max: 6, windowSec: 60 }; // ~1 / 10s/user, generous

function noContent(res) { res.statusCode = 204; return res.end(); }

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.statusCode = 405; return res.end(JSON.stringify({ error: "method" })); }

  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) { res.statusCode = 401; return res.end(JSON.stringify({ error: "unauthenticated" })); }

  // Emission off (preview without sandbox, or master switch off) → silent no-op.
  if (!eventsActive()) return noContent(res);

  // Resolve identity. No sourcedId → nothing to attribute; no-op.
  let sourcedId = session.sourcedId || null;
  let profile = null;
  if (!sourcedId) {
    profile = await getUserProfile(session.email).catch(() => null);
    sourcedId = profile?.onerosterUserId || null;
  }
  if (!sourcedId) return noContent(res);

  // Sandbox rollout gate (same chokepoint as Caliper events).
  if (!profile) profile = await getUserProfile(session.email).catch(() => null);
  if (!shouldEmitFor({ email: session.email, profile })) return noContent(res);

  // Per-user rate limit — silently no-op when exceeded (don't 429 a heartbeat).
  const rl = await checkRateLimit({
    email: session.email, bucket: "heartbeat",
    max: HEARTBEAT_LIMIT.max, windowSec: HEARTBEAT_LIMIT.windowSec,
  });
  if (!rl.ok) return noContent(res);

  const r = redis();
  const nowIso = new Date().toISOString();
  const actor = { id: onerosterUserUrl(sourcedId), type: "Person" };
  const edApp = { id: edAppUrl(), type: "SoftwareApplication" };
  const closing = new URL(req.url, "http://x").searchParams.get("close") === "1";

  // Look up (or open) this user's TimeBack session id.
  const sessKey = `tbsession:${String(session.email).toLowerCase()}`;
  let sessId = null;
  if (r) { try { sessId = await r.get(sessKey); } catch {} }

  try {
    if (!sessId) {
      // First beat — open a session with SessionEvent / LoggedIn.
      sessId = (globalThis.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : `s_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      const login = {
        "@context": CALIPER_CONTEXT,
        id: `urn:uuid:${(globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : sessId}`,
        type: "SessionEvent", profile: "SessionProfile", action: "LoggedIn",
        eventTime: nowIso,
        actor, edApp,
        object: edApp,
        session: { id: `urn:uuid:${sessId}`, type: "Session", startedAtTime: nowIso },
      };
      const r1 = await postEventRaw(login);
      if (!r1.ok) return res.end(JSON.stringify({ ok: false, stage: "login", reason: r1.reason }));
      if (r) { try { await r.set(sessKey, sessId, { ex: TB_SESSION_TTL_SEC }); } catch {} }
    } else {
      // Subsequent beat — heartbeat against the open session.
      const r2 = await postEventRaw(
        { sessionId: sessId, eventTime: nowIso, edApp: edAppUrl() },
        { path: "/heartbeat" }
      );
      // Refresh the TTL so an active student's session stays open.
      if (r2.ok && r && !closing) { try { await r.expire(sessKey, TB_SESSION_TTL_SEC); } catch {} }
      // If the session expired server-side (404), drop our record so the next
      // beat opens a fresh one.
      if (!r2.ok && r2.status === 404 && r) { try { await r.del(sessKey); } catch {} }
    }
    // On an explicit page-close beat, let the session lapse naturally (TTL).
    if (closing && r) { try { await r.expire(sessKey, 30); } catch {} }
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 200; // never surface heartbeat errors to the kid
    return res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
  }
}
