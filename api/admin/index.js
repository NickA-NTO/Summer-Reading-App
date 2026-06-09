// Admin endpoint router — dispatches on ?action=... so all admin features
// live in a single serverless function. Consolidated because Vercel's Hobby
// tier caps us at 12 functions; splitting per-endpoint blew the limit.
//
// Routes (all require admin session):
//   GET  /api/admin?action=users          → list all users
//   GET  /api/admin?action=tts-usage      → TTS usage + Polly status
//   GET  /api/admin?action=quiz-reports   → list pending flagged questions
//   POST /api/admin?action=quiz-reports   → confirm | dismiss a report
//                                            (body: { id, action })
//   GET  /api/admin?action=held-xp        → list pending held-XP entries
//   POST /api/admin?action=held-xp        → approve | reject | reset_flags
//                                            (body: { id, action } or
//                                                   { action: "reset_flags", email })
//   POST /api/admin?action=set-grade      → set student's working grade
//                                            (body: { email, grade })

import { verifySession, parseCookies, isAdmin } from "../../lib/session.js";
import {
  listAllUsers,
  getTtsUsage,
  listQuizReports,
  deleteQuizReport,
  bustQuizCache,
  listHeldXp,
  resolveHeldXp,
  resetFraudFlags,
  setUserWorkingGrade,
  setUserAgeGrade,
  bulkSetWorkingGrades,
  setTrackOverrides,
  clearReadingSession,
  clearCurrentlyReading,
  redis,
  getCurrentlyReading,
  getQuizFraudState,
  getFirstOpenAt,
  unawardAndHold,
} from "../../lib/store.js";
import { sanitizeTrackOverrides, TRACK_ORDER } from "../../lib/tracks.js";
import { getStats as getObsStats } from "../../lib/observability.js";
import { syncWorkingGradesFromTimeBack, TIMEBACK_SYNC_ENDPOINT } from "../../lib/timeback-sync.js";
import { listPendingComments, resolvePendingComment } from "../../lib/store.js";
import {
  APP_CAP_CHARS,
  APP_CAP_USD,
  COST_PER_CHAR,
  hasPolly,
} from "../../lib/tts.js";
import { normalizeGrade } from "../../lib/xp.js";
import { buildQuizEventEnvelope } from "../../lib/caliper.js";
import {
  postCaliperEnvelope,
  getCaliperHealthSnapshot,
  drainCaliperRetryQueue,
} from "../../lib/timeback.js";

const ALLOWED_GRADES = new Set([
  "PK",
  "K",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "11",
  "12",
]);

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(body));
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null; // signal parse error
  }
}

export default async function handler(req, res) {
  // -------- Auth --------
  // Two paths in:
  //   1. Admin user via web UI — session cookie + isAdmin check
  //   2. Vercel cron (timeback-sync, future caliper-drain) — Authorization
  //      header with CRON_SECRET. Cron requests have no session cookie.
  //
  // The cron path is gated to a fixed allowlist of actions so a leaked
  // CRON_SECRET can't impersonate an admin for the destructive endpoints
  // (set-grade, hold-existing-read, etc.).
  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = String(url.searchParams.get("action") || "").toLowerCase();

  const CRON_ALLOWED_ACTIONS = new Set([
    "timeback-sync",
    "caliper-drain-retry",
  ]);
  const cronHeader = String(req.headers.authorization || "");
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall =
    !!cronSecret &&
    cronHeader === `Bearer ${cronSecret}` &&
    CRON_ALLOWED_ACTIONS.has(action);

  // Authed user's email — exposed for endpoints that need to act on
  // the calling admin's own account (e.g., reset-my-book). Null for
  // cron calls. Declared at handler scope so per-action code can use it.
  let authedEmail = null;
  if (!isCronCall) {
    const secret = process.env.AUTH_SECRET;
    const cookies = parseCookies(req.headers.cookie);
    const session = await verifySession(cookies.rs_session, secret);
    if (!session) return json(res, 401, { error: "unauthenticated" });
    if (!isAdmin(session.email)) return json(res, 403, { error: "forbidden" });
    authedEmail = session.email;
    // #19 audit follow-up: cap admin route abuse. A compromised admin
    // token shouldn't be able to pound cache-bust / timeback-sync /
    // user-diag in a tight loop. Cron path is exempt — it hits with
    // a bearer token, not a session cookie.
    const { checkRateLimit, send429, LIMITS } = await import("../../lib/rate-limit.js");
    const rl = await checkRateLimit({
      email: session.email, bucket: "admin",
      max: LIMITS.admin.max, windowSec: LIMITS.admin.windowSec,
    });
    if (!rl.ok) {
      send429(res, rl);
      return;
    }
  }

  // ============================ users ============================
  if (action === "users" && req.method === "GET") {
    const { users, hasRedis, error } = await listAllUsers();
    return json(res, 200, {
      hasRedis,
      error: error || null,
      count: users.length,
      users,
    });
  }

  // ========================= timeback-sync =======================
  // Pull working grades from TimeBack reporting and bulk-apply to user
  // profiles. Two callers:
  //   1. Vercel cron job (vercel.json — runs daily at 06:00 UTC)
  //   2. Admin panel "Sync now" button (POST from the UI)
  //
  // The cron-auth path is gated by Authorization: Bearer ${CRON_SECRET};
  // admin auth uses the normal session cookie. Force-overwrite admin-set
  // grades only when ?force=1 is passed (admin-only — cron never forces).
  if (action === "timeback-sync") {
    const force = url.searchParams.get("force") === "1" && !isCronCall;
    const result = await syncWorkingGradesFromTimeBack({ force });
    return json(res, result.ok ? 200 : 500, {
      ...result,
      endpoint: TIMEBACK_SYNC_ENDPOINT,
      triggeredBy: isCronCall ? "cron" : "admin",
    });
  }

  // ====================== comments-pending =======================
  // Held-comment admin queue (task #31). GET returns the list; POST
  // takes { id, action: "approve" | "reject" } to resolve one entry.
  if (action === "comments-pending" && req.method === "GET") {
    const result = await listPendingComments({ limit: 200 });
    return json(res, 200, result);
  }
  if (action === "comments-pending" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const id = String(body.id || "");
    const a = String(body.action || "").toLowerCase();
    if (!id || !["approve", "reject"].includes(a)) {
      return json(res, 400, { error: "invalid_request" });
    }
    const result = await resolvePendingComment(id, a);
    return json(res, result.ok ? 200 : 404, result);
  }

  // ========================= obs-stats ===========================
  // 7-day rollup of error + event counters. Companion to /api/health.
  // GET /api/admin?action=obs-stats[&days=N]
  if (action === "obs-stats" && req.method === "GET") {
    const days = Math.min(30, Math.max(1, Number(url.searchParams.get("days")) || 7));
    const stats = await getObsStats(days);
    return json(res, 200, stats);
  }

  // ========================= env-check ===========================
  // Diagnostic — surface the auth-relevant env-var values that production
  // is actually reading. Admin-only; no secrets returned, only presence
  // flags + the parsed domain whitelist (which isn't sensitive). Use to
  // verify Vercel env-var changes actually landed in the running deploy.
  if (action === "env-check" && req.method === "GET") {
    const allowedRaw = process.env.ALLOWED_DOMAIN || "";
    const allowedDomains = allowedRaw
      .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return json(res, 200, {
      allowedDomainRaw: allowedRaw,
      allowedDomainParsed: allowedDomains,
      domainCount: allowedDomains.length,
      hdParam: allowedDomains.length === 1 ? allowedDomains[0] : "*",
      hasGoogleClientId: !!process.env.GOOGLE_CLIENT_ID,
      hasGoogleClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
      hasAuthSecret: !!process.env.AUTH_SECRET,
      hasRedis: !!(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL),
      hasAnthropic: !!process.env.ANTHROPIC_API_KEY,
      hasPolly: !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY),
    });
  }

  // ========================= user-diag ===========================
  // Diagnostic timestamps for a single user — used to audit fraud-detection
  // gaps (e.g., did a kid click "I'm reading" then immediately quiz?).
  // GET /api/admin?action=user-diag&email=foo@x.com[&bookId=e02]
  //
  // Returns the three timestamps the fraud detector cares about:
  //   - currentlyReading.startedAt — when the kid clicked "I'm reading this"
  //   - fraudState.lastQuizAt      — when the kid last submitted a quiz
  //   - firstOpenAt[bookId]        — when the kid first opened the modal
  // plus computed gaps so you can see the click-to-quiz delta at a glance.
  if (action === "user-diag" && req.method === "GET") {
    const email = String(url.searchParams.get("email") || "").toLowerCase().trim();
    const bookId = String(url.searchParams.get("bookId") || "").trim() || null;
    if (!email) return json(res, 400, { error: "missing_email" });

    const r = redis();
    if (!r) return json(res, 503, { error: "no_redis" });

    const now = Date.now();
    const out = { email, bookId, now, nowISO: new Date(now).toISOString() };
    try {
      // Profile (grade, initialGrade, etc.)
      const rawProf = await r.hget("users", email).catch(() => null);
      out.profile = rawProf
        ? typeof rawProf === "string" ? JSON.parse(rawProf) : rawProf
        : null;

      const [cr, fs] = await Promise.all([
        getCurrentlyReading(email),
        getQuizFraudState(email),
      ]);
      out.currentlyReading = cr;
      out.fraudState = fs;

      // ISO renderings so the timestamps are human-readable in the response.
      if (cr?.startedAt) out.startedAtISO = new Date(cr.startedAt).toISOString();
      if (fs?.lastQuizAt) out.lastQuizAtISO = new Date(fs.lastQuizAt).toISOString();

      if (bookId) {
        out.firstOpenAt = await getFirstOpenAt(email, bookId);
        if (out.firstOpenAt) out.firstOpenAtISO = new Date(out.firstOpenAt).toISOString();
      }

      // Books the user has finished + their current XP totals. The set of
      // bookIds lives at `user:{email}:books`; the all-time score lives in
      // the `lb:points:all` zset.
      try {
        const [books, pointsAll] = await Promise.all([
          r.smembers(`user:${email}:books`).catch(() => []),
          r.zscore("lb:points:all", email).catch(() => null),
        ]);
        out.booksRead = Array.isArray(books) ? books : [];
        out.booksReadCount = out.booksRead.length;
        out.pointsAll = pointsAll != null ? Number(pointsAll) : null;
      } catch {}

      // Computed gaps — the real signal. If startedAt → lastQuizAt is small
      // relative to expected reading time, the kid skipped reading.
      if (cr?.startedAt) {
        const startedAt = Number(cr.startedAt);
        out.gapStartedToNowSec = Math.round((now - startedAt) / 1000);
        if (fs?.lastQuizAt) {
          const dt = Number(fs.lastQuizAt) - startedAt;
          out.gapStartedToLastQuizSec = Math.round(dt / 1000);
          out.gapStartedToLastQuizMin = +(dt / 60000).toFixed(2);
        }
      }
      if (bookId && out.firstOpenAt && fs?.lastQuizAt) {
        out.gapFirstOpenToLastQuizHr =
          +((Number(fs.lastQuizAt) - out.firstOpenAt) / 3_600_000).toFixed(2);
      }
    } catch (err) {
      out.error = String(err?.message || err);
    }
    return json(res, 200, out);
  }

  // ====================== hold-existing-read ======================
  // Retroactively move an already-awarded read into the held-XP queue.
  // Used to scrub leaderboard scores from quizzes that slipped past the
  // fraud detector before the detector was tightened.
  //
  // POST /api/admin?action=hold-existing-read
  // Body: { email, bookId, points, grade?, bookTitle?, reason? }
  // - Deducts `points` from all-time / weekly / grade leaderboards
  // - Adds a held-XP entry to the admin queue so review can approve/reject
  // - Does NOT remove the book from the kid's read set (they did pass the quiz)
  if (action === "hold-existing-read" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const email = String(body.email || "").toLowerCase().trim();
    const bookId = String(body.bookId || "").trim();
    const points = Math.round(Number(body.points || 0));
    const grade = body.grade ? normalizeGrade(body.grade) : null;
    const bookTitle = body.bookTitle ? String(body.bookTitle) : null;
    const reason = body.reason ? String(body.reason) : "retroactive_review";
    if (!email || !bookId || !(points > 0)) {
      return json(res, 400, { error: "invalid_request",
        message: "Need email, bookId, points (>0)." });
    }
    const result = await unawardAndHold({
      email, name: email.split("@")[0],
      grade, bookId, bookTitle, points, reason,
    });
    return json(res, result.ok ? 200 : 500, result);
  }

  // ========================= tts-usage ===========================
  if (action === "tts-usage" && req.method === "GET") {
    const { chars, hasRedis } = await getTtsUsage();
    return json(res, 200, {
      hasRedis,
      pollyConfigured: hasPolly(),
      chars,
      dollars: +(chars * COST_PER_CHAR).toFixed(4),
      capChars: APP_CAP_CHARS,
      capDollars: APP_CAP_USD,
      percentUsed: +(((chars / APP_CAP_CHARS) * 100) || 0).toFixed(1),
    });
  }

  // ======================== quiz-reports =========================
  if (action === "quiz-reports" && req.method === "GET") {
    const { reports, hasRedis, error } = await listQuizReports({ limit: 200 });
    return json(res, 200, { hasRedis, error: error || null, reports });
  }
  if (action === "quiz-reports" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const id = String(body.id || "");
    const a = String(body.action || "").toLowerCase();
    if (!id || !["confirm", "dismiss"].includes(a)) {
      return json(res, 400, { error: "invalid_request" });
    }
    // For confirm we look up the report first so we know which book to bust.
    let bookIdToBust = null;
    if (a === "confirm") {
      const r = redis();
      if (r) {
        try {
          const raw = await r.hget("quiz:reports:pending", id);
          if (raw) {
            const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            bookIdToBust = parsed?.bookId || null;
          }
        } catch {}
      }
    }
    const del = await deleteQuizReport(id);
    if (!del.ok) {
      return json(res, 500, { error: del.reason || "delete_failed" });
    }
    let bustedKeys = 0;
    if (a === "confirm" && bookIdToBust) {
      bustedKeys = await bustQuizCache(bookIdToBust);
    }
    return json(res, 200, { ok: true, action: a, bookIdToBust, bustedKeys });
  }

  // ========================== held-xp ============================
  if (action === "held-xp" && req.method === "GET") {
    const { entries, hasRedis, error } = await listHeldXp({ limit: 200 });
    return json(res, 200, { hasRedis, error: error || null, entries });
  }
  if (action === "held-xp" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const a = String(body.action || "").toLowerCase();

    if (a === "reset_flags") {
      const email = String(body.email || "").toLowerCase();
      if (!email) return json(res, 400, { error: "email_required" });
      const result = await resetFraudFlags(email);
      return json(
        res,
        result.ok ? 200 : 500,
        result.ok ? { ok: true, email } : { error: result.reason }
      );
    }

    const id = String(body.id || "");
    if (!id || !["approve", "reject"].includes(a)) {
      return json(res, 400, {
        error: "invalid_request",
        allowed_actions: ["approve", "reject", "reset_flags"],
      });
    }
    const result = await resolveHeldXp(id, a);
    if (!result.ok) {
      return json(
        res,
        result.reason === "not_found" ? 404 : 500,
        { error: result.reason || "resolve_failed" }
      );
    }
    return json(res, 200, { ok: true, action: a, entry: result.entry });
  }

  // ========================= set-grade ===========================
  if (action === "set-grade" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });

    const email = String(body.email || "").trim().toLowerCase();
    // Accept PK explicitly (TimeBack uses WG=-1 for PK); store as "PK" string.
    let grade = String(body.grade || "").trim().toUpperCase();
    if (grade === "PK" || grade === "-1") {
      grade = "PK";
    } else {
      grade = normalizeGrade(grade);
    }

    if (!email || !ALLOWED_GRADES.has(grade)) {
      return json(res, 400, {
        error: "invalid_request",
        allowed: [...ALLOWED_GRADES],
      });
    }

    const result = await setUserWorkingGrade(email, grade, "admin");
    if (!result.ok) {
      return json(res, 500, { error: result.reason || "save_failed" });
    }
    return json(res, 200, { ok: true, email, grade });
  }

  // ========================= reset-my-book =======================
  // Body: { bookId }
  // ADMIN-ONLY testing aid. Clears every per-(admin, bookId) state so
  // the admin can redo the quiz + retell flow from scratch:
  //   - SREM from user:{e}:books        (remove the "read" dedupe)
  //   - DEL quizattempts:{e}:{bookId}   (#40 attempt counter)
  //   - DEL quizopen:{e}:{bookId}       (#41 open counter)
  //   - DEL readsess:{e}:{bookId}       (#9 in-flight reading session)
  //   - DEL firstopen:{e}:{bookId}      (first-open fraud signal)
  //   - DEL user:{e}:book:{bookId}:points (audit value)
  //   - resetFraudFlags(e)              (drops the 2h-8h-24h cooldown ladder)
  //   - clearCurrentlyReading(e) if active book matches
  // Auth comes from the existing isAdmin gate at the top of this handler.
  if (action === "reset-my-book" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const bookId = String(body.bookId || "").trim();
    if (!bookId) return json(res, 400, { error: "bookId_required" });
    const r = redis();
    if (!r) return json(res, 500, { error: "no_redis" });
    const e = String(authedEmail).toLowerCase();
    const cleared = {};
    try {
      const sremRes = await r.srem(`user:${e}:books`, bookId);
      cleared.removedFromReadSet = Number(sremRes) > 0;
    } catch (err) { cleared.removedFromReadSet = `error:${String(err)}`; }
    for (const key of [
      `quizattempts:${e}:${bookId}`,
      `quizopen:${e}:${bookId}`,
      `readsess:${e}:${bookId}`,
      `firstopen:${e}:${bookId}`,
      `user:${e}:book:${bookId}:points`,
    ]) {
      try { await r.del(key); } catch {}
    }
    // resetFraudFlags clears cooldownUntil + flagCount globally for the
    // admin — which is what we want, since the "come back in 2 hours"
    // wait is the fraud cooldown firing on a held tutor session.
    try {
      await resetFraudFlags(e);
      cleared.fraudReset = true;
    } catch (err) { cleared.fraudReset = `error:${String(err)}`; }
    try {
      const active = await getCurrentlyReading(e);
      if (active && active.bookId === bookId) {
        await clearCurrentlyReading(e);
        cleared.clearedCurrentlyReading = true;
      }
    } catch {}
    return json(res, 200, { ok: true, email: e, bookId, cleared });
  }

  // ========================= bust-quiz ===========================
  // Body: { bookId }
  // ADMIN-ONLY testing aid. Forces the cached question pool for a book
  // to be deleted from Redis so the next /api/quiz fetch regenerates a
  // fresh pool from the current canonical record + prompt. Use this
  // after editing api/quiz.js QUIZ_BOOKS summaries, lib/book-records.json,
  // or any time the existing pool needs to be re-derived under updated
  // generator/QC rules. The client should ALSO clear its local
  // mid-attempt resume key (rs.quiz.<email>.<bookId>) after calling
  // this so the kid doesn't replay the old questions.
  if (action === "bust-quiz" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const bookId = String(body.bookId || "").trim();
    if (!bookId) return json(res, 400, { error: "bookId_required" });
    let bustedKeys = 0;
    try {
      bustedKeys = await bustQuizCache(bookId);
    } catch (err) {
      return json(res, 500, {
        error: "bust_failed",
        message: String(err?.message || err),
      });
    }
    return json(res, 200, { ok: true, bookId, bustedKeys });
  }

  // ========================= set-age-grade =======================
  // Body: { email, ageGrade }
  // Sets ONLY the maturity-calibration grade. Working grade (catalog
  // visibility + XP math) stays untouched. Use when a student needs
  // age-appropriate question framing that differs from their working
  // level (e.g., a G2-age kid reading at G3 working level should get
  // G2 maturity in question tone). Same allowed-grades set as set-grade.
  if (action === "set-age-grade" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });

    const email = String(body.email || "").trim().toLowerCase();
    let ageGrade = String(body.ageGrade || "").trim().toUpperCase();
    if (ageGrade === "PK" || ageGrade === "-1") {
      ageGrade = "PK";
    } else {
      ageGrade = normalizeGrade(ageGrade);
    }

    if (!email || !ALLOWED_GRADES.has(ageGrade)) {
      return json(res, 400, {
        error: "invalid_request",
        allowed: [...ALLOWED_GRADES],
      });
    }

    const result = await setUserAgeGrade(email, ageGrade, "admin");
    if (!result.ok) {
      return json(res, 500, { error: result.reason || "save_failed" });
    }
    return json(res, 200, { ok: true, email, ageGrade });
  }

  // ========================== reset-tour =========================
  // Clear the student's first-run onboarding state so the voice picker
  // and spotlight tour show again on next sign-in. Used for QA, demos,
  // and rare cases where a kid blew past the tour without taking it in.
  // Body: { email }
  if (action === "reset-tour" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return json(res, 400, { error: "email_required" });
    const r = redis();
    if (!r) return json(res, 500, { error: "no_redis" });
    try {
      const raw = await r.hget("users", email);
      const prof = raw
        ? typeof raw === "string"
          ? JSON.parse(raw)
          : raw
        : {};
      delete prof.tourCompleted;
      delete prof.tourCompletedAt;
      await r.hset("users", { [email]: JSON.stringify(prof) });
      return json(res, 200, { ok: true, email });
    } catch (err) {
      return json(res, 500, { error: "redis_error", detail: String(err) });
    }
  }

  // ====================== set-track-overrides ====================
  // Body: { email, overrides: { e: "auto"|"unlocked"|"locked", k: ..., ... } }
  // Missing tracks default to "auto" (follow at-or-below-working-grade rule).
  if (action === "set-track-overrides" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) return json(res, 400, { error: "email_required" });
    const cleaned = sanitizeTrackOverrides(body.overrides);
    const result = await setTrackOverrides(email, cleaned);
    if (!result.ok) {
      return json(res, 500, { error: result.reason || "save_failed" });
    }
    return json(res, 200, {
      ok: true,
      email,
      overrides: cleaned,
      tracks: TRACK_ORDER,
    });
  }

  // ====================== bulk-set-grades ========================
  // Bulk apply working-grade updates (typically a TimeBack-sync payload
  // pasted into the admin UI). Body shape:
  //   { updates: [{email, grade}, ...], force?: boolean }
  // force=true overwrites manual admin overrides too (default: skip them).
  if (action === "bulk-set-grades" && req.method === "POST") {
    const body = await readBody(req);
    if (body === null) return json(res, 400, { error: "invalid_json" });

    const updates = Array.isArray(body.updates) ? body.updates : null;
    const force = !!body.force;
    if (!updates) {
      return json(res, 400, {
        error: "invalid_request",
        hint: "Body must be { updates: [{email, grade}, ...], force?: bool }",
      });
    }
    if (updates.length > 1000) {
      // Protect Redis from a runaway paste. Real cohorts are under 1k.
      return json(res, 400, { error: "too_many_updates", max: 1000 });
    }

    // Validate each grade is in the allowed set. Normalize PK / numerics
    // exactly like set-grade does.
    const normalized = [];
    for (const u of updates) {
      let g = String(u?.grade || "").trim().toUpperCase();
      if (g === "PK" || g === "-1") {
        g = "PK";
      } else {
        g = normalizeGrade(g);
      }
      if (!ALLOWED_GRADES.has(g)) {
        return json(res, 400, {
          error: "invalid_grade",
          email: u?.email,
          grade: u?.grade,
          allowed: [...ALLOWED_GRADES],
        });
      }
      normalized.push({ email: u.email, grade: g });
    }

    const result = await bulkSetWorkingGrades(normalized, { force });
    if (!result.ok) {
      return json(res, 500, { error: result.reason || "bulk_set_failed" });
    }
    return json(res, 200, result);
  }

  // ========================= test-caliper ========================
  // Build a sample Caliper envelope (or send it, if ?send=1). Used to:
  //   - Hand TimeBack a sample to verify their ingestion against.
  //   - Smoke-test the real TIMEBACK_CALIPER_URL once configured.
  // Body (all optional — sensible defaults if omitted):
  //   { email, studentId, studentName, bookId, bookTitle, attemptNum,
  //     scoreGiven, bookGradeLevel, studentGrade, xpAwarded, fraudFlag,
  //     send?: boolean }
  if (action === "test-caliper") {
    const body =
      req.method === "POST" ? await readBody(req) : {};
    if (body === null) return json(res, 400, { error: "invalid_json" });
    const envelope = buildQuizEventEnvelope({
      email: body.email || "test.student@alpha.school",
      studentId: body.studentId || null,
      studentName: body.studentName || "Test Student",
      bookId: body.bookId || "k01",
      bookTitle: body.bookTitle || "The Very Hungry Caterpillar",
      attemptNum: body.attemptNum != null ? Number(body.attemptNum) : 1,
      scoreGiven: body.scoreGiven != null ? Number(body.scoreGiven) : 5,
      maxScore: 5,
      bookGradeLevel: body.bookGradeLevel || "K",
      studentGrade: body.studentGrade || "2",
      xpAwarded: body.xpAwarded != null ? Number(body.xpAwarded) : 2,
      fraudFlag: body.fraudFlag || "clean",
    });
    let dispatch = null;
    if (body.send) {
      dispatch = await postCaliperEnvelope(envelope);
    }
    return json(res, 200, { envelope, dispatch });
  }

  // ====================== caliper-health =========================
  if (action === "caliper-health" && req.method === "GET") {
    const health = await getCaliperHealthSnapshot();
    return json(res, 200, health);
  }

  // ==================== caliper-drain-retry ======================
  // Both POST (admin button) and GET (Vercel cron every 15 min) work.
  // Vercel cron jobs are GET-only by default, so we accept either verb
  // here — the action is idempotent so verb-strictness adds nothing.
  if (action === "caliper-drain-retry") {
    const result = await drainCaliperRetryQueue({ max: 100 });
    return json(res, 200, { ...result, triggeredBy: isCronCall ? "cron" : "admin" });
  }

  // ============================ 404 ==============================
  return json(res, 404, {
    error: "not_found",
    receivedAction: action,
    receivedMethod: req.method,
    hint: "Use ?action= users | tts-usage | quiz-reports | held-xp | held-xp(POST) | hold-existing-read(POST) | set-grade(POST) | bulk-set-grades(POST) | set-track-overrides(POST) | reset-tour(POST) | test-caliper | caliper-health | caliper-drain-retry | timeback-sync | obs-stats | env-check | user-diag",
  });
}
