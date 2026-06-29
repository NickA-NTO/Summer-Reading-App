// TimeBack Caliper transport (TODO 1e).
//
// Responsibilities:
//   - POST Caliper event envelopes to TimeBack's sensor endpoint
//   - One immediate retry on transient failure (5xx, network)
//   - On hard failure, queue the envelope in Redis (`caliper:retry`) for a
//     later cron-driven retry pass
//   - Configurable via env vars; if endpoint isn't set, fail-soft so dev
//     environments don't break.
//
// We intentionally fire-and-forget from /api/activity so a quiz pass response
// never waits on TimeBack — students see XP immediately. If TimeBack is down,
// events queue and drain later.

import { redis, isPreviewEnvironment } from "./store.js";
import { trackEvent, trackError } from "./observability.js";

const RETRY_QUEUE_KEY = "caliper:retry";
const RETRY_QUEUE_CAP = 1000;
// When the queue depth crosses this fraction of the cap we emit a
// telemetry alert — a sustained TimeBack outage will start dropping
// the oldest events past the cap, so we want visibility BEFORE that.
const RETRY_QUEUE_ALERT_AT = 800;

// ── TimeBack event ingestion (Alpha 1EdTech) ────────────────────────────────
// The real platform ingests Caliper events at POST /events/1.0 with a Bearer
// access token minted via OAuth2 client_credentials (HTTP Basic clientId:secret
// → /auth/1.0/token). This replaced the original design's static
// TIMEBACK_CALIPER_URL + TIMEBACK_CALIPER_TOKEN (which were never provisioned,
// so every event silently no-op'd — the reason no XP ever reached TimeBack).
const EVENTS_URL_DEFAULT = "https://api.alpha-1edtech.ai/events/1.0";
const M2M_TOKEN_URL_DEFAULT = "https://api.alpha-1edtech.ai/auth/1.0/token";
const EVENTS_TOKEN_REDIS_KEY = "timeback:events_token";

// True only when events should actually POST. Master switch is
// TIMEBACK_CALIPER_ENABLED=1. The #71 preview guard still holds — a preview
// deploy must never write to real dashboards — EXCEPT when TIMEBACK_SANDBOX=1
// is set explicitly (sandbox verification against partner-sandbox students).
function eventsEnabled() {
  if (String(process.env.TIMEBACK_CALIPER_ENABLED || "") !== "1") return false;
  if (isPreviewEnvironment() && String(process.env.TIMEBACK_SANDBOX || "") !== "1") {
    return false;
  }
  return true;
}

function endpointUrl() {
  if (!eventsEnabled()) return null;
  // Non-null default so a missing env var can no longer silently disable
  // emission — only the explicit gate above can.
  return process.env.TIMEBACK_EVENTS_URL || EVENTS_URL_DEFAULT;
}

/**
 * Mint (or reuse from Redis) a TimeBack M2M access token via the OAuth2
 * client_credentials grant. Mirrors lib/timeback-sync.js getAccessToken: cache
 * in Redis until ~60s before expiry, then re-mint. Exported because the
 * heartbeat route (api/heartbeat.js) posts session/heartbeat events too.
 *
 * Throws on misconfiguration / mint failure — callers treat that as a
 * retryable error (queues), NOT as "no endpoint configured" (drops).
 */
export async function getEventsToken() {
  const r = redis();
  if (r) {
    try {
      const cached = await r.get(EVENTS_TOKEN_REDIS_KEY);
      if (cached) return cached;
    } catch {}
  }
  const id = process.env.TIMEBACK_CLIENT_ID;
  const secret = process.env.TIMEBACK_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("TIMEBACK_CLIENT_ID/TIMEBACK_CLIENT_SECRET not set");
  }
  const tokenUrl = process.env.TIMEBACK_TOKEN_URL || M2M_TOKEN_URL_DEFAULT;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`token_mint_failed_${resp.status} ${body.slice(0, 160)}`);
  }
  const json = await resp.json();
  const token = String(json.access_token || "");
  if (!token) throw new Error("token_mint_no_access_token");
  const ttl = Math.max(60, Number(json.expires_in || 3600) - 60);
  if (r) {
    try { await r.set(EVENTS_TOKEN_REDIS_KEY, token, { ex: ttl }); } catch {}
  }
  return token;
}

/**
 * POST a single Caliper envelope to TimeBack. Returns
 *   { ok: true, status }                — 2xx response
 *   { ok: false, reason, status?, body? }
 *
 * Does NOT throw — callers can fire-and-forget without try/catch.
 */
export async function postCaliperEnvelope(envelope, opts = {}) {
  const url = endpointUrl();
  if (!url) {
    return { ok: false, reason: "no_endpoint_configured" };
  }
  // Mint the Bearer token. A failure here is RETRYABLE (transient network /
  // token blip) — return a reason other than "no_endpoint_configured" so
  // sendCaliperEnvelopeAsync queues it rather than dropping the XP.
  let token;
  try {
    token = await getEventsToken();
  } catch (err) {
    return { ok: false, reason: "token_error", error: String(err?.message || err) };
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  // The events endpoint returns 202 Accepted on success (r.ok covers 2xx).
  const attempts = opts.retries != null ? opts.retries + 1 : 2; // 1 retry by default
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
      });
      if (r.ok) {
        let body = null;
        try {
          body = await r.text();
        } catch {}
        return { ok: true, status: r.status, body };
      }
      // 4xx is a client error — don't retry, surface immediately.
      if (r.status >= 400 && r.status < 500) {
        let body = null;
        try {
          body = await r.text();
        } catch {}
        return {
          ok: false,
          reason: "http_error",
          status: r.status,
          body,
        };
      }
      lastErr = { reason: "http_error", status: r.status };
      // Fall through and retry on 5xx.
    } catch (err) {
      lastErr = { reason: "network_error", error: String(err?.message || err) };
    }
    // Exponential-ish backoff between attempts.
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 200 * (i + 1)));
    }
  }
  return { ok: false, ...lastErr };
}

/**
 * Push a failed envelope onto the Redis retry queue. A future cron job
 * (TODO 1e build step "Failure queue") drains this list.
 *
 * Stored as a JSON string in a Redis LIST. We tag each entry with the
 * push time + original failure reason for the admin "Caliper sync health"
 * surface.
 */
export async function queueCaliperRetry(envelope, failureInfo) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    const entry = JSON.stringify({
      ts: Date.now(),
      envelope,
      failure: failureInfo,
    });
    const depth = await r.lpush(RETRY_QUEUE_KEY, entry);
    // Cap the queue so a sustained TimeBack outage doesn't fill Redis.
    await r.ltrim(RETRY_QUEUE_KEY, 0, RETRY_QUEUE_CAP - 1);
    // #13 — overflow telemetry. Without this a backed-up queue is
    // invisible until someone opens the admin caliper-health panel,
    // and once it passes the cap, the oldest students' XP events are
    // silently dropped. Emit an alert as we approach the cap.
    if (typeof depth === "number" && depth >= RETRY_QUEUE_ALERT_AT) {
      await trackError("caliper_queue_high", {
        depth,
        cap: RETRY_QUEUE_CAP,
      });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

/**
 * Sandbox rollout gate. TIMEBACK_EMIT_MODE=sandbox emits ONLY for explicitly
 * allow-listed test identities (TIMEBACK_TEST_EMAILS, comma-separated, or a
 * profile flagged isTestUser); everyone else is built-but-not-sent so we can
 * verify the pipeline end-to-end against partner-sandbox students before any
 * real ledger is touched. TIMEBACK_EMIT_MODE=live (default) emits for all.
 */
export function shouldEmitFor({ email, profile } = {}) {
  const mode = String(process.env.TIMEBACK_EMIT_MODE || "live").toLowerCase();
  if (mode !== "sandbox") return true;
  if (profile && profile.isTestUser) return true;
  const allow = String(process.env.TIMEBACK_TEST_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const e = String(email || "").trim().toLowerCase();
  return !!e && allow.includes(e);
}

/**
 * Fire-and-forget helper for the quiz-pass hot path. Returns immediately;
 * if TimeBack is unreachable, queues for retry without blocking the caller.
 *
 * @param {object} envelope  the Caliper envelope to POST
 * @param {object} [ctx]     { email, profile } — used by the sandbox gate so
 *                           a non-allow-listed user is built-but-not-sent.
 */
export function sendCaliperEnvelopeAsync(envelope, ctx = {}) {
  // Sandbox rollout gate — skip the POST for non-test users in sandbox mode.
  if (!shouldEmitFor(ctx)) {
    trackEvent("caliper_skipped_sandbox", { email: ctx.email || null });
    return;
  }
  // Don't await — we want this off the request critical path.
  postCaliperEnvelope(envelope)
    .then(async (result) => {
      if (!result.ok && result.reason !== "no_endpoint_configured") {
        await queueCaliperRetry(envelope, result);
      } else if (result.ok) {
        // #13 — opportunistic self-healing drain. On Hobby, Vercel
        // crons fire at most once/day, so we can't rely on the cron
        // cadence alone to clear a backlog. Every time a live event
        // posts successfully, TimeBack is clearly reachable — so drain
        // a small batch of any queued retries right then. Best-effort,
        // off the critical path, never throws into the caller.
        try {
          await drainCaliperRetryQueue({ max: 10 });
        } catch { /* ignore — the daily cron is the backstop */ }
      }
    })
    .catch(async (err) => {
      const result = { reason: "unexpected_error", error: String(err?.message || err) };
      await queueCaliperRetry(envelope, result);
    });
}

/**
 * Admin/cron drain: pop up to `max` envelopes off the retry queue and
 * try them again. Returns counts.
 */
export async function drainCaliperRetryQueue({ max = 50 } = {}) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  let drained = 0;
  let succeeded = 0;
  let stillFailing = 0;
  for (let i = 0; i < max; i++) {
    const entry = await r.rpop(RETRY_QUEUE_KEY);
    if (!entry) break;
    drained++;
    let parsed;
    try {
      parsed = typeof entry === "string" ? JSON.parse(entry) : entry;
    } catch {
      continue; // malformed, drop it
    }
    const result = await postCaliperEnvelope(parsed.envelope, { retries: 0 });
    if (result.ok) {
      succeeded++;
    } else {
      stillFailing++;
      await queueCaliperRetry(parsed.envelope, result);
    }
  }
  return { ok: true, drained, succeeded, stillFailing };
}

export async function getCaliperHealthSnapshot() {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    const queued = await r.llen(RETRY_QUEUE_KEY);
    return {
      ok: true,
      enabled: eventsEnabled(),
      configured: !!endpointUrl(),
      m2mConfigured: !!(process.env.TIMEBACK_CLIENT_ID && process.env.TIMEBACK_CLIENT_SECRET),
      emitMode: process.env.TIMEBACK_EMIT_MODE || "live",
      queuedRetries: queued,
    };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}
