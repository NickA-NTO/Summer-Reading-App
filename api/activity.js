// Records a "read" event when a kid finishes a book (either via the AI
// quiz pass or the manual "I read this" button). Updates per-user dedupe
// set and all sorted-set leaderboards in one Redis round-trip.
//
// 1d.2: If `attemptNum === 2` (second-attempt quiz pass) the awarded
//       points are halved (configurable via POINTS_RETAKE_MULTIPLIER env).
//
// 1d.3: Speed-based fraud detection is applied when `attemptNum` is
//       present (i.e. the read was triggered by a quiz pass, not the
//       manual button). If the elapsed time since the student's last
//       quiz is suspiciously short relative to the book's expected
//       reading time, the XP is either held for admin review or partially
//       reduced. Manual "I read this" reads skip fraud detection entirely.

import { verifySession, parseCookies } from "../lib/session.js";
import {
  recordRead,
  guessGradeFromEmail,
  getQuizFraudState,
  setLastQuizAt,
  applyFraudFlag,
  addHeldXpEntry,
  FRAUD_RATIO_HOLD,
  FRAUD_RATIO_SOFT,
  FRAUD_FRESHNESS_WINDOW_MS,
} from "../lib/store.js";
import { getBook } from "../lib/books.js";
import { pointsForBook, normalizeGrade, WCPM_BY_GRADE } from "../lib/xp.js";

// Internal-leaderboard points multiplier for 2nd-attempt passes.
// Can be overridden via env var (e.g. POINTS_RETAKE_MULTIPLIER=0.75).
const RETAKE_MULTIPLIER = Number(
  process.env.POINTS_RETAKE_MULTIPLIER || "0.5"
);

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
  // Student's working grade: client-supplied (comes from /api/auth/me
  // once we wire up working-grade storage), falling back to email heuristic,
  // ultimately defaulting to "K" inside normalizeGrade.
  const grade = normalizeGrade(
    body.grade || guessGradeFromEmail(session.email) || "K"
  );
  // attemptNum: 1 or 2 (present for quiz passes, absent for manual reads).
  const attemptNum =
    body.attemptNum != null ? Number(body.attemptNum) : null;

  if (kind !== "read" || !bookId) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_request" }));
  }

  const book = getBook(bookId);
  const basePoints = book ? pointsForBook(book.wordCount, grade) : 0;

  // -----------------------------------------------------------------------
  // Fraud detection — only for quiz passes (attemptNum is present).
  // Manual "I read this" submissions skip this entirely.
  // -----------------------------------------------------------------------
  let fraudStatus = "clean"; // "clean" | "soft_flag" | "held"
  let finalPoints = basePoints;
  let heldInfo = null;

  if (attemptNum != null && book) {
    const now = Date.now();
    const fraud = await getQuizFraudState(session.email);

    // 1. Cooldown check — student may be locked out from a prior offense.
    if (fraud.cooldownUntil && now < fraud.cooldownUntil) {
      res.statusCode = 423; // Locked
      return res.end(
        JSON.stringify({
          ok: false,
          error: "cooldown",
          cooldownUntil: fraud.cooldownUntil,
          message:
            "You're on a reading cool-down. Take a break and come back later!",
        })
      );
    }

    // 2. Speed check — compare elapsed time to expected reading time.
    //    Only meaningful if there's a recent lastQuizAt (within 8 hours).
    if (
      fraud.lastQuizAt &&
      now - fraud.lastQuizAt < FRAUD_FRESHNESS_WINDOW_MS
    ) {
      const elapsedMins = (now - fraud.lastQuizAt) / 60_000;
      const wcpm = WCPM_BY_GRADE[grade] ?? WCPM_BY_GRADE["K"];
      const minExpectedMins = book.wordCount / wcpm;
      const ratio =
        minExpectedMins > 0 ? elapsedMins / minExpectedMins : 1.0;

      if (ratio < FRAUD_RATIO_HOLD) {
        // Definitely too fast — hold XP for admin review and flag.
        fraudStatus = "held";
        const flagResult = await applyFraudFlag(session.email);
        const heldResult = await addHeldXpEntry({
          email: session.email,
          name: session.name || session.email.split("@")[0],
          bookId,
          bookTitle: book.title || bookId,
          grade,
          points: basePoints, // full points — admin can choose to approve all
          suspicionRatio: +ratio.toFixed(3),
          elapsedMins: +elapsedMins.toFixed(1),
          minExpectedMins: +minExpectedMins.toFixed(1),
          reason: "speed",
        });
        heldInfo = {
          reason: "speed",
          cooldownUntil: flagResult.cooldownUntil,
          flagCount: flagResult.flagCount,
          heldId: heldResult.id || null,
        };
        finalPoints = 0;
      } else if (ratio < FRAUD_RATIO_SOFT) {
        // Suspicious but not definitive — soft penalty (half points).
        fraudStatus = "soft_flag";
        finalPoints = Math.max(1, Math.floor(basePoints * 0.5));
      }
    }

    // 3. Retake multiplier (1d.2) — applied ONLY on clean passes.
    //    Soft-flagged submissions already have a penalty; don't stack.
    if (fraudStatus === "clean" && attemptNum === 2) {
      finalPoints = Math.max(1, Math.floor(basePoints * RETAKE_MULTIPLIER));
    }

    // Always update lastQuizAt so the next submission gets a fresh baseline.
    await setLastQuizAt(session.email, now);
  }

  // -----------------------------------------------------------------------
  // Record the read in the leaderboard.
  // For held submissions: record with 0 points so the book is marked as
  // read (dedup guard) but no points enter the leaderboard yet.
  // Admin approval calls awardPointsOnly() to add the withheld points later.
  // -----------------------------------------------------------------------
  const result = await recordRead({
    email: session.email,
    name: session.name,
    grade,
    bookId,
    points: finalPoints,
  });

  const response = {
    ok: true,
    recorded: result.recorded,
    reason: result.reason || null,
    points: result.points || 0,
    grade,
  };

  if (fraudStatus === "held") {
    response.held = true;
    response.heldInfo = heldInfo;
  } else if (fraudStatus === "soft_flag") {
    response.softFlag = true;
  }

  if (fraudStatus === "clean" && attemptNum === 2 && result.recorded) {
    response.isRetake = true;
    response.basePoints = basePoints;
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(response));
}
