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
  recordFirstOpen,
  getFirstOpenAt,
  FRAUD_RATIO_HOLD,
  FRAUD_RATIO_SOFT,
  FRAUD_FRESHNESS_WINDOW_MS,
  FIRST_OPEN_SUSPICION_HOURS,
} from "../lib/store.js";
import { getBook } from "../lib/books.js";
import { pointsForBook, normalizeGrade, WCPM_BY_GRADE } from "../lib/xp.js";
import { buildQuizEventEnvelope } from "../lib/caliper.js";
import { sendCaliperEnvelopeAsync } from "../lib/timeback.js";

// Internal-leaderboard XP multiplier for 2nd-attempt passes.
// 0.7 default: question rotation (1d.1) already kills the "memorize-then-
// retake" attack since attempt 2 sees fresh questions. The remaining job
// of the multiplier is to nudge first-pass effort, which 0.7 still does
// (you earn 30% less) without being cruel to a kid who genuinely re-read.
// Tunable via POINTS_RETAKE_MULTIPLIER env if we want to dial it later.
const RETAKE_MULTIPLIER = Number(
  process.env.POINTS_RETAKE_MULTIPLIER || "0.7"
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

  // -----------------------------------------------------------------------
  // kind === "open"  — first-time book-modal open, no XP, no leaderboard.
  // Sets a server-side timestamp the first time this (email, bookId) pair
  // is seen. Used later by the fraud engine as the floor for "earliest
  // moment they could possibly have started reading via Reading Spine."
  // SETNX-style: subsequent opens are silently ignored so the floor never
  // shifts later in time (which would let cheaters game it).
  // -----------------------------------------------------------------------
  if (kind === "open") {
    if (!bookId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid_request" }));
    }
    const firstOpenAt = await recordFirstOpen(session.email, bookId);
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, firstOpenAt }));
  }

  if (kind !== "read" || !bookId) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_request" }));
  }

  const book = getBook(bookId);
  // Quiz-driven reads (attemptNum present) include the expected quiz time
  // in the XP base — that's how we land at ~1 XP per active minute of
  // focused work (reading + quiz). Manual "I read this" reads (no quiz)
  // omit it. Emergent quizzes use a shorter expected time (2 min vs 3).
  const isEmergent = book?.quizStyle === "emergent";
  const basePoints = book
    ? pointsForBook(book.wordCount, grade, {
        includeQuizTime: attemptNum != null,
        emergent: isEmergent,
      })
    : 0;

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

    // 2a. WCPM speed check — elapsed time between THIS quiz and the
    //     student's previous quiz, against the book's expected reading
    //     time. Catches fast quiz-to-quiz hopping (cheating across
    //     multiple books in a session).
    let wcpmStatus = "clean"; // "clean" | "soft" | "hold"
    let wcpmDebug = null;
    if (
      fraud.lastQuizAt &&
      now - fraud.lastQuizAt < FRAUD_FRESHNESS_WINDOW_MS
    ) {
      const elapsedMins = (now - fraud.lastQuizAt) / 60_000;
      const wcpm = WCPM_BY_GRADE[grade] ?? WCPM_BY_GRADE["K"];
      const minExpectedMins = book.wordCount / wcpm;
      const ratio =
        minExpectedMins > 0 ? elapsedMins / minExpectedMins : 1.0;
      wcpmDebug = {
        elapsedMins: +elapsedMins.toFixed(1),
        minExpectedMins: +minExpectedMins.toFixed(1),
        ratio: +ratio.toFixed(3),
      };
      if (ratio < FRAUD_RATIO_HOLD) wcpmStatus = "hold";
      else if (ratio < FRAUD_RATIO_SOFT) wcpmStatus = "soft";
    }

    // 2b. First-open fairness check (soft Amazon-ordering proxy).
    //     The earliest moment we can be sure a student knew about the
    //     book through Reading Spine is when they first opened its
    //     modal. If the gap between that and this quiz submission is
    //     too small, they physically couldn't have ordered + received
    //     + read the book — unless they already owned it (in which
    //     case the WCPM check above will usually pass).
    //
    //     If `firstOpenAt` is null we have no data → treat as clean
    //     (don't punish for missing telemetry).
    let openStatus = "clean"; // "clean" | "suspicious"
    let openDebug = null;
    const firstOpenAt = await getFirstOpenAt(session.email, bookId);
    if (firstOpenAt) {
      const hoursSinceOpen = (now - firstOpenAt) / 3_600_000;
      openDebug = { hoursSinceOpen: +hoursSinceOpen.toFixed(2) };
      if (hoursSinceOpen < FIRST_OPEN_SUSPICION_HOURS) {
        openStatus = "suspicious";
      }
    }

    // 2c. Combine the two signals using a fair soft matrix:
    //       WCPM clean   + open clean         → clean
    //       WCPM clean   + open suspicious    → soft_flag (only 1 signal)
    //       WCPM soft    + open clean         → soft_flag (existing behavior)
    //       WCPM soft    + open suspicious    → held (both signals agree)
    //       WCPM hold    + (any)              → held (WCPM hold is strong)
    //
    //     Net effect: a kid who already had the book at home is mostly
    //     protected — the WCPM check sees a reasonable gap because they
    //     read at a normal pace, and the first-open check by itself
    //     downgrades only to a soft flag, never an outright hold.
    let combined = "clean";
    if (wcpmStatus === "hold") {
      combined = "hold";
    } else if (wcpmStatus === "soft" && openStatus === "suspicious") {
      combined = "hold";
    } else if (wcpmStatus === "soft" || openStatus === "suspicious") {
      combined = "soft";
    }

    if (combined === "hold") {
      fraudStatus = "held";
      const flagResult = await applyFraudFlag(session.email);
      const heldResult = await addHeldXpEntry({
        email: session.email,
        name: session.name || session.email.split("@")[0],
        bookId,
        bookTitle: book.title || bookId,
        grade,
        points: basePoints, // full points — admin can choose to approve all
        suspicionRatio: wcpmDebug?.ratio ?? null,
        elapsedMins: wcpmDebug?.elapsedMins ?? null,
        minExpectedMins: wcpmDebug?.minExpectedMins ?? null,
        hoursSinceOpen: openDebug?.hoursSinceOpen ?? null,
        reason:
          wcpmStatus === "hold"
            ? "speed"
            : openStatus === "suspicious" && wcpmStatus === "soft"
              ? "speed_plus_recent_open"
              : "speed",
      });
      heldInfo = {
        reason: "speed",
        cooldownUntil: flagResult.cooldownUntil,
        flagCount: flagResult.flagCount,
        heldId: heldResult.id || null,
      };
      finalPoints = 0;
    } else if (combined === "soft") {
      fraudStatus = "soft_flag";
      finalPoints = Math.max(1, Math.floor(basePoints * 0.5));
    }

    // 3. Retake multiplier (1d.2) — applied ONLY on clean passes.
    //    Soft-flagged submissions already have a penalty; don't stack.
    //    Note: basePoints now includes quiz time, so the 0.7 multiplier
    //    fairly accounts for the second quiz attempt the kid took.
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

  // -----------------------------------------------------------------------
  // Fire-and-forget Caliper events to TimeBack (1e). Only emit when this is
  // a real quiz pass (attemptNum present + book exists + recorded). Held
  // submissions DO emit — TimeBack should know the kid attempted, the
  // `extensions.fraudFlag` lets them decide whether to credit XP.
  //
  // No await: response returns before the HTTPS round-trip to TimeBack.
  // If TimeBack is unreachable, sendCaliperEnvelopeAsync queues to Redis.
  // -----------------------------------------------------------------------
  if (attemptNum != null && book && result.recorded) {
    try {
      const envelope = buildQuizEventEnvelope({
        email: session.email,
        studentId: session.studentId || null, // populated once TimeBack id mapping ships
        studentName: session.name,
        bookId,
        bookTitle: book.title || bookId,
        attemptNum,
        scoreGiven: body.score != null ? Number(body.score) : 5, // pass = 4-5; default 5 if not supplied
        maxScore: 5,
        bookGradeLevel: book.grade,
        studentGrade: grade,
        xpAwarded: finalPoints,
        fraudFlag: fraudStatus,
      });
      sendCaliperEnvelopeAsync(envelope);
    } catch (err) {
      // Never let Caliper emission break the student-facing response.
      console.warn("[caliper_emit_failed]", String(err?.message || err));
    }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(response));
}
