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
  bulkSetWorkingGrades,
  setTrackOverrides,
  redis,
} from "../../lib/store.js";
import { sanitizeTrackOverrides, TRACK_ORDER } from "../../lib/tracks.js";
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
  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) return json(res, 401, { error: "unauthenticated" });
  if (!isAdmin(session.email)) return json(res, 403, { error: "forbidden" });

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = String(url.searchParams.get("action") || "").toLowerCase();

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
  if (action === "caliper-drain-retry" && req.method === "POST") {
    const result = await drainCaliperRetryQueue({ max: 100 });
    return json(res, 200, result);
  }

  // ============================ 404 ==============================
  return json(res, 404, {
    error: "not_found",
    hint: "Use ?action=users|tts-usage|quiz-reports|held-xp|set-grade|bulk-set-grades|set-track-overrides|reset-tour|test-caliper|caliper-health|caliper-drain-retry",
  });
}
