// Submitted by a kid (or anyone authenticated) to flag a quiz question as
// bad. Stored for admin review at /admin → Flagged Questions.

import { verifySession, parseCookies } from "../lib/session.js";
import { saveQuizReport } from "../lib/store.js";

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
  const question = String(body.question || "").slice(0, 500);
  const options = Array.isArray(body.options)
    ? body.options.slice(0, 4).map((o) => String(o).slice(0, 200))
    : [];
  const markedCorrect = Number.isInteger(body.markedCorrect)
    ? body.markedCorrect
    : null;
  const studentGrade = String(body.studentGrade || "").slice(0, 4);
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

  const result = await saveQuizReport({
    bookId,
    question,
    options,
    markedCorrect,
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
