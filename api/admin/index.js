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
  redis,
} from "../../lib/store.js";
import {
  APP_CAP_CHARS,
  APP_CAP_USD,
  COST_PER_CHAR,
  hasPolly,
} from "../../lib/tts.js";
import { normalizeGrade } from "../../lib/xp.js";

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

    const result = await setUserWorkingGrade(email, grade);
    if (!result.ok) {
      return json(res, 500, { error: result.reason || "save_failed" });
    }
    return json(res, 200, { ok: true, email, grade });
  }

  // ============================ 404 ==============================
  return json(res, 404, {
    error: "not_found",
    hint: "Use ?action=users|tts-usage|quiz-reports|held-xp|set-grade",
  });
}
