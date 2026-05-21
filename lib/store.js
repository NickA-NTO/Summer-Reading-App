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

// Record that `email` finished `bookId`. Idempotent — if the same book is
// recorded again, the leaderboard is NOT double-incremented. Returns true if
// this was a new read, false if it was already recorded.
export async function recordRead({ email, name, grade, bookId }) {
  const r = redis();
  if (!r) return { recorded: false, reason: "no_redis" };

  const e = String(email).toLowerCase();
  try {
    // SADD returns 1 if added, 0 if already in the set
    const added = await r.sadd(`user:${e}:books`, bookId);
    if (added === 0) {
      return { recorded: false, reason: "already_read" };
    }

    // Merge name/grade into the profile (don't clobber other fields)
    await mergeUserProfile(r, e, {
      name: name || e.split("@")[0],
      grade: grade || null,
      lastReadAt: Date.now(),
    });

    const week = currentIsoWeek();
    const p = r.pipeline();
    p.zincrby("lb:reads:all", 1, e);
    p.zincrby(`lb:reads:week:${week}`, 1, e);
    if (grade) p.zincrby(`lb:reads:grade:${grade}`, 1, e);
    await p.exec();

    return { recorded: true };
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

    // Pull read counts for each user in parallel
    const counts = await Promise.all(
      emails.map((e) => r.scard(`user:${e}:books`).catch(() => 0))
    );

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
        loginCount: prof.loginCount || 0,
        firstLoginAt: prof.firstLoginAt || null,
        lastLoginAt: prof.lastLoginAt || null,
        lastReadAt: prof.lastReadAt || null,
        booksRead: counts[i] || 0,
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

// Returns { entries: [{email, name, grade, count, isYou}], me: {count, rank} }
export async function getLeaderboard({
  window = "all",
  limit = 25,
  viewerEmail = null,
} = {}) {
  const r = redis();
  if (!r) {
    return { entries: [], me: { count: 0, rank: null }, hasRedis: false };
  }
  const key =
    window === "week" ? `lb:reads:week:${currentIsoWeek()}` : "lb:reads:all";

  let raw;
  try {
    raw = await r.zrange(key, 0, limit - 1, { rev: true, withScores: true });
  } catch {
    return { entries: [], me: { count: 0, rank: null }, hasRedis: true };
  }

  // @upstash/redis returns flat [member, score, member, score, ...]
  const entries = [];
  for (let i = 0; i < raw.length; i += 2) {
    entries.push({ email: String(raw[i]), count: Number(raw[i + 1]) });
  }

  let profiles = [];
  if (entries.length) {
    try {
      profiles = await r.hmget("users", ...entries.map((e) => e.email));
    } catch {
      profiles = entries.map(() => null);
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
      count: e.count,
      isYou: e.email.toLowerCase() === viewer,
    };
  });

  // Viewer's stats (count + global rank)
  let me = { count: 0, rank: null };
  if (viewer) {
    try {
      const [count, rank] = await Promise.all([
        r.scard(`user:${viewer}:books`),
        r.zrevrank("lb:reads:all", viewer),
      ]);
      me = { count: count || 0, rank: rank != null ? rank + 1 : null };
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

// Best-effort grade inference from an email (we'd want a real attribute long-term).
// Heuristic: look for "k", "1st", "g1", "grade-2" etc. in the local-part.
export function guessGradeFromEmail(email) {
  const local = String(email || "").toLowerCase().split("@")[0];
  if (/(^|[^a-z])k(\d|$)/.test(local) || /kinder/.test(local)) return "K";
  if (/(^|[^a-z])(1st|g1|grade-?1)([^a-z]|$)/.test(local)) return "1";
  if (/(^|[^a-z])(2nd|g2|grade-?2)([^a-z]|$)/.test(local)) return "2";
  return null;
}
