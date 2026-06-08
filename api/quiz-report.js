// Submitted by a kid (or anyone authenticated) to flag a quiz question as
// bad. Stored for admin review at /admin → Flagged Questions.

import { verifySession, parseCookies } from "../lib/session.js";
import { saveQuizReport } from "../lib/store.js";
import { getCachedQuizPool } from "./quiz.js";
import { normalizeGrade } from "../lib/xp.js";

const ALLOWED_REASONS = new Set([
  "answer_wrong",
  "not_in_book",
  "confusing",
  "other",
]);

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "method_not_allowed" }));
  }

  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthenticated" }));
  }

  // Parse body
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_json" }));
  }

  const bookId = String(body.bookId || "").slice(0, 32);
  let question = String(body.question || "").slice(0, 500);
  let options = Array.isArray(body.options)
    ? body.options.slice(0, 4).map((o) => String(o).slice(0, 200))
    : [];
  const studentGrade = String(body.studentGrade || "").slice(0, 4);
  const ageGrade = body.ageGrade ? String(body.ageGrade).slice(0, 4) : null;
  const poolIdx = Number.isInteger(body.poolIdx) ? body.poolIdx : null;
  const chosenOriginalIdx = Number.isInteger(body.chosenOriginalIdx)
    ? body.chosenOriginalIdx
    : null;
  const reason = String(body.reason || "other").toLowerCase();
  const note = String(body.note || "").slice(0, 500);

  if (!bookId || !question) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_request" }));
  }
  if (!ALLOWED_REASONS.has(reason)) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_reason" }));
  }

  // Fix #62: client can't know markedCorrect — the answer key is
  // stripped from /api/quiz responses (#28). Look it up server-side
  // from the cached pool using bookId + studentGrade + poolIdx. If
  // any of those don't resolve, fall back to a legacy `body.markedCorrect`
  // (which will be null/missing in current builds — kept for safety).
  // While we're at it, replace the client's shuffled options with the
  // canonical (un-shuffled) pool options so the admin moderation view
  // is the ground-truth ordering, not whatever a single kid saw.
  let markedCorrect = Number.isInteger(body.markedCorrect)
    ? body.markedCorrect
    : null;
  if (poolIdx !== null && studentGrade) {
    try {
      const normalizedStudent = normalizeGrade(studentGrade);
      const normalizedAge = ageGrade ? normalizeGrade(ageGrade) : null;
      const pool = await getCachedQuizPool(
        bookId,
        normalizedStudent,
        normalizedAge
      );
      const poolQ = pool?.questions?.[poolIdx];
      if (poolQ) {
        if (Number.isInteger(poolQ.answer)) markedCorrect = poolQ.answer;
        // Prefer the canonical question text + options.
        if (poolQ.q) question = String(poolQ.q).slice(0, 500);
        if (Array.isArray(poolQ.options)) {
          options = poolQ.options.slice(0, 4).map((o) => String(o).slice(0, 200));
        }
      }
    } catch (err) {
      console.warn("[quiz-report] pool lookup failed", err);
    }
  }

  const result = await saveQuizReport({
    bookId,
    question,
    options,
    markedCorrect,
    chosenOriginalIdx,
    studentGrade,
    reason,
    note,
    reportedByEmail: session.email,
    reportedByName: session.name,
  });

  if (!result.ok) {
    res.statusCode = 500;
    return res.end(
      JSON.stringify({ error: result.reason || "save_failed" })
    );
  }

  res.statusCode = 200;
  return res.end(JSON.stringify({ ok: true, id: result.id }));
}
