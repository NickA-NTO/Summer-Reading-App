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

const RETRY_QUEUE_KEY = "caliper:retry";

function endpointUrl() {
  // #71 — preview / development deployments MUST NOT POST to the real
  // TimeBack Caliper endpoint. Test quiz attempts on the preview URL
  // would otherwise show up in the real student dashboards. Returning
  // null short-circuits postCaliperEnvelope to "no_endpoint_configured"
  // — same path used when TIMEBACK_CALIPER_URL is unset locally.
  if (isPreviewEnvironment()) return null;
  return process.env.TIMEBACK_CALIPER_URL || null;
}
function authHeader() {
  const token = process.env.TIMEBACK_CALIPER_TOKEN;
  if (!token) return null;
  // Default to Bearer; some Caliper endpoints use a custom scheme — TimeBack
  // can specify via TIMEBACK_CALIPER_AUTH_SCHEME ("Bearer", "ApiKey", "JWT", …).
  const scheme = process.env.TIMEBACK_CALIPER_AUTH_SCHEME || "Bearer";
  return `${scheme} ${token}`;
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
  const headers = { "Content-Type": "application/json" };
  const auth = authHeader();
  if (auth) headers.Authorization = auth;

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
    await r.lpush(RETRY_QUEUE_KEY, entry);
    // Cap the queue so a sustained TimeBack outage doesn't fill Redis.
    await r.ltrim(RETRY_QUEUE_KEY, 0, 999);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

/**
 * Fire-and-forget helper for the quiz-pass hot path. Returns immediately;
 * if TimeBack is unreachable, queues for retry without blocking the caller.
 */
export function sendCaliperEnvelopeAsync(envelope) {
  // Don't await — we want this off the request critical path.
  postCaliperEnvelope(envelope)
    .then(async (result) => {
      if (!result.ok && result.reason !== "no_endpoint_configured") {
        await queueCaliperRetry(envelope, result);
      }
    })
    .catch(async (err) => {
      await queueCaliperRetry(envelope, {
        reason: "unexpected_error",
        error: String(err?.message || err),
      });
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
      configured: !!endpointUrl(),
      tokenConfigured: !!process.env.TIMEBACK_CALIPER_TOKEN,
      queuedRetries: queued,
    };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}
