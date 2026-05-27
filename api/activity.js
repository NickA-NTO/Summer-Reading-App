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

import { verifySession, parseCookies, isAdmin } from "../lib/session.js";
import { resolveVisibleTracks, trackForBook } from "../lib/tracks.js";
import {
  recordRead,
  guessGradeFromEmail,
  getQuizFraudState,
  setLastQuizAt,
  applyFraudFlag,
  addHeldXpEntry,
  recordFirstOpen,
  getFirstOpenAt,
  setCurrentlyReading,
  getCurrentlyReading,
  clearCurrentlyReading,
  updateUserOnboarding,
  evaluateAchievementsForUser,
  redis,
  FRAUD_RATIO_HOLD,
  FRAUD_RATIO_SOFT,
  FRAUD_FRESHNESS_WINDOW_MS,
  FIRST_OPEN_SUSPICION_HOURS,
  STARTED_RECENTLY_HOLD_MS,
} from "../lib/store.js";
import { getBook } from "../lib/books.js";
import { pointsForBook, normalizeGrade, WCPM_BY_GRADE } from "../lib/xp.js";
import { buildQuizEventEnvelope } from "../lib/caliper.js";
import { sendCaliperEnvelopeAsync } from "../lib/timeback.js";
// QUIZ_BOOKS = full set of quiz-enabled book ids. Imported so we can
// reject `kind:"read"` calls for quiz-enabled books — the only legitimate
// XP path for those is `kind:"quiz_submit"`, which the server validates
// against the cached question pool. Closes Agent 3's "skip the quiz"
// attack (`kind:"read"` with no attemptNum bypassed all fraud checks).
import { QUIZ_BOOKS, QUIZ_SCHEMA_VERSION, getCachedQuizPool } from "./quiz.js";

// Load the user's profile from Redis. Returns null if missing or on error.
async function loadProfile(email) {
  const r = redis();
  if (!r) return null;
  try {
    const raw = await r.hget("users", String(email).toLowerCase());
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

// Resolve the student's working grade — SERVER side, no client trust.
// Mirrors the resolution chain in /api/auth/me (profile → email heuristic
// → "K"). Closes Agent 3's grade-spoof attack (kid was posting
// `grade:"PK"` from DevTools to inflate XP by ~7× via the lower WCPM).
function resolveGradeServerSide(profile, email) {
  if (profile && profile.grade) return normalizeGrade(profile.grade);
  return normalizeGrade(guessGradeFromEmail(email) || "K");
}

/**
 * Belt-and-suspenders track-locking for /api/activity. /api/quiz.js
 * already 403s on track-locked books (lib/quiz.js:843), but a kid
 * could otherwise hit /api/activity directly with kind:"start" /
 * "read" / "quiz_submit" to mark a locked book as currently reading
 * or record a read against a stale cache. Returns true if the kid
 * is allowed to act on this book, false to reject.
 *
 * Admins bypass — they need to act on every book for QA + admin work.
 */
function isBookTrackVisibleForUser(book, profile, email) {
  if (isAdmin(email)) return true;
  const t = trackForBook(book);
  if (!t) return true; // unknown track → don't block (defensive)
  const grade = resolveGradeServerSide(profile, email);
  const visible = resolveVisibleTracks(grade, profile?.trackOverrides || {});
  return visible.includes(t);
}

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
  // Student's working grade — SERVER-RESOLVED from the profile. Previous
  // versions accepted body.grade from the client, which let a Grade-3
  // reader POST `grade:"PK"` to mint ~7× XP (lower WCPM target = bigger
  // payout). Client-supplied grade is now ignored entirely. The kid's
  // working grade is the one their /api/auth/me would resolve to:
  // profile.grade → email heuristic → "K".
  const profile = await loadProfile(session.email);
  const grade = resolveGradeServerSide(profile, session.email);
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

  // -----------------------------------------------------------------------
  // kind === "start"  — student declares they're actively reading this book.
  // One book at a time per student. If there's already an active read AND
  // it's a different book, return 409 with the existing record unless the
  // caller passed `swap: true` (acknowledged the prompt). On swap or empty
  // slot, set currentlyReading = { bookId, startedAt: now }.
  // -----------------------------------------------------------------------
  // -----------------------------------------------------------------------
  // kind === "profile" — persist onboarding settings (#17).
  // Body: { kind: "profile", preferredVoiceId?, tourCompleted? }
  // Used by the first-run flow: voice picker writes preferredVoiceId,
  // the spotlight-tour finale writes tourCompleted=true. Either field is
  // optional; only the present ones are written.
  // -----------------------------------------------------------------------
  if (kind === "profile") {
    const result = await updateUserOnboarding(session.email, {
      preferredVoiceId: body.preferredVoiceId,
      tourCompleted: body.tourCompleted,
    });
    // If the tour just completed, re-evaluate achievements so the
    // hidden "Tour Guide" badge fires.
    if (result.ok && body.tourCompleted === true) {
      try {
        const r = redis();
        let profile = null;
        if (r) {
          const raw = await r.hget("users", String(session.email).toLowerCase());
          profile = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
        }
        result.newAchievements = await evaluateAchievementsForUser(
          session.email, profile, { streakDays: Number(body.streakDays) || 0 }
        );
      } catch {}
    }
    res.statusCode = result.ok ? 200 : 400;
    return res.end(JSON.stringify(result));
  }

  if (kind === "start") {
    if (!bookId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid_request" }));
    }
    // Track-locking gate — refuse to start a read on a book this student
    // can't see. Belt-and-suspenders with the same check in /api/quiz.js;
    // an admin can lock a track for a kid mid-summer and we don't want
    // them able to "currently read" a hidden book.
    const startBook = getBook(bookId);
    if (startBook && !isBookTrackVisibleForUser(startBook, profile, session.email)) {
      res.statusCode = 403;
      return res.end(JSON.stringify({
        error: "track_locked",
        message: "This book isn't available at your grade level.",
      }));
    }
    const existing = await getCurrentlyReading(session.email);
    if (existing && existing.bookId !== bookId && !body.swap) {
      res.statusCode = 409;
      return res.end(
        JSON.stringify({
          ok: false,
          error: "already_reading",
          currentlyReading: existing,
          message:
            "You're already reading another book. Pass swap:true to switch.",
        })
      );
    }
    // First-open is set too (in case they clicked Start without opening
    // the modal — covers the rare edge case where the start button is
    // surfaced from a card directly).
    await recordFirstOpen(session.email, bookId);
    const result = await setCurrentlyReading(session.email, bookId);
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        currentlyReading: { bookId, startedAt: result.startedAt },
        previouslyReading: existing || null,
      })
    );
  }

  // ============================================================
  // kind === "quiz_submit" — the kid finished a 5-question attempt;
  // server validates their chosen indices against the cached pool
  // and decides pass/fail. ONLY path to XP for quiz-enabled books.
  // ============================================================
  if (kind === "quiz_submit") {
    if (!bookId || !(attemptNum === 1 || attemptNum === 2)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({
        error: "invalid_request",
        message: "Need bookId + attemptNum (1 or 2).",
      }));
    }
    if (!(bookId in QUIZ_BOOKS)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({
        error: "no_quiz_for_book",
        message: "This book doesn't have a quiz.",
      }));
    }
    // Client posts `answers: [{ idx, chosen }, ...]` — idx is the index
    // into the cached pool (0..poolSize-1), chosen is the kid's tapped
    // option (0..3). Validates length + bounds before grading.
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (answers.length !== 5) {
      res.statusCode = 400;
      return res.end(JSON.stringify({
        error: "invalid_answers",
        message: "Need exactly 5 answers.",
      }));
    }
    const pool = await getCachedQuizPool(bookId, grade);
    if (!pool || !Array.isArray(pool.questions) || pool.questions.length < 5) {
      // The kid hit quiz_submit without ever fetching /api/quiz, OR the
      // pool expired mid-attempt. Either way we can't validate; refuse.
      res.statusCode = 409;
      return res.end(JSON.stringify({
        error: "no_quiz_pool",
        message: "Couldn't find the quiz for this book. Reopen the quiz and try again.",
      }));
    }
    // Grade each answer against the cached correct index.
    let correctCount = 0;
    const correctFlags = [];
    const seenIdx = new Set();
    for (const a of answers) {
      const idx = Number(a?.idx);
      const chosen = Number(a?.chosen);
      if (
        !Number.isInteger(idx) || idx < 0 || idx >= pool.questions.length ||
        !Number.isInteger(chosen) || chosen < 0 || chosen > 3 ||
        seenIdx.has(idx) // reject duplicate questions in a single attempt
      ) {
        res.statusCode = 400;
        return res.end(JSON.stringify({
          error: "invalid_answer_entry",
          message: "Answer entries must be unique {idx, chosen} pairs within the pool.",
        }));
      }
      seenIdx.add(idx);
      const isCorrect = chosen === Number(pool.questions[idx].answer);
      correctFlags.push(isCorrect);
      if (isCorrect) correctCount++;
    }
    const passed = correctCount >= 4; // 4 of 5 to pass
    // If they didn't pass, return the result but don't record. Client
    // shows a "try again" screen.
    if (!passed) {
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        kind: "quiz_submit",
        passed: false,
        score: correctCount,
        total: 5,
        correct: correctFlags,
        attemptNum,
      }));
    }
    // Passed — fall through to the recordRead path below by transparently
    // rewriting the kind. The existing fraud + leaderboard + Caliper code
    // is the source of truth for held-XP / soft-flag / retake math, so
    // we route the validated pass through that pipeline instead of
    // re-implementing it here.
    body.kind = "read";
    body._serverValidatedQuizPass = {
      score: correctCount,
      total: 5,
      correct: correctFlags,
    };
    // Re-fall through; the kind === "read" handler below sees attemptNum
    // and treats this as a quiz pass (with our server-graded score).
  }

  if (body.kind !== "read" && kind !== "quiz_submit") {
    // Unknown kind — keep the strict-rejection behaviour for everything
    // that isn't open/start/profile/read/quiz_submit.
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_request" }));
  }
  if (!bookId) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "invalid_request" }));
  }

  // Reject manual `kind:"read"` for any book that has a quiz pool — the
  // only XP path for quiz-enabled books is `kind:"quiz_submit"` (server-
  // validated). This closes Agent 3's attack B (skip the quiz by posting
  // `kind:"read"` directly, which bypassed all fraud detection).
  // The kind === "quiz_submit" branch rewrites body.kind to "read" only
  // AFTER validating the answers, so legitimate quiz passes still flow
  // through this gate via the _serverValidatedQuizPass marker.
  if (
    body.kind === "read" &&
    bookId in QUIZ_BOOKS &&
    !body._serverValidatedQuizPass
  ) {
    res.statusCode = 400;
    return res.end(JSON.stringify({
      error: "quiz_required",
      message: "This book requires passing the quiz to earn XP. Open the quiz and submit your answers.",
    }));
  }

  const book = getBook(bookId);
  // Track-locking gate — refuse to record a read or quiz pass on a book
  // this student isn't allowed to see. Catches the path where an admin
  // locks a track mid-summer but the kid's client still has the locked
  // bookId in scope (e.g., from a stale `currentlyReading`). Mirrors the
  // same check in /api/quiz.js (line 843) and the kind:"start" branch
  // above. Admins bypass for QA access.
  if (book && !isBookTrackVisibleForUser(book, profile, session.email)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({
      error: "track_locked",
      message: "This book isn't available at your grade level.",
    }));
  }
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

    // 2d. "I'm reading this" → quiz gap (hard floor).
    //     The strongest direct signal: how long between clicking "I'm
    //     reading this" and submitting this quiz. Anything under 1 hour
    //     is auto-held for admin review — no kid can read a book and
    //     comprehend it well enough for a 5-question quiz in that window,
    //     even an emergent picture book. False positives go to manual
    //     review, not a leaderboard penalty.
    let recentStartStatus = "clean"; // "clean" | "hold"
    let recentStartDebug = null;
    try {
      const active = await getCurrentlyReading(session.email);
      if (active?.bookId === bookId && active?.startedAt) {
        const startedAt = Number(active.startedAt);
        const gap = now - startedAt;
        recentStartDebug = {
          startedAt,
          gapSec: Math.round(gap / 1000),
          gapMin: +(gap / 60000).toFixed(2),
        };
        if (gap >= 0 && gap < STARTED_RECENTLY_HOLD_MS) {
          recentStartStatus = "hold";
        }
      }
    } catch {
      /* missing currentlyReading data → don't synthesize a hold from absence */
    }

    // 2c. Combine the signals using a fair soft matrix:
    //       WCPM clean   + open clean         → clean
    //       WCPM clean   + open suspicious    → soft_flag (only 1 signal)
    //       WCPM soft    + open clean         → soft_flag (existing behavior)
    //       WCPM soft    + open suspicious    → held (both signals agree)
    //       WCPM hold    + (any)              → held (WCPM hold is strong)
    //       recent-start hold  (any other)    → held (1-hour floor, hard rule)
    //
    //     Net effect: a kid who already had the book at home is mostly
    //     protected — the WCPM check sees a reasonable gap because they
    //     read at a normal pace, and the first-open check by itself
    //     downgrades only to a soft flag, never an outright hold. The
    //     recent-start rule is the catch-all for the Andy case.
    let combined = "clean";
    if (recentStartStatus === "hold") {
      combined = "hold";
    } else if (wcpmStatus === "hold") {
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
        gapStartedToQuizSec: recentStartDebug?.gapSec ?? null,
        reason:
          recentStartStatus === "hold"
            ? "started_recently"  // <1 hour between "I'm reading" and quiz
            : wcpmStatus === "hold"
              ? "speed"
              : openStatus === "suspicious" && wcpmStatus === "soft"
                ? "speed_plus_recent_open"
                : "speed",
      });
      heldInfo = {
        // Surface the actual signal so the client can phrase the message
        // appropriately (and so the admin queue shows the right reason).
        reason: recentStartStatus === "hold" ? "started_recently" : "speed",
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
  // Evaluate achievements (#24). Skipped on held submissions because the
  // XP hasn't actually moved yet — we'd want to re-evaluate once admin
  // approves. Held re-evaluation happens in the admin approval path.
  // -----------------------------------------------------------------------
  if (result.recorded && fraudStatus !== "held") {
    try {
      // Reuse the profile we already loaded at the top of the handler
      // (for grade resolution). Same request, same value.
      const newAch = await evaluateAchievementsForUser(session.email, profile, {
        streakDays: Number(body.streakDays) || 0,
        justRead: { bookId },
      });
      if (newAch.length > 0) response.newAchievements = newAch;
    } catch (err) {
      console.warn("[achievements] eval failed", String(err?.message || err));
    }
  }

  // -----------------------------------------------------------------------
  // Clear currentlyReading if this quiz pass finished the active book.
  // Held submissions don't count (XP isn't awarded yet) — kid stays in
  // "currently reading" until they actually pass.
  // -----------------------------------------------------------------------
  if (attemptNum != null && result.recorded && fraudStatus !== "held") {
    try {
      const active = await getCurrentlyReading(session.email);
      if (active && active.bookId === bookId) {
        await clearCurrentlyReading(session.email);
        response.clearedCurrentlyReading = true;
      }
    } catch {
      /* non-fatal — leaving stale currentlyReading is just a stat issue */
    }
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
