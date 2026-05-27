// Lightweight observability — Redis-backed error counters + structured
// console logging. Built to fix Agent 6's catastrophic "no observability"
// flag without adding a vendor (Sentry, Datadog, etc.). When the app
// scales past a single Guide-checking-the-admin-panel cadence, swap the
// `trackError` body for a real metrics push.
//
// Design:
//   - trackError(category, err, context) — increments a per-day counter
//     keyed `obs:errors:{YYYY-MM-DD}` with field=category. 7-day TTL so
//     we never balloon Redis. Also console.warns with a parseable prefix.
//   - trackEvent(category, context) — same shape but for INFO-level
//     signals (quiz_generated, achievement_unlocked, etc.). Different
//     hash so error queries stay clean.
//   - getStats(days) — returns 7 days of counts for an admin dashboard.
//
// Categories live in catch blocks; pick stable names so the dashboard
// stays useful as code changes. Suggested:
//   quiz_generation_failed, polly_failed, caliper_failed, redis_failed,
//   fraud_held, auth_domain_rejected, achievement_eval_failed.

import { redis } from "./store.js";

const RETENTION_DAYS = 7;

function isoDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** Record an error. Increments today's counter for `category`. Non-fatal. */
export async function trackError(category, err, context = {}) {
  const msg = err instanceof Error ? err.message : String(err || "");
  console.warn(`[obs:error] ${category} ${msg}`, JSON.stringify(context));
  const r = redis();
  if (!r) return;
  const key = `obs:errors:${isoDay()}`;
  try {
    await r.hincrby(key, category, 1);
    await r.expire(key, RETENTION_DAYS * 86400);
  } catch {
    /* observability must never break the request */
  }
}

/** Record an info event (e.g., quiz_generated, fraud_held). Non-fatal. */
export async function trackEvent(category, context = {}) {
  if (process.env.OBS_VERBOSE) {
    console.log(`[obs:event] ${category}`, JSON.stringify(context));
  }
  const r = redis();
  if (!r) return;
  const key = `obs:events:${isoDay()}`;
  try {
    await r.hincrby(key, category, 1);
    await r.expire(key, RETENTION_DAYS * 86400);
  } catch {}
}

/**
 * Return the last `days` days of error + event counts. Shape:
 *   { days: [{ date, errors: {cat: n}, events: {cat: n} }, ...] }
 */
export async function getStats(days = RETENTION_DAYS) {
  const r = redis();
  if (!r) return { hasRedis: false, days: [] };
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = isoDay(new Date(Date.now() - i * 86_400_000));
    try {
      const [errors, events] = await Promise.all([
        r.hgetall(`obs:errors:${d}`),
        r.hgetall(`obs:events:${d}`),
      ]);
      out.push({ date: d, errors: errors || {}, events: events || {} });
    } catch {
      out.push({ date: d, errors: {}, events: {} });
    }
  }
  return { hasRedis: true, days: out };
}
