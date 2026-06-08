// Thin wrapper around Upstash Redis. Used for:
//   - Caching AI-generated quizzes (so retries see the same questions)
//   - Tracking unique reads per user (deduped, for leaderboards)
//   - Maintaining sorted-set leaderboards (all-time + per-ISO-week)
//
// Gracefully degrades to no-op if the Redis env vars aren't configured yet,
// so the rest of the app still works while the Marketplace integration is
// being provisioned.

import { Redis } from "@upstash/redis";

let _client = null;

// #71 — environment-keyed Redis key prefix.
//
// VERCEL_ENV is set by Vercel to "production" | "preview" | "development".
// Production traffic keeps the historical (un-prefixed) keys so existing
// data stays put. Preview + local dev get a prefix on every key so test
// users don't pollute the leaderboard, fraud state, currentlyReading,
// quiz cache, held-XP queue, or anything else that lives in Redis.
//
// We share the same Upstash database across environments to keep costs
// flat — the prefix is a code-only namespace. If we ever need true
// isolation (e.g., load-testing preview without touching production
// memory limits), provision a second Upstash and set KV_REST_API_URL
// only for the Preview environment in the Vercel dashboard.
export const KEY_PREFIX = (() => {
  const env = (process.env.VERCEL_ENV || "production").toLowerCase();
  if (env === "production") return "";
  return `${env}:`; // "preview:" or "development:"
})();

// Single-key Redis methods whose FIRST argument is a key we should prefix.
// Multi-key methods (mget/mset/etc.) aren't auto-prefixed — none of the
// current call sites use them, and adding support is tricky enough to be
// worth doing explicitly when it's actually needed.
const PREFIXED_METHODS = new Set([
  // Strings
  "get", "set", "setnx", "del", "exists", "expire", "pexpire", "ttl",
  "incr", "decr", "incrby", "decrby",
  // Hashes
  "hget", "hset", "hgetall", "hdel", "hincrby", "hmget", "hmset",
  "hkeys", "hvals", "hlen", "hsetnx", "hexists",
  // Sets
  "sadd", "srem", "sismember", "smembers", "scard",
  // Lists
  "lpush", "rpush", "lpop", "rpop", "lrange", "llen", "ltrim",
  // Sorted sets
  "zadd", "zrem", "zincrby", "zrange", "zrevrange", "zcard", "zscore",
  "zrangebyscore", "zrevrangebyscore",
]);

// Wrap an Upstash client so every prefixed method auto-namespaces its
// first argument when KEY_PREFIX is non-empty. pipeline() returns a
// transaction object — we re-wrap that too so pipeline.set("k", v) gets
// the same treatment as r.set("k", v).
function wrapClient(target) {
  return new Proxy(target, {
    get(t, prop) {
      const v = t[prop];
      if (typeof v !== "function") return v;
      // pipeline / multi return chainable objects with the same shape
      if (prop === "pipeline" || prop === "multi") {
        return (...args) => wrapClient(v.apply(t, args));
      }
      if (!KEY_PREFIX) return v.bind(t);
      if (!PREFIXED_METHODS.has(prop)) return v.bind(t);
      return (...args) => {
        if (args.length > 0 && typeof args[0] === "string") {
          args = [KEY_PREFIX + args[0], ...args.slice(1)];
        }
        return v.apply(t, args);
      };
    },
  });
}

export function redis() {
  if (_client !== null) return _client;
  // Vercel's Upstash marketplace integration auto-provisions KV_* aliases;
  // Upstash's own SDK reads UPSTASH_REDIS_*. Try both.
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    _client = false; // sentinel: don't try again
    return null;
  }
  _client = wrapClient(new Redis({ url, token }));
  return _client;
}

export function hasRedis() {
  return !!redis();
}

// Convenience: is this code running on a non-production Vercel deployment?
// Used by callers (e.g. Caliper transport) to gate side effects that
// would otherwise hit real third-party systems with test data.
export function isPreviewEnvironment() {
  return KEY_PREFIX !== "";
}

/* ---------- Quiz cache ---------- */

export async function getCachedQuiz(bookId) {
  const r = redis();
  if (!r) return null;
  try {
    return await r.get(`quiz:${bookId}`);
  } catch {
    return null;
  }
}

// Invalidate every grade-variant cache entry for a book. Used when a question
// from this book has been confirmed bad by an admin — next request will
// regenerate a fresh pool through Opus + QC.
//
// Bug fix (Agent 7 round 2): the previous pattern was hardcoded to v5;
// the live schema is now v8 so admin "confirm bad question" silently
// did nothing for the entire current cache namespace. Version-agnostic
// pattern (`quiz:v*:bookId:*`) keeps it working across future schema
// bumps without another manual edit.
export async function bustQuizCache(bookId) {
  const r = redis();
  if (!r) return 0;
  try {
    // Match every schema version + every grade/age cache namespace
    const pattern = `quiz:v*:${bookId}:*`;
    let cursor = 0;
    let total = 0;
    do {
      const res = await r.scan(cursor, { match: pattern, count: 100 });
      cursor = Number(res[0]);
      const keys = res[1] || [];
      if (keys.length) {
        await r.del(...keys);
        total += keys.length;
      }
    } while (cursor !== 0);
    return total;
  } catch {
    return 0;
  }
}

export async function setCachedQuiz(bookId, quiz) {
  const r = redis();
  if (!r) return;
  try {
    // Cache for 30 days — kids see consistent questions on retry
    await r.set(`quiz:${bookId}`, quiz, { ex: 60 * 60 * 24 * 30 });
  } catch {
    /* swallow */
  }
}

/* ---------- Leaderboard ---------- */

// Compute current ISO week as "YYYY-Www" (e.g. "2026-W21").
function currentIsoWeek() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Merge new fields into the existing user profile stored at users[email].
// Existing values are preserved unless explicitly overridden.
async function mergeUserProfile(client, email, updates) {
  const e = String(email).toLowerCase();
  let existing = {};
  try {
    const raw = await client.hget("users", e);
    if (raw) existing = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    /* ignore */
  }
  const merged = { ...existing, ...updates };
  await client.hset("users", { [e]: JSON.stringify(merged) });
  return merged;
}

/**
 * Lock the user's INITIAL working grade — the grade they had when they
 * first appeared in the system. Used by the stretch-ladder achievements
 * so growth doesn't move the goalposts: a kid who joins at Grade 2 and
 * reads a Grade 4 book always earns "Climbing the Mountain", even if
 * they later graduate to Grade 3 themselves.
 *
 * Idempotent — first write wins, subsequent calls no-op. Returns the
 * locked initial grade (existing or freshly written).
 */
export async function setInitialGradeIfMissing(email, currentGrade) {
  const r = redis();
  if (!r) return currentGrade || null;
  const e = String(email).toLowerCase();
  try {
    const raw = await r.hget("users", e);
    const profile = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
    if (profile.initialGrade) return profile.initialGrade;
    if (!currentGrade) return null;
    await mergeUserProfile(r, e, { initialGrade: currentGrade });
    return currentGrade;
  } catch {
    // Redis hiccup — fall through to the current grade so the eval still
    // works for this request; we'll try to lock again on the next visit.
    return currentGrade || null;
  }
}

// Record that `email` finished `bookId`. Idempotent — if the same book is
// recorded again, leaderboards are NOT double-incremented. Returns true if
// this was a new read, false if it was already recorded.
//
// `points` is the internal-leaderboard reward for finishing this book at
// the student's grade. Computed by the caller via lib/xp.js. Awarded
// only on the first recorded read.
export async function recordRead({ email, name, grade, bookId, points = 0 }) {
  const r = redis();
  if (!r) return { recorded: false, reason: "no_redis" };

  const e = String(email).toLowerCase();
  try {
    // SADD returns 1 if added, 0 if already in the set
    const added = await r.sadd(`user:${e}:books`, bookId);
    if (added === 0) {
      return { recorded: false, reason: "already_read", points: 0 };
    }

    // Merge name/grade into the profile (don't clobber other fields)
    await mergeUserProfile(r, e, {
      name: name || e.split("@")[0],
      grade: grade || null,
      lastReadAt: Date.now(),
    });

    const week = currentIsoWeek();
    const p = r.pipeline();
    // Count-based sorted sets (legacy, kept for back-compat)
    p.zincrby("lb:reads:all", 1, e);
    p.zincrby(`lb:reads:week:${week}`, 1, e);
    if (grade) p.zincrby(`lb:reads:grade:${grade}`, 1, e);
    // Points-based sorted sets (primary leaderboard going forward)
    if (points > 0) {
      p.zincrby("lb:points:all", points, e);
      p.zincrby(`lb:points:week:${week}`, points, e);
      if (grade) p.zincrby(`lb:points:grade:${grade}`, points, e);
      // Audit trail: how many points this particular book awarded this user
      p.set(`user:${e}:book:${bookId}:points`, points);
    }
    await p.exec();

    return { recorded: true, points };
  } catch (err) {
    return { recorded: false, reason: "redis_error", error: String(err) };
  }
}

// Track a sign-in. Updates lastLoginAt + loginCount, and stamps firstLoginAt
// the first time we see a user. Used by the admin user list.
export async function recordLogin({ email, name, picture, hd }) {
  const r = redis();
  if (!r) return { recorded: false, reason: "no_redis" };

  const e = String(email).toLowerCase();
  const now = Date.now();
  try {
    const existing = await r.hget("users", e);
    let parsed = {};
    try {
      parsed = existing
        ? typeof existing === "string"
          ? JSON.parse(existing)
          : existing
        : {};
    } catch {}
    const merged = {
      ...parsed,
      name: name || parsed.name || e.split("@")[0],
      picture: picture || parsed.picture || null,
      domain: hd || parsed.domain || e.split("@")[1] || null,
      firstLoginAt: parsed.firstLoginAt || now,
      lastLoginAt: now,
      loginCount: (parsed.loginCount || 0) + 1,
    };
    await r.hset("users", { [e]: JSON.stringify(merged) });
    return { recorded: true };
  } catch (err) {
    return { recorded: false, reason: "redis_error", error: String(err) };
  }
}

// Returns every known user with their profile + read count, sorted by
// lastLoginAt descending. Used by the admin screen.
export async function listAllUsers() {
  const r = redis();
  if (!r) return { users: [], hasRedis: false };
  try {
    const all = await r.hgetall("users");
    if (!all) return { users: [], hasRedis: true };

    const emails = Object.keys(all);
    if (!emails.length) return { users: [], hasRedis: true };

    // Pull read counts + fraud flag counts for each user in parallel
    const [counts, flagCounts] = await Promise.all([
      Promise.all(emails.map((e) => r.scard(`user:${e}:books`).catch(() => 0))),
      Promise.all(emails.map((e) => r.get(`user:${e}:flagCount`).catch(() => null))),
    ]);

    const users = emails.map((email, i) => {
      let prof = {};
      try {
        const v = all[email];
        prof = typeof v === "string" ? JSON.parse(v) : v;
      } catch {}
      return {
        email,
        name: prof.name || email.split("@")[0],
        domain: prof.domain || email.split("@")[1] || null,
        grade: prof.grade || null,
        gradeSetBy: prof.gradeSetBy || null,
        loginCount: prof.loginCount || 0,
        firstLoginAt: prof.firstLoginAt || null,
        lastLoginAt: prof.lastLoginAt || null,
        lastReadAt: prof.lastReadAt || null,
        booksRead: counts[i] || 0,
        flagCount: flagCounts[i] ? Number(flagCounts[i]) : 0,
        trackOverrides: prof.trackOverrides || {},
      };
    });

    // Most recently active first
    users.sort(
      (a, b) =>
        (b.lastLoginAt || 0) - (a.lastLoginAt || 0) ||
        b.booksRead - a.booksRead
    );
    return { users, hasRedis: true };
  } catch (err) {
    return { users: [], hasRedis: true, error: String(err) };
  }
}

// Returns { entries: [{name, grade, points, books, isYou}], me: {points, books, rank} }
// Ranked by points (the primary leaderboard metric). Each entry also
// includes the user's book count so the UI can display both.
export async function getLeaderboard({
  window = "all",
  limit = 25,
  viewerEmail = null,
  grade = null,
} = {}) {
  const r = redis();
  if (!r) {
    return {
      entries: [],
      me: { points: 0, books: 0, rank: null },
      hasRedis: false,
    };
  }

  // Primary sort key: points sorted set.
  //   grade=null + window=all  → "lb:points:all"
  //   grade=null + window=week → "lb:points:week:{ISO_WEEK}"
  //   grade=X (any)            → "lb:points:grade:{X}" (all-time cohort)
  // We maintain only an all-time per-grade ZSET (recordRead writes to
  // `lb:points:grade:{grade}` on every read). A grade+week combo would
  // need a third ZSET — punted; the "My Grade" tab is all-time only.
  const pointsKey =
    grade
      ? `lb:points:grade:${grade}`
      : window === "week"
        ? `lb:points:week:${currentIsoWeek()}`
        : "lb:points:all";

  let raw;
  try {
    raw = await r.zrange(pointsKey, 0, limit - 1, { rev: true, withScores: true });
  } catch {
    return {
      entries: [],
      me: { points: 0, books: 0, rank: null },
      hasRedis: true,
    };
  }

  // @upstash/redis returns flat [member, score, member, score, ...]
  const entries = [];
  for (let i = 0; i < raw.length; i += 2) {
    entries.push({ email: String(raw[i]), points: Math.floor(Number(raw[i + 1])) });
  }

  // Pull profiles + per-user book counts in parallel
  let profiles = [];
  let bookCounts = [];
  if (entries.length) {
    const emails = entries.map((e) => e.email);
    try {
      [profiles, bookCounts] = await Promise.all([
        r.hmget("users", ...emails),
        Promise.all(emails.map((e) => r.scard(`user:${e}:books`).catch(() => 0))),
      ]);
    } catch {
      profiles = emails.map(() => null);
      bookCounts = emails.map(() => 0);
    }
  }

  // #53 — small-cohort masking. A class with only 1-3 readers + per-
  // grade leaderboard = the kid's First+initial maps 1:1 to a real
  // student. Below MIN_LEADERBOARD_COHORT_NAMES we replace names with
  // generic "Reader N" so position is preserved but identity isn't.
  // The viewer still sees "YOU" on their own row via isYou. We only
  // apply this to per-grade boards — global all-time / week is large
  // enough that masking would be theater. Tune the threshold here.
  const MIN_LEADERBOARD_COHORT_NAMES = 4;
  const maskSmallCohort = !!grade && entries.length < MIN_LEADERBOARD_COHORT_NAMES;
  const viewer = (viewerEmail || "").toLowerCase();
  const decorated = entries.map((e, i) => {
    let prof = {};
    try {
      prof = profiles[i] ? JSON.parse(profiles[i]) : {};
    } catch {}
    const realName = maskName(prof.name) || maskName(e.email.split("@")[0]);
    return {
      name: maskSmallCohort ? `Reader ${i + 1}` : realName,
      grade: prof.grade || null,
      points: e.points,
      books: bookCounts[i] || 0,
      isYou: e.email.toLowerCase() === viewer,
    };
  });

  // Viewer's own stats: points total, book count, and global rank (by points)
  let me = { points: 0, books: 0, rank: null };
  if (viewer) {
    try {
      const [books, points, rank] = await Promise.all([
        r.scard(`user:${viewer}:books`),
        r.zscore("lb:points:all", viewer),
        r.zrevrank("lb:points:all", viewer),
      ]);
      me = {
        points: Math.floor(Number(points) || 0),
        books: books || 0,
        rank: rank != null ? rank + 1 : null,
      };
    } catch {}
  }

  return { entries: decorated, me, hasRedis: true };
}

// "Sarah Alsford" -> "Sarah A."   |   "sarah" -> "sarah"
function maskName(name) {
  if (!name) return null;
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/* ---------- TTS usage tracking + audio URL cache ---------- */

// Get the current total number of chars synthesized this period.
// Returns 0 if Redis isn't configured.
export async function getTtsUsage() {
  const r = redis();
  if (!r) return { chars: 0, hasRedis: false };
  try {
    const chars = (await r.get("tts:usage:chars")) || 0;
    return { chars: Number(chars), hasRedis: true };
  } catch {
    return { chars: 0, hasRedis: true };
  }
}

// Increment the running TTS usage counter by `n` chars. Returns the new total.
export async function addTtsUsage(n) {
  const r = redis();
  if (!r) return 0;
  try {
    const total = await r.incrby("tts:usage:chars", Math.max(0, n | 0));
    return Number(total);
  } catch {
    return 0;
  }
}

// Look up a previously-cached TTS audio URL for this (voice, text) pair.
export async function getCachedTtsUrl(cacheKey) {
  const r = redis();
  if (!r) return null;
  try {
    return (await r.get(`tts:url:${cacheKey}`)) || null;
  } catch {
    return null;
  }
}

export async function setCachedTtsUrl(cacheKey, url) {
  const r = redis();
  if (!r) return;
  try {
    // Cache for 90 days — Blob URLs are stable; we'll regenerate on miss
    await r.set(`tts:url:${cacheKey}`, url, { ex: 60 * 60 * 24 * 90 });
  } catch {
    /* ignore */
  }
}

// Best-effort grade inference from an email (we'd want a real attribute long-term).
// Heuristic: look for "k", "1st", "g1", "grade-2" etc. in the local-part.
export function guessGradeFromEmail(email) {
  const local = String(email || "").toLowerCase().split("@")[0];
  if (/(^|[^a-z])k(\d|$)/.test(local) || /kinder/.test(local)) return "K";
  if (/(^|[^a-z])(1st|g1|grade-?1)([^a-z]|$)/.test(local)) return "1";
  if (/(^|[^a-z])(2nd|g2|grade-?2)([^a-z]|$)/.test(local)) return "2";
  return null;
}

/* ---------- Admin: set working grade explicitly ---------- */

// Admins can override a student's working grade. Stored in the user profile
// hash so /api/auth/me picks it up next sign-in.
//
// setBy distinguishes the source:
//   - "admin"          → manual override via admin UI (takes precedence;
//                        sync should not clobber)
//   - "timeback-sync"  → bulk sync from TimeBack's rpt2_mastery (1i)
export async function setUserWorkingGrade(email, grade, setBy = "admin") {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const e = String(email).toLowerCase();
  try {
    await mergeUserProfile(r, e, {
      grade: grade,
      gradeSetAt: Date.now(),
      gradeSetBy: setBy,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

// Age grade is separate from working grade. Working grade drives catalog
// visibility + XP math; age grade drives question MATURITY (tone, framing,
// distractor sophistication — see MATURITY_GUIDANCE in api/quiz.js). Used
// when a student reads above/below age-grade and we want quiz prompts to
// feel age-appropriate even when the working level is mismatched.
// Setter mirrors setUserWorkingGrade for symmetry — admin-attributed,
// merges into the profile so other fields aren't disturbed.
export async function setUserAgeGrade(email, ageGrade, setBy = "admin") {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const e = String(email).toLowerCase();
  try {
    await mergeUserProfile(r, e, {
      ageGrade: ageGrade,
      ageGradeSetAt: Date.now(),
      ageGradeSetBy: setBy,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

// Generic profile updater for onboarding settings (#17). Used to persist
// the student's preferred TTS voice and tour-completion state across
// devices. Returns the merged profile or {ok:false}.
export async function updateUserOnboarding(
  email,
  { preferredVoiceId, tourCompleted }
) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const e = String(email).toLowerCase();
  const patch = {};
  if (typeof preferredVoiceId === "string" && preferredVoiceId.length <= 32) {
    patch.preferredVoiceId = preferredVoiceId;
  }
  if (typeof tourCompleted === "boolean") {
    patch.tourCompleted = tourCompleted;
    if (tourCompleted) patch.tourCompletedAt = Date.now();
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, reason: "nothing_to_update" };
  }
  try {
    const merged = await mergeUserProfile(r, e, patch);
    return {
      ok: true,
      preferredVoiceId: merged.preferredVoiceId || null,
      tourCompleted: !!merged.tourCompleted,
    };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

// Admin sets per-track visibility overrides for a single student.
// Overrides is a sanitized map like { e: "locked", a: "unlocked" } —
// missing keys default to "auto" (the at-or-below-working-grade rule).
export async function setTrackOverrides(email, overrides) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const e = String(email).toLowerCase();
  try {
    await mergeUserProfile(r, e, {
      trackOverrides: overrides || {},
      trackOverridesSetAt: Date.now(),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

/**
 * Bulk-apply working-grade updates from TimeBack sync (1i).
 *
 * Per-row policy:
 *   - No existing user profile   → SKIP (don't pre-create rows for kids who
 *                                  haven't signed in; avoids polluting Redis
 *                                  with thousands of TimeBack rosters)
 *   - gradeSetBy === "admin"     → SKIP (manual override wins) unless opts.force
 *   - same grade, sync-sourced   → no-op (don't bump gradeSetAt)
 *   - otherwise                  → overwrite with setBy="timeback-sync"
 *
 * Returns per-row outcomes so the admin UI can show what changed.
 */
export async function bulkSetWorkingGrades(updates, opts = {}) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const force = !!opts.force;
  const rows = [];
  let applied = 0;
  let skippedAdmin = 0;
  let skippedSame = 0;
  let skippedNotUser = 0;
  let errors = 0;

  for (const u of updates) {
    const email = String(u.email || "").trim().toLowerCase();
    const grade = String(u.grade || "").trim();
    // ageGrade is optional — the physical age grade, separate from
    // working/reading grade. Used by api/quiz.js to calibrate question
    // MATURITY (tone, distractor framing) while difficulty stays keyed
    // to working grade. Coming from TimeBack rpt2_mastery.age_grade_level.
    const ageGrade = u.ageGrade != null ? String(u.ageGrade).trim() : null;
    if (!email || !grade) {
      errors++;
      rows.push({ email, grade, status: "error", reason: "missing_fields" });
      continue;
    }
    try {
      const existing = await r.hget("users", email);
      let prev = null;
      if (existing) {
        try {
          prev =
            typeof existing === "string" ? JSON.parse(existing) : existing;
        } catch {
          prev = null;
        }
      }

      // No profile yet → student has never signed in. Skip silently so we
      // don't fill Redis with TimeBack-only roster data.
      if (!prev) {
        skippedNotUser++;
        rows.push({ email, grade, status: "skipped_not_user" });
        continue;
      }

      const prevGrade = prev?.grade || null;
      const prevSetBy = prev?.gradeSetBy || null;

      if (prevSetBy === "admin" && !force) {
        skippedAdmin++;
        rows.push({
          email,
          grade,
          status: "skipped_admin",
          prevGrade,
          prevSetBy,
        });
        continue;
      }
      // Same grade AND same ageGrade AND sync-sourced → no-op.
      const prevAgeGrade = prev?.ageGrade ?? null;
      const ageGradeUnchanged =
        ageGrade == null || String(prevAgeGrade) === String(ageGrade);
      if (prevGrade === grade && prevSetBy === "timeback-sync" && ageGradeUnchanged) {
        skippedSame++;
        rows.push({ email, grade, status: "no_change", prevGrade, prevSetBy });
        continue;
      }
      const patch = {
        grade,
        gradeSetAt: Date.now(),
        gradeSetBy: "timeback-sync",
      };
      // Only write ageGrade when the caller passed it (TimeBack rows have
      // it; admin paste rows don't, and we don't want to wipe a value).
      if (ageGrade != null && ageGrade !== "") patch.ageGrade = ageGrade;
      await mergeUserProfile(r, email, patch);
      applied++;
      rows.push({ email, grade, status: "applied", prevGrade, prevSetBy });
    } catch (err) {
      errors++;
      rows.push({
        email,
        grade,
        status: "error",
        reason: String(err?.message || err),
      });
    }
  }

  return {
    ok: true,
    applied,
    skippedAdmin,
    skippedSame,
    skippedNotUser,
    errors,
    rows,
  };
}

/* ---------- Quiz question reports ---------- */

// A kid (or anyone authenticated) flags a quiz question as bad. The report
// goes into a Redis hash keyed by a fresh ID so admins can list / resolve.
export async function saveQuizReport(report) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    const id =
      "rep_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8);
    const payload = JSON.stringify({ id, ...report, ts: Date.now() });
    await r.hset("quiz:reports:pending", { [id]: payload });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

export async function listQuizReports({ limit = 100 } = {}) {
  const r = redis();
  if (!r) return { reports: [], hasRedis: false };
  try {
    const all = (await r.hgetall("quiz:reports:pending")) || {};
    const reports = Object.values(all)
      .map((raw) => {
        try {
          return typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit);
    return { reports, hasRedis: true };
  } catch (err) {
    return { reports: [], hasRedis: true, error: String(err) };
  }
}

export async function deleteQuizReport(id) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    await r.hdel("quiz:reports:pending", id);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

/* ---------- Quiz fraud detection (1d.3) ---------- */

// If the last quiz was this long ago or longer, skip speed-check
// (student probably started a fresh session / came back next day).
const FRAUD_FRESHNESS_MS = 8 * 60 * 60 * 1000; // 8 hours

// Suspicion thresholds (ratio = elapsed / minExpected)
export const FRAUD_RATIO_HOLD = 0.25;   // < this → hold XP, flag
export const FRAUD_RATIO_SOFT = 0.5;    // < this → award 50% XP (soft flag)
export const FRAUD_FRESHNESS_WINDOW_MS = FRAUD_FRESHNESS_MS;

// First-open fairness gate (soft version of "did they have time to read?").
// If a student opened the book in the app < this many hours ago and is
// already submitting a quiz, it's physically suspicious — they can't have
// ordered/received a copy that fast. We don't FORCE the gate (kids might
// already have the book at home and only just discovered it in the app),
// we just feed it into the same soft/hold matrix as the WCPM speed check.
//
// Tunable; 6 h is the rough "earliest plausible same-day reading window."
// Will be replaced by a hard order-aware gate once we own the Amazon account.
export const FIRST_OPEN_SUSPICION_HOURS = 6;
// Hard floor between clicking "I'm reading this" and submitting a quiz.
// Under this gap → automatic hold for admin review (no exceptions: even an
// emergent-reader 140-word book benefits from sitting with the questions
// rather than smashing through them seconds after marking it as reading).
// This was the gap that let Andy Montgomery's guess-and-win slip past:
// firstOpenAt was hours old → first-open check passed; no prior quiz this
// session → WCPM check skipped; click "I'm reading", click "Quiz" 30s later.
export const STARTED_RECENTLY_HOLD_MS = 60 * 60 * 1000; // 1 hour

/* ---------- Reading session state (#9 atomic quiz+retell) ---------- */
//
// A reading session links a quiz attempt to its mandatory follow-up
// retell so XP awards atomically once both halves complete. Without
// this, quiz_submit would award XP immediately and the kid could close
// before the retell ever ran — violating the "complete the whole
// section" rule.
//
// Lifecycle:
//   1. /api/activity quiz_submit creates the session with quizOutcome
//   2. Client launches retell modal
//   3. /api/tutor start associates the existing session id
//   4. /api/tutor turn (final) reads quiz outcome, computes combined XP,
//      awards via recordRead, clears session
//   5. If kid never starts retell within TTL → session expires, no XP
//
// Storage: per (email, bookId) hash, replaces any prior in-flight
// session for the same book. TTL 30 min — long enough for a kid to
// take a break, short enough that stale state self-cleans.

const READING_SESSION_TTL_SEC = 30 * 60;

function readingSessionKey(email, bookId) {
  return `readsess:${String(email).toLowerCase()}:${bookId}`;
}

export async function setReadingSessionQuizOutcome({
  email,
  bookId,
  quizOutcome,      // "p1" | "p2" | "fF"
  quizAttempt,      // 1 | 2
  ts = Date.now(),
}) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const key = readingSessionKey(email, bookId);
  const payload = {
    bookId,
    quizOutcome,
    quizAttempt,
    quizSubmittedAt: ts,
    retellOutcome: null,
    retellAttempt: null,
    awarded: false,
  };
  try {
    await r.set(key, JSON.stringify(payload));
    await r.expire(key, READING_SESSION_TTL_SEC);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

export async function getReadingSession(email, bookId) {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.get(readingSessionKey(email, bookId));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function clearReadingSession(email, bookId) {
  const r = redis();
  if (!r) return;
  try { await r.del(readingSessionKey(email, bookId)); } catch {}
}

export async function getQuizFraudState(email) {
  const r = redis();
  const e = String(email).toLowerCase();
  const empty = { lastQuizAt: null, flagCount: 0, cooldownUntil: null };
  if (!r) return empty;
  try {
    const [lastQuizAt, flagCount, cooldownUntil] = await Promise.all([
      r.get(`user:${e}:lastQuizAt`),
      r.get(`user:${e}:flagCount`),
      r.get(`user:${e}:cooldownUntil`),
    ]);
    return {
      lastQuizAt:    lastQuizAt    ? Number(lastQuizAt)    : null,
      flagCount:     flagCount     ? Number(flagCount)     : 0,
      cooldownUntil: cooldownUntil ? Number(cooldownUntil) : null,
    };
  } catch {
    return empty;
  }
}

// Update just the timestamp (called after every accepted quiz submission).
export async function setLastQuizAt(email, ts) {
  const r = redis();
  if (!r) return;
  const e = String(email).toLowerCase();
  try {
    await r.set(`user:${e}:lastQuizAt`, String(ts ?? Date.now()));
  } catch {}
}

/* ---------- First-open tracking (1d.3 fairness gate) ---------- */
//
// The earliest moment we can be certain a student became aware of a book
// is the first time they opened its detail modal in Reading Spine. Before
// that, they might have already owned the book from home/library — we
// can't know. After that, every subsequent action (read claim, quiz pass)
// can be measured against this timestamp.
//
// Stored per (email, bookId) as a server timestamp. SETNX semantics —
// only the FIRST open writes; later opens are ignored so the floor never
// shifts. Trusting only the server time also avoids client-clock tricks.

const FIRST_OPEN_TTL_DAYS = 365;

/** Record the first time this student opened this book in the app.
 *  No-op if a record already exists. Returns the timestamp on file. */
export async function recordFirstOpen(email, bookId, now = Date.now()) {
  const r = redis();
  if (!r) return null;
  const e = String(email).toLowerCase();
  const key = `firstopen:${e}:${bookId}`;
  try {
    // setnx: only set if absent. The Upstash REST client accepts the `nx`
    // option on .set; mirror Redis behaviour either way by checking after.
    await r.set(key, String(now), { nx: true, ex: FIRST_OPEN_TTL_DAYS * 86400 });
    const stored = await r.get(key);
    return stored ? Number(stored) : now;
  } catch {
    return null;
  }
}

/** Read the stored first-open timestamp, or null if never recorded. */
export async function getFirstOpenAt(email, bookId) {
  const r = redis();
  if (!r) return null;
  try {
    const v = await r.get(
      `firstopen:${String(email).toLowerCase()}:${bookId}`
    );
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

/* ---------- Per-book quiz attempt counter (#40) ---------- */
//
// Closes the localStorage-wipe + infinite-retake exploit. Previously the
// client supplied `attemptNum` from its local state, so a kid could clear
// localStorage between failed attempts and reset to attemptNum=1 (= full XP
// path, no retake multiplier). We now keep authoritative attempt counts
// per (email, bookId) on the server with a 72h TTL — enough to span a
// weekend retry window but short enough that next week the kid gets a
// fresh attempt budget.
//
// 2 attempts per (email, bookId) per rolling 72h window. After that we
// 429 and tell them to come back tomorrow. (Pairs with the SADD dedupe
// in recordRead: even if they somehow bypass this, the book set blocks
// double-XP.)

/** Max attempts per book — PERMANENT, no daily reset.
 *  If a kid fails both attempts, they don't get to take that quiz
 *  again (unless an admin resets them via reset-my-book). Reflects
 *  the "the quiz stays meaningful" design intent — daily reset would
 *  encourage repeated guess-and-check.
 */
export const QUIZ_DAILY_ATTEMPT_LIMIT = 2;
// 1-year TTL — effectively permanent for the summer-reading window.
// We don't use r.persist() to avoid orphan keys lingering forever
// if a student account is deleted; 365 days is a sane upper bound
// and matches the FIRST_OPEN_TTL_DAYS convention elsewhere in this file.
const QUIZ_ATTEMPT_TTL_SEC = 365 * 24 * 60 * 60;

/** Increment the attempt counter and return the resulting count.
 *  Returns 1 on first attempt, 2 on second, etc. If Redis is down,
 *  returns null so the caller can fall back to the client-supplied number. */
export async function recordQuizAttempt(email, bookId) {
  const r = redis();
  if (!r) return null;
  const key = `quizattempts:${String(email).toLowerCase()}:${bookId}`;
  try {
    const count = await r.incr(key);
    // Only set the TTL on the first attempt — subsequent INCRs preserve
    // the original expiry so a kid can't extend their window by retrying.
    if (count === 1) {
      await r.expire(key, QUIZ_ATTEMPT_TTL_SEC);
    }
    return Number(count) || null;
  } catch {
    return null;
  }
}

/** Read the current attempt count without incrementing (admin / debug use). */
export async function getQuizAttemptCount(email, bookId) {
  const r = redis();
  if (!r) return 0;
  try {
    const v = await r.get(`quizattempts:${String(email).toLowerCase()}:${bookId}`);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

/* ---------- Quiz-open tracking (#41) ---------- */
//
// Closes the peek-and-close exploit: kid opens the quiz, sees the questions
// (or the whole cached pool via DevTools), closes without submitting, looks
// up the answers, then comes back. We can't stop them looking things up,
// but we CAN count quiz opens between submissions — multiple opens before
// a submit is a soft signal that feeds the fraud matrix.
//
// Storage: Redis HASH per (email, bookId) with two fields:
//   firstAt — server timestamp of the FIRST open since last submit
//   count   — total opens since last submit
// TTL 24h so it self-cleans for legitimate kids who got distracted.
// Cleared (DEL) on every quiz_submit so the next attempt starts fresh.

const QUIZ_OPEN_TTL_SEC = 24 * 60 * 60;

/** Record a quiz open. Increments count, sets firstAt on the first open. */
export async function recordQuizOpen(email, bookId, now = Date.now()) {
  const r = redis();
  if (!r) return;
  const key = `quizopen:${String(email).toLowerCase()}:${bookId}`;
  try {
    const count = await r.hincrby(key, "count", 1);
    if (Number(count) === 1) {
      await r.hset(key, { firstAt: String(now) });
      await r.expire(key, QUIZ_OPEN_TTL_SEC);
    }
  } catch {
    /* non-fatal — fraud signal degrades gracefully if Redis is unavailable */
  }
}

/** Read the open state and CLEAR it (so the next attempt starts fresh).
 *  Returns { count, firstAt } where count is the number of opens since
 *  the last submit. count=0 means "kid never opened /api/quiz this session"
 *  — suspicious in its own way (e.g., posting straight to /api/activity). */
export async function consumeQuizOpens(email, bookId) {
  const r = redis();
  if (!r) return { count: 0, firstAt: null };
  const key = `quizopen:${String(email).toLowerCase()}:${bookId}`;
  try {
    const raw = await r.hgetall(key);
    await r.del(key);
    return {
      count: Number(raw?.count) || 0,
      firstAt: raw?.firstAt ? Number(raw.firstAt) : null,
    };
  } catch {
    return { count: 0, firstAt: null };
  }
}

/* ---------- Achievements (#24) ---------- */
//
// Each user has a Redis HASH `user:{email}:achievements` keyed by
// achievement id, value = epoch-ms timestamp of unlock. We never delete
// entries — once earned, always earned. Newly-earned achievements are
// returned to the client so it can fire a toast.

import { BOOK_TAGS, BOOKS } from "./books.js";
import { evaluateAll, ACHIEVEMENT_BY_ID } from "./achievements.js";

export async function getAchievements(email) {
  const r = redis();
  if (!r) return {};
  try {
    const map = await r.hgetall(`user:${String(email).toLowerCase()}:achievements`);
    return map || {};
  } catch {
    return {};
  }
}

/**
 * Build the evaluation context for a user from current Redis state.
 * `extra.justRead = { bookId }` is folded in for achievements that fire
 * on a specific read event (e.g., Beginner's Mind, Reaching Higher).
 */
async function buildAchievementCtx(email, profile, extra = {}) {
  const r = redis();
  const e = String(email).toLowerCase();
  const ctx = {
    booksReadCount: 0,
    xpTotal: 0,
    genresRead: new Set(),
    maxWordCount: 0,
    // Total words across every book this kid has finished. Used by the
    // 📜 word-count ladder (replaces the streak ladder so kids reading
    // longer books aren't penalized for finishing fewer of them).
    totalWordsRead: 0,
    // seriesCounts: { "elephant_piggie": 3, "frog_toad": 1, ... }
    // Used by series-completion achievements (#34 follow-up). A book
    // contributes when BOOKS[id].series is set.
    seriesCounts: {},
    tourCompleted: !!profile?.tourCompleted,
    readBookIds: [],
    workingGrade: profile?.grade || null,
    // The grade locked when the user first appeared in the system. Used
    // by the stretch-ladder achievements (Stepping Up / Reaching Higher /
    // Climbing the Mountain) so growth doesn't move the goalposts: a kid
    // who joined at K and reads a Grade 2 book always earns Climbing the
    // Mountain, even after they themselves graduate to Grade 1 or 2.
    // Falls back to workingGrade when missing so older accounts still
    // evaluate sensibly.
    initialGrade: profile?.initialGrade || profile?.grade || null,
    justRead: null,
  };
  if (!r) return ctx;

  try {
    const [count, xp, members] = await Promise.all([
      r.scard(`user:${e}:books`).catch(() => 0),
      r.zscore("lb:points:all", e).catch(() => 0),
      r.smembers(`user:${e}:books`).catch(() => []),
    ]);
    ctx.booksReadCount = Number(count) || 0;
    ctx.xpTotal = Number(xp) || 0;
    ctx.readBookIds = members || [];
    for (const id of ctx.readBookIds) {
      for (const tag of BOOK_TAGS[id] || []) ctx.genresRead.add(tag);
      const book = BOOKS[id];
      const wc = book?.wordCount || 0;
      ctx.totalWordsRead += wc;
      if (wc > ctx.maxWordCount) ctx.maxWordCount = wc;
      const series = book?.series;
      if (series) ctx.seriesCounts[series] = (ctx.seriesCounts[series] || 0) + 1;
    }
  } catch {}

  // streakDays comes from the client (state.data.streakDays — derived from
  // localStorage). The server doesn't track this independently yet, so the
  // caller passes it in via extra.streakDays.
  if (typeof extra.streakDays === "number") ctx.streakDays = extra.streakDays;

  if (extra.justRead) {
    const book = BOOKS[extra.justRead.bookId];
    if (book) {
      ctx.justRead = {
        bookId: extra.justRead.bookId,
        grade: book.grade,
        wordCount: book.wordCount,
        isEmergent: book.quizStyle === "emergent",
      };
    }
  }

  return ctx;
}

/**
 * Evaluate all achievements for a user and persist any newly-unlocked ones.
 * Returns the array of newly-unlocked achievement ids (caller forwards to
 * the client so it can toast each one).
 *
 * Cheap: O(N) over the achievement list, one Redis hash read + one hash
 * write per unlock. Safe to call after every recordRead.
 */
export async function evaluateAchievementsForUser(email, profile, extra = {}) {
  const r = redis();
  if (!r) return [];
  const e = String(email).toLowerCase();
  const key = `user:${e}:achievements`;
  try {
    const existing = (await r.hgetall(key)) || {};
    const ctx = await buildAchievementCtx(email, profile, extra);
    const passing = evaluateAll(ctx);
    const newly = passing.filter((id) => !existing[id]);
    if (newly.length > 0) {
      const now = Date.now();
      const patch = {};
      for (const id of newly) patch[id] = String(now);
      await r.hset(key, patch);
    }
    return newly.map((id) => ({
      id,
      name: ACHIEVEMENT_BY_ID[id]?.name,
      icon: ACHIEVEMENT_BY_ID[id]?.icon,
      desc: ACHIEVEMENT_BY_ID[id]?.desc,
    }));
  } catch {
    return [];
  }
}

/* ---------- Currently-reading tracker (#16) ---------- */
//
// One book in progress at a time per student. When they click "I'm reading
// this" we stamp { bookId, startedAt } here. A quiz pass for the same book
// clears it. Starting a new book replaces the existing one (the client
// prompts to confirm the swap).
//
// Used by:
//   - Stats strip (shows "Now reading: X — day 3 of ~6")
//   - Engagement leading indicator (no currentlyReading + no quiz attempts
//     in 14 days = engagement failure)
//   - Per-book stall alarm (past expected reading window + no quiz attempts
//     = stuck on this specific book)
const CURRENTLY_READING_TTL_DAYS = 365;

export async function setCurrentlyReading(email, bookId, now = Date.now()) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const e = String(email).toLowerCase();
  try {
    const payload = JSON.stringify({ bookId, startedAt: now });
    await r.set(`reading:${e}`, payload, {
      ex: CURRENTLY_READING_TTL_DAYS * 86400,
    });
    return { ok: true, bookId, startedAt: now };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

export async function getCurrentlyReading(email) {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.get(`reading:${String(email).toLowerCase()}`);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function clearCurrentlyReading(email) {
  const r = redis();
  if (!r) return;
  try {
    await r.del(`reading:${String(email).toLowerCase()}`);
  } catch {}
}

// Increment flagCount, compute escalating cooldown, store both.
// Cooldown ladder: 1st → 2 h, 2nd → 8 h, 3rd → 24 h, 4th+ → 72 h.
// Returns { flagCount, cooldownUntil }.
export async function applyFraudFlag(email) {
  const r = redis();
  const e = String(email).toLowerCase();
  const fallback = { flagCount: 1, cooldownUntil: Date.now() + 2 * 3600_000 };
  if (!r) return fallback;
  try {
    const newCount = await r.incr(`user:${e}:flagCount`);
    const hours = newCount === 1 ? 2 : newCount === 2 ? 8 : newCount === 3 ? 24 : 72;
    const cooldownUntil = Date.now() + hours * 3600_000;
    await r.set(`user:${e}:cooldownUntil`, String(cooldownUntil));
    return { flagCount: newCount, cooldownUntil };
  } catch {
    return fallback;
  }
}

// Reset a student's fraud flag count and clear any active cooldown.
// Used by admins from the held-XP review UI.
export async function resetFraudFlags(email) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  const e = String(email).toLowerCase();
  try {
    await r.del(`user:${e}:flagCount`, `user:${e}:cooldownUntil`);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err) };
  }
}

/* ---------- Comment moderation (task #31) ----------
 * Three-tier classification (block/review/allow) lives in
 * lib/moderation.js. Server-side queue here:
 *   comments:pending  Redis hash → admin review queue
 *   comments:audit    Redis list → recent allow+block events (last 500)
 *
 * Comments themselves are currently localStorage-only on the client.
 * When socialized (separate task), we'd add comments:approved:{bookId}
 * lists keyed by bookId so other kids can see them.
 */

// #52 — held-comment retention policy. Entries older than this are
// purged on every list call (lazy sweep — no cron required). 60 days
// is generous enough that a teacher returning from summer break still
// sees what flagged. Tunable here if policy changes.
const HELD_COMMENT_TTL_MS = 60 * 24 * 60 * 60 * 1000;

/** Push a "review" verdict comment into the admin queue.
 *  #52 — `email` is replaced by `emailHash` (one-way HMAC of the email
 *  using AUTH_SECRET). Raw email never lands in this hash. Repeat-
 *  offender grouping is still possible because the hash is
 *  deterministic. */
export async function holdComment(entry) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    const id =
      "cmt_" + Date.now().toString(36) + "_" +
      Math.random().toString(36).slice(2, 7);
    // Hash the email, drop the raw. Lazy-import to avoid a circular
    // dep between store.js and session.js at top-level.
    const { emailHash } = await import("./session.js");
    const hash = await emailHash(entry.email);
    const safe = { ...entry, emailHash: hash };
    delete safe.email;
    const payload = JSON.stringify({ id, ...safe, ts: Date.now() });
    await r.hset("comments:pending", { [id]: payload });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

/** List pending comments for admin review, newest first.
 *  #52 — entries older than HELD_COMMENT_TTL_MS are dropped from the
 *  hash here (lazy sweep). Each call cleans up; admins never see a
 *  stale queue, and we don't need a separate cron. */
export async function listPendingComments({ limit = 100 } = {}) {
  const r = redis();
  if (!r) return { entries: [], hasRedis: false };
  try {
    const all = (await r.hgetall("comments:pending")) || {};
    const cutoff = Date.now() - HELD_COMMENT_TTL_MS;
    const expiredIds = [];
    const parsed = Object.entries(all)
      .map(([id, raw]) => {
        try {
          const e = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (!e?.ts || e.ts < cutoff) {
            expiredIds.push(id);
            return null;
          }
          return e;
        } catch {
          expiredIds.push(id); // unparseable — sweep it
          return null;
        }
      })
      .filter(Boolean);
    // Fire-and-forget purge of expired entries.
    if (expiredIds.length) {
      try { await r.hdel("comments:pending", ...expiredIds); } catch {}
    }
    const entries = parsed
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit);
    return { entries, hasRedis: true, purged: expiredIds.length };
  } catch (err) {
    return { entries: [], hasRedis: true, error: String(err) };
  }
}

/** Admin: approve (allow the comment to publish — placeholder for the
 *  social-comments future) or reject (discard) a held comment. */
export async function resolvePendingComment(id, action) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    const raw = await r.hget("comments:pending", id);
    if (!raw) return { ok: false, reason: "not_found" };
    const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
    await r.hdel("comments:pending", id);
    // For now, "approve" just removes from queue (comments display is
    // client-local). When comments go social, add the entry to
    // comments:approved:{bookId} here so other kids can see them.
    return { ok: true, entry, action };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

// Store a held-XP entry in the `heldxp:pending` Redis hash so admins can
// review it. Returns { ok, id }.
export async function addHeldXpEntry(entry) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    const id =
      "held_" +
      Date.now().toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 7);
    const payload = JSON.stringify({ id, ...entry, ts: Date.now() });
    await r.hset("heldxp:pending", { [id]: payload });
    return { ok: true, id };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

// List all pending held-XP entries (admin view), newest first.
export async function listHeldXp({ limit = 100 } = {}) {
  const r = redis();
  if (!r) return { entries: [], hasRedis: false };
  try {
    const all = (await r.hgetall("heldxp:pending")) || {};
    const entries = Object.values(all)
      .map((raw) => {
        try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, limit);
    return { entries, hasRedis: true };
  } catch (err) {
    return { entries: [], hasRedis: true, error: String(err) };
  }
}

// Admin: approve (award withheld points) or reject (discard) a held-XP entry.
export async function resolveHeldXp(heldId, action) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  try {
    const raw = await r.hget("heldxp:pending", heldId);
    if (!raw) return { ok: false, reason: "not_found" };
    const entry = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (action === "approve" && entry.points > 0) {
      await awardPointsOnly(entry.email, entry.points, entry.grade);
    }
    await r.hdel("heldxp:pending", heldId);
    return { ok: true, entry };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

/**
 * Retroactively move an already-awarded read into the held-XP queue.
 * Inverse of recordRead's leaderboard updates — does NOT touch
 * `user:{email}:books` (the kid still finished the quiz; we just don't
 * want the XP counted yet). After this, admin reviews the held entry and
 * either approves (re-credits via awardPointsOnly) or rejects (discards).
 *
 * Used when a quiz that should have been flagged slipped through the
 * detector (e.g., guessed past an emergent quiz before this fix shipped).
 */
export async function unawardAndHold({
  email, name, grade, bookId, bookTitle, points, reason,
}) {
  const r = redis();
  if (!r) return { ok: false, reason: "no_redis" };
  if (!(points > 0)) return { ok: false, reason: "no_points" };
  const e = String(email).toLowerCase();
  const week = currentIsoWeek();
  try {
    const p = r.pipeline();
    p.zincrby("lb:points:all", -points, e);
    p.zincrby(`lb:points:week:${week}`, -points, e);
    if (grade) p.zincrby(`lb:points:grade:${grade}`, -points, e);
    await p.exec();
    const held = await addHeldXpEntry({
      email: e,
      name: name || e.split("@")[0],
      bookId,
      bookTitle: bookTitle || bookId,
      grade,
      points,
      reason: reason || "retroactive_review",
    });
    return { ok: true, heldId: held.id || null, points };
  } catch (err) {
    return { ok: false, reason: "redis_error", error: String(err) };
  }
}

// Add points directly to the leaderboard sorted sets without the
// unique-read dedup check that recordRead() performs. Used when admin
// approves a held-XP entry after manual review.
export async function awardPointsOnly(email, points, grade) {
  const r = redis();
  if (!r || !(points > 0)) return;
  const e = String(email).toLowerCase();
  const week = currentIsoWeek();
  const p = r.pipeline();
  p.zincrby("lb:points:all", points, e);
  p.zincrby(`lb:points:week:${week}`, points, e);
  if (grade) p.zincrby(`lb:points:grade:${grade}`, points, e);
  await p.exec();
}
