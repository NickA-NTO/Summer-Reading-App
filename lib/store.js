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
  _client = new Redis({ url, token });
  return _client;
}

export function hasRedis() {
  return !!redis();
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
export async function bustQuizCache(bookId) {
  const r = redis();
  if (!r) return 0;
  try {
    // Scan for all keys matching the v5 cache prefix for this book
    const pattern = `quiz:v5:${bookId}:*`;
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

  const viewer = (viewerEmail || "").toLowerCase();
  const decorated = entries.map((e, i) => {
    let prof = {};
    try {
      prof = profiles[i] ? JSON.parse(profiles[i]) : {};
    } catch {}
    return {
      name: maskName(prof.name) || maskName(e.email.split("@")[0]),
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
      const wc = BOOKS[id]?.wordCount || 0;
      ctx.totalWordsRead += wc;
      if (wc > ctx.maxWordCount) ctx.maxWordCount = wc;
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
