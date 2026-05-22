// Records a "read" event when a kid finishes a book (either via the AI
// quiz pass or the manual "I read this" button). Updates per-user dedupe
// set and all sorted-set leaderboards in one Redis round-trip.

import { verifySession, parseCookies } from "../lib/session.js";
import { recordRead, guessGradeFromEmail } from "../lib/store.js";
import { getBook } from "../lib/books.js";
import { pointsForBook, normalizeGrade } from "../lib/xp.js";

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

  // Parse body (Vercel doesn't auto-parse for raw functions)
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_json" }));
  }

  const kind = String(body.kind || "").toLowerCase();
  const bookId = String(body.bookId || "");
  // Student's working grade: client-supplied (will come from /api/auth/me
  // once we wire up working-grade storage), falling back to email heuristic,
  // ultimately defaulting to "K" inside normalizeGrade.
  const grade = normalizeGrade(
    body.grade || guessGradeFromEmail(session.email) || "K"
  );

  if (kind !== "read" || !bookId) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_request" }));
  }

  // Compute points based on book length + student's reading-rate grade
  const book = getBook(bookId);
  const points = book ? pointsForBook(book.wordCount, grade) : 0;

  const result = await recordRead({
    email: session.email,
    name: session.name,
    grade,
    bookId,
    points,
  });

  res.statusCode = 200;
  return res.end(
    JSON.stringify({
      ok: true,
      recorded: result.recorded,
      reason: result.reason || null,
      points: result.points || 0,
      grade,
    })
  );
}
