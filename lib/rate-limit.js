// Redis-backed per-actor rate limiter. Used to cap API calls per
// authenticated email so a compromised account can't burn through
// OpenAI / TTS / Anthropic budget unbounded.
//
// Pattern: fixed-window INCR + EXPIRE.
//
//   key = "rl:<bucket>:<email>:<floor(now / windowSec)>"
//
// First call in a window does INCR (returns 1) then EXPIRE (TTL =
// windowSec). Subsequent calls in the same window do INCR which
// returns the running count. If count > max, deny. Window resets
// naturally when the key TTLs out.
//
// Falls open (allows the request) when:
//   - Redis isn't configured (no env)
//   - Redis throws (network blip)
//   - The bucket / email is missing
// Rationale: rate limits are a cost-control + abuse mitigation, not
// a correctness primitive. Failing closed would hand a kid a blank
// app on a transient Redis blip — failing open trades a small abuse
// window for resilience. Pair this with monitoring on the deny rate
// (TODO #68) to catch a regression where everything starts denying.

import { redis } from "./store.js";

/**
 * Increment the rate-limit counter and return whether the caller is
 * still under the cap.
 *
 * @param {object} opts
 * @param {string} opts.email      — actor identity (required)
 * @param {string} opts.bucket     — short tag like "tts" / "quiz" (required)
 * @param {number} opts.max        — max allowed in the window
 * @param {number} opts.windowSec  — window length, seconds
 * @returns {Promise<{ok: true} | {ok: false, retryAfter: number, count: number, max: number}>}
 */
export async function checkRateLimit({ email, bucket, max, windowSec }) {
  if (!email || !bucket || !Number.isFinite(max) || !Number.isFinite(windowSec)) {
    // Misconfigured callers don't get rate-limited (so a typo doesn't
    // brick a whole route). Logged once per process via the warn below.
    if (!_warnedMissing) {
      // eslint-disable-next-line no-console
      console.warn("[rate-limit] called with missing/invalid args", {
        email: !!email, bucket: !!bucket, max, windowSec,
      });
      _warnedMissing = true;
    }
    return { ok: true };
  }
  const r = redis();
  if (!r) return { ok: true }; // no redis → fail open

  const windowFloor = Math.floor(Date.now() / 1000 / windowSec);
  const key = `rl:${bucket}:${String(email).toLowerCase()}:${windowFloor}`;

  try {
    const count = await r.incr(key);
    if (count === 1) {
      // First hit in this window — set the TTL so the key clears itself.
      // pexpire would be more precise but Upstash bills the same.
      await r.expire(key, windowSec);
    }
    if (count > max) {
      // How long until the window resets (best-effort estimate).
      const nowSec = Math.floor(Date.now() / 1000);
      const windowEndSec = (windowFloor + 1) * windowSec;
      const retryAfter = Math.max(1, windowEndSec - nowSec);
      return { ok: false, retryAfter, count, max };
    }
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[rate-limit] redis error — failing open", err);
    return { ok: true };
  }
}

let _warnedMissing = false;

/**
 * Helper to write the 429 response on a denied call. Sets
 * Retry-After + a JSON body that the client can surface nicely.
 */
export function send429(res, denied) {
  res.statusCode = 429;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Retry-After", String(denied.retryAfter || 60));
  res.end(JSON.stringify({
    error: "rate_limited",
    retryAfter: denied.retryAfter,
    limit: denied.max,
  }));
}

// Standard per-endpoint defaults. Tunable in one place if abuse
// patterns surface post-launch. Values chosen to be generous for
// normal use (a kid burning through a quiz + retell + 5 TTS reads
// stays well under) but capped tight enough that an automated
// browser-driven hammer hits the limit fast.
export const LIMITS = {
  tts:         { max: 60,  windowSec: 60 }, // 60 reads/min
  quiz:        { max: 30,  windowSec: 60 }, // 30 starts/grades/min
  tutor:       { max: 20,  windowSec: 60 }, // 20 turns/min
  activity:    { max: 180, windowSec: 60 }, // 180 events/min
  // #19 audit follow-up: scraping the per-grade leaderboards in a loop
  // could exfil the masked top-25 of every grade + hammer the ZRANGE.
  // 30/min is generous for legitimate use (tab open + occasional refresh)
  // but caps the scrape pattern at ~30 cohorts/min.
  leaderboard: { max: 30,  windowSec: 60 },
  // Admin routes — most are read-only but a compromised admin token
  // could pound TimeBack-sync or cache-busting endpoints. Tight cap
  // since real admin work is bursty-low-frequency.
  admin:       { max: 60,  windowSec: 60 },
  // /api/auth/me ?action=export and ?action=delete are irreversible /
  // exfil-shaped. Hourly window because they're one-shot operations.
  selfData:    { max: 5,   windowSec: 3600 },
};
