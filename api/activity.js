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

import { verifySession, parseCookies, isAdmin, displayName, isTombstoned, verifyQuizAnswer, isHardcodedBypassQuizHolds } from "../lib/session.js";
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
  recordQuizAttempt,
  consumeQuizOpens,
  setReadingSessionQuizOutcome,
  redis,
  FRAUD_RATIO_HOLD,
  FRAUD_RATIO_SOFT,
  FRAUD_FRESHNESS_WINDOW_MS,
  FIRST_OPEN_SUSPICION_HOURS,
  STARTED_RECENTLY_HOLD_MS,
  startedRecentlyHoldMsForGrade,
  QUIZ_DAILY_ATTEMPT_LIMIT,
  isBypassQuizHoldsActive,
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
import { trackError, trackEvent } from "../lib/observability.js";
import { classifyComment } from "../lib/moderation.js";
import { holdComment } from "../lib/store.js";
import { checkRateLimit, send429, LIMITS } from "../lib/rate-limit.js";

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

// Age grade is OPTIONAL — TimeBack supplies it via the working-grade
// sync cron. When missing, fall back to the working grade so the
// quiz-pool cache key matches what /api/quiz wrote on the fetch side.
// Without this resolver, getCachedQuizPool was reading from the
// wrong key for any kid whose ageGrade differs from workingGrade
// (Carl Hendrick: workingGrade=K, ageGrade=2 → 0/5 grading bug).
function resolveAgeGradeServerSide(profile, fallbackGrade) {
  if (profile && profile.ageGrade) return normalizeGrade(profile.ageGrade);
  return fallbackGrade;
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

  // #82 per-email rate limit. Activity covers reads, votes, comments,
  // open events, fraud flag writes — high-volume but cheap. Cap is
  // generous (180/min ≈ 3/sec) but blocks an automated flood.
  {
    const rl = await checkRateLimit({
      email: session.email, bucket: "activity",
      max: LIMITS.activity.max, windowSec: LIMITS.activity.windowSec,
    });
    if (!rl.ok) return send429(res, rl);
  }

  // #19 audit follow-up: reject writes for tombstoned (just-deleted)
  // emails so a concurrent in-flight tab can't re-create per-user keys
  // milliseconds after /api/auth/me?action=delete completes.
  if (await isTombstoned(session.email)) {
    res.statusCode = 410; // Gone
    return res.end(JSON.stringify({ error: "account_deleted" }));
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
  // Age grade for the quiz-pool cache lookup (#79). Must match the
  // resolution chain in /api/quiz so reader + writer hit the same key.
  const ageGrade = resolveAgeGradeServerSide(profile, grade);
  // attemptNum: 1 or 2 (present for quiz passes, absent for manual reads).
  // `let` rather than const because the quiz_submit branch (#40) overrides
  // it with the server-authoritative count from recordQuizAttempt — the
  // client value is a hint, the server count is the source of truth.
  let attemptNum =
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

  // ============================================================
  // kind === "comment" — three-tier moderation pipeline (task #31).
  // Body: { kind: "comment", bookId, text }
  // Returns one of:
  //   { ok: true,  verdict: "allow" }            ← client publishes
  //   { ok: true,  verdict: "review", message }  ← client saves with
  //                                                pending badge; admin
  //                                                reviews via the held
  //                                                comments queue
  //   { ok: false, verdict: "block",  message }  ← client shows message,
  //                                                doesn't save
  //
  // The comment storage itself stays client-local for now (no socialized
  // comment feed yet). When that ships, route "allow" verdicts into
  // comments:approved:{bookId} so other kids can see them.
  // ============================================================
  if (kind === "comment") {
    const text = String(body.text || "").trim();
    if (!bookId || !text) {
      return res.end(JSON.stringify({
        ok: false, verdict: "block",
        reason: "invalid_request",
        message: "Missing book or text.",
      }));
    }
    const verdict = classifyComment(text);
    trackEvent("comment_classified", { verdict: verdict.verdict, reason: verdict.reason });
    if (verdict.verdict === "block") {
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: false,
        verdict: "block",
        reason: verdict.reason,
        message: verdict.message,
      }));
    }
    if (verdict.verdict === "review") {
      // Queue for admin review. Failure to queue is non-fatal — the
      // client still sees the friendly message and saves with pending.
      try {
        await holdComment({
          email: session.email,
          // #47 — redact at write. Full name only flows through the
          // session cookie; comments queue stores the peer-facing
          // "First L." form so any moderation UI that surfaces this
          // queue can't accidentally leak the last name. Admins who
          // need full-name attribution can dereference via the email
          // field (admin-only path).
          name: displayName(session.name || session.email.split("@")[0]),
          bookId,
          text,
          reason: verdict.reason,
        });
      } catch (err) {
        await trackError("comment_hold_failed", err, { bookId });
      }
      res.statusCode = 200;
      return res.end(JSON.stringify({
        ok: true,
        verdict: "review",
        reason: verdict.reason,
        message: verdict.message,
      }));
    }
    // allow — publish (client-side for now)
    res.statusCode = 200;
    return res.end(JSON.stringify({ ok: true, verdict: "allow" }));
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
    // #40: server-authoritative attempt counter. Previously the client sent
    // `attemptNum` from localStorage, so a kid could clear storage between
    // failed attempts and reset to attemptNum=1 (= full XP, no retake
    // multiplier). INCR before grading so a refusal counts toward the cap
    // — keeping retry attempts cheap to detect. After QUIZ_DAILY_ATTEMPT_LIMIT
    // attempts in a 72h rolling window we 429 and ask them to come back
    // tomorrow. Redis-down case: serverAttempt is null → fall back to the
    // client-supplied attemptNum so we degrade gracefully.
    //
    // Admin bypass: admins are testing the flow repeatedly and cannot be
    // gated by a per-book attempt limit. INCR is skipped entirely so
    // their attempts don't pollute the counter either.
    const isAdminUser = isAdmin(session.email);
    const serverAttempt = isAdminUser
      ? attemptNum // trust the client value for admin (no INCR side effect)
      : await recordQuizAttempt(session.email, bookId);
    if (!isAdminUser && serverAttempt != null && serverAttempt > QUIZ_DAILY_ATTEMPT_LIMIT) {
      trackEvent("quiz_attempt_blocked", { bookId, attempt: serverAttempt });
      res.statusCode = 429;
      return res.end(JSON.stringify({
        error: "too_many_attempts",
        message: "You've used your attempts for this book today. Come back tomorrow and try again!",
        attempt: serverAttempt,
        limit: QUIZ_DAILY_ATTEMPT_LIMIT,
      }));
    }
    // Override the client-supplied attemptNum with the server count
    // (clamped to 2 because downstream code only branches on === 2 for
    // the retake multiplier). This makes the localStorage-wipe exploit
    // a no-op — a kid resetting client state still sees their 2nd attempt
    // counted as a retake (50%-equivalent XP via RETAKE_MULTIPLIER).
    if (serverAttempt != null) {
      attemptNum = Math.min(2, Math.max(1, serverAttempt));
    }
    // Client posts `answers: [{ idx, chosen, qText, answerToken }, ...]`.
    // `idx` is the position in the kid's slate (0-4, just for dedup).
    // `chosen` is the kid's tapped option ORIGINAL index (0-3).
    // `qText` + `answerToken` are the HMAC-signed payload from /api/quiz.
    //
    // Grading is now self-contained — server recomputes
    // signQuizAnswer(bookId, qText, chosen) and compares to the
    // submitted answerToken. If they match, the kid picked the correct
    // option (because the token's HMAC encoded the correct idx at
    // generation time). NO Redis cache lookup needed at grade time —
    // schema bumps, cache expiry, redeploy timing can't break grading
    // anymore.
    //
    // We still fetch the cached pool as a SOFT compatibility path for
    // older clients that don't yet have answerToken in their saved
    // localStorage; if neither path works, we 409 as before.
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (answers.length !== 5) {
      res.statusCode = 400;
      return res.end(JSON.stringify({
        error: "invalid_answers",
        message: "Need exactly 5 answers.",
      }));
    }
    // A token must be a NON-EMPTY string. An empty answerToken ("") still
    // passes `typeof === "string"`, so without the length guard the HMAC
    // path would run with a blank token and verifyQuizAnswer would fail
    // every answer → a silent 0/5. Requiring length>0 means a blank-token
    // submission instead falls to the legacy cache path (or a clean 409),
    // never a misleading all-wrong score.
    const useTokenGrading = answers.every(
      (a) => typeof a?.qText === "string" && a.qText.length > 0 &&
             typeof a?.answerToken === "string" && a.answerToken.length > 0
    );
    let pool = null;
    if (!useTokenGrading) {
      // Legacy client — fall back to the cache-pool lookup.
      pool = await getCachedQuizPool(bookId, grade, ageGrade);
      if (!pool || !Array.isArray(pool.questions) || pool.questions.length < 5) {
        res.statusCode = 409;
        return res.end(JSON.stringify({
          error: "no_quiz_pool",
          message: "Couldn't find the quiz for this book. Reopen the quiz and try again.",
        }));
      }
    }
    // Grade each answer.
    let correctCount = 0;
    const correctFlags = [];
    const seen = new Set();
    const adminDebug = isAdminUser ? [] : null;
    for (const a of answers) {
      const chosen = Number(a?.chosen);
      if (!Number.isInteger(chosen) || chosen < 0 || chosen > 3) {
        res.statusCode = 400;
        return res.end(JSON.stringify({
          error: "invalid_answer_entry",
          message: "Each answer needs a chosen index between 0 and 3.",
        }));
      }
      let isCorrect = false;
      let qPreview = "";
      let expectedDebug = null;
      if (useTokenGrading) {
        const qText = String(a.qText || "");
        const token = String(a.answerToken || "");
        // Dedup on qText so a kid can't game it by re-submitting the
        // same question's answer with multiple chosen values.
        const dedupKey = qText.slice(0, 200);
        if (seen.has(dedupKey)) {
          res.statusCode = 400;
          return res.end(JSON.stringify({
            error: "invalid_answer_entry",
            message: "Answer entries must be for unique questions.",
          }));
        }
        seen.add(dedupKey);
        // #16 — verify against the email-bound, daily-expiring token.
        isCorrect = await verifyQuizAnswer(bookId, qText, chosen, token, {
          email: session.email,
        });
        qPreview = qText.slice(0, 60);
      } else {
        // Legacy cache-pool path.
        const idx = Number(a?.idx);
        if (
          !Number.isInteger(idx) || idx < 0 || idx >= pool.questions.length ||
          seen.has(idx)
        ) {
          res.statusCode = 400;
          return res.end(JSON.stringify({
            error: "invalid_answer_entry",
            message: "Answer entries must be unique {idx, chosen} pairs within the pool.",
          }));
        }
        seen.add(idx);
        const expected = Number(pool.questions[idx].answer);
        isCorrect = chosen === expected;
        qPreview = pool.questions[idx]?.q?.slice(0, 60) || "";
        expectedDebug = expected;
      }
      correctFlags.push(isCorrect);
      if (isCorrect) correctCount++;
      if (adminDebug) {
        adminDebug.push({
          chosen,
          isCorrect,
          gradedVia: useTokenGrading ? "hmac" : "cache",
          ...(expectedDebug != null && { expected: expectedDebug }),
          q: qPreview,
        });
      }
    }
    const passed = correctCount >= 4; // 4 of 5 to pass
    // #9 atomic session — quiz_submit no longer awards XP directly.
    // The kid MUST complete the follow-up retell for XP to release.
    // We persist the quiz outcome (pass/fail + attempt number) to a
    // per-(email,bookId) reading session with 30-min TTL; api/tutor.js
    // reads it back at the end of the retell and awards combined XP
    // via the ratio table in lib/xp.js.
    //
    // If the kid never starts the retell, the session expires and they
    // get 0 XP — matching the "complete the whole section" rule.
    const quizOutcome = passed ? (attemptNum === 2 ? "p2" : "p1") : "fF";
    try {
      await setReadingSessionQuizOutcome({
        email: session.email,
        bookId,
        quizOutcome,
        quizAttempt: attemptNum,
      });
    } catch (err) {
      trackError("quiz_submit_session_save_failed", {
        bookId,
        err: String(err?.message || err),
      });
      // Non-fatal — the client still launches retell; if session is
      // missing at finalize time, tutor.js falls back to quizOutcome="fF".
    }

    trackEvent("quiz_submit_recorded", { bookId, passed, attemptNum });

    res.statusCode = 200;
    return res.end(JSON.stringify({
      ok: true,
      kind: "quiz_submit",
      passed,
      score: correctCount,
      total: 5,
      correct: correctFlags,
      attemptNum,
      // Tells the client to launch the retell modal immediately.
      // XP isn't awarded yet — it releases atomically after retell
      // finishes via /api/tutor.
      retellRequired: true,
      bookId,
      quizOutcome,
      // Admin-only breakdown for debugging "I got 0/5 with all correct"
      // type reports. Shows the chosen/expected indices and the question
      // text snippet per answer. Stripped for non-admin responses.
      ...(adminDebug ? { adminDebug } : {}),
    }));
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
        // Per-book threshold (#21 v2): PK/K → 15min, G1 → 30min, G2+ → 60min.
        // Falls back to the default if the book lookup didn't return one.
        const gradeFloorMs = book
          ? startedRecentlyHoldMsForGrade(book.grade)
          : STARTED_RECENTLY_HOLD_MS;
        // #28 — cap the floor by the book's expected reading time so a
        // genuinely fast emergent reader on a SHORT book isn't held. A
        // 200-word PK book takes ~7-13 min, so a flat 15-min floor
        // punishes a kid who legitimately finished in 10. The hold now
        // fires only if they finished in under HALF the expected
        // reading time (the "couldn't plausibly have read it" zone),
        // with a 2-min absolute floor to still catch instant
        // click-through, and never exceeding the grade floor (so long
        // books are unchanged).
        let holdMs = gradeFloorMs;
        if (book && book.wordCount > 0) {
          const wcpm = WCPM_BY_GRADE[normalizeGrade(grade)] || WCPM_BY_GRADE.K;
          const expectedReadMs = (book.wordCount / wcpm) * 60_000;
          const readBasedMs = Math.max(2 * 60_000, expectedReadMs * 0.5);
          holdMs = Math.min(gradeFloorMs, readBasedMs);
        }
        recentStartDebug.holdMs = holdMs;
        recentStartDebug.holdMin = +(holdMs / 60000).toFixed(2);
        recentStartDebug.gradeFloorMin = +(gradeFloorMs / 60000).toFixed(2);
        if (gap >= 0 && gap < holdMs) {
          recentStartStatus = "hold";
        }
      }
    } catch {
      /* missing currentlyReading data → don't synthesize a hold from absence */
    }

    // 2e. Quiz-open count (#41). consumeQuizOpens reads + DELs the per-
    //     (email,bookId) hash that /api/quiz writes to on every fetch.
    //     count >= 6 reopens since last submit looks like lookup behavior
    //     (peek the questions, close, look up answers, come back). count
    //     of 3-5 is a softer signal (might be browser-back / refresh).
    //     count of 0 means we have no telemetry — don't synthesize fraud
    //     from missing data.
    let openCountStatus = "clean"; // "clean" | "suspicious" | "hold"
    let openCountDebug = null;
    try {
      const opens = await consumeQuizOpens(session.email, bookId);
      openCountDebug = { opens: opens.count, firstAt: opens.firstAt };
      if (opens.count >= 6) {
        openCountStatus = "hold";
      } else if (opens.count >= 3) {
        openCountStatus = "suspicious";
      }
    } catch {
      /* missing open data → don't synthesize fraud from absence */
    }

    // #97 — Per-user bypass of time-based holds. If the profile has
    // bypassQuizHolds=true, neuter the started-recently and WCPM
    // verdicts to "clean" BEFORE the combine matrix runs. We leave
    // openCountStatus untouched so the reopen-pattern lookup
    // detector still applies (this is the "QA tester or fast reader,
    // not a free pass" use case). Debug objects are preserved so the
    // admin can still see WHAT the underlying gap was.
    if (isBypassQuizHoldsActive(profile) || isHardcodedBypassQuizHolds(session.email)) {
      if (recentStartDebug) recentStartDebug.bypassed = true;
      if (wcpmDebug) wcpmDebug.bypassed = true;
      recentStartStatus = "clean";
      wcpmStatus = "clean";
    }

    // 2c. Combine the signals using a fair soft matrix:
    //       WCPM clean   + open clean         → clean
    //       WCPM clean   + open suspicious    → soft_flag (only 1 signal)
    //       WCPM soft    + open clean         → soft_flag (existing behavior)
    //       WCPM soft    + open suspicious    → held (both signals agree)
    //       WCPM hold    + (any)              → held (WCPM hold is strong)
    //       recent-start hold  (any other)    → held (per-book floor, hard rule)
    //       openCount    hold                 → held (6+ reopens = lookup pattern)
    //       openCount    suspicious           → folds into the soft tally
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
    } else if (openCountStatus === "hold") {
      combined = "hold";
    } else if (
      wcpmStatus === "soft" &&
      (openStatus === "suspicious" || openCountStatus === "suspicious")
    ) {
      combined = "hold";
    } else if (
      wcpmStatus === "soft" ||
      openStatus === "suspicious" ||
      openCountStatus === "suspicious"
    ) {
      combined = "soft";
    }

    if (combined === "hold") {
      fraudStatus = "held";
      // Observability — track every held submission so a spike is visible
      // in the admin dashboard before a parent complains.
      // Pick the dominant reason for telemetry / admin queue display.
      const heldReason =
        recentStartStatus === "hold" ? "started_recently"
        : openCountStatus === "hold" ? "quiz_reopen_pattern"
        : wcpmStatus === "hold" ? "speed"
        : openStatus === "suspicious" && wcpmStatus === "soft" ? "speed_plus_recent_open"
        : wcpmStatus === "soft" && openCountStatus === "suspicious" ? "speed_plus_reopens"
        : "speed";
      trackEvent("fraud_held", { reason: heldReason });
      const flagResult = await applyFraudFlag(session.email);
      const heldResult = await addHeldXpEntry({
        email: session.email,
        // #35 — store the redacted display name, not the raw email
        // local-part. The full email is kept in the `email` field for
        // admin identification; the name field shouldn't duplicate raw
        // PII. Consistent with the quiz_submit comment path above.
        name: displayName(session.name || session.email),
        bookId,
        bookTitle: book.title || bookId,
        grade,
        points: basePoints, // full points — admin can choose to approve all
        suspicionRatio: wcpmDebug?.ratio ?? null,
        elapsedMins: wcpmDebug?.elapsedMins ?? null,
        minExpectedMins: wcpmDebug?.minExpectedMins ?? null,
        hoursSinceOpen: openDebug?.hoursSinceOpen ?? null,
        gapStartedToQuizSec: recentStartDebug?.gapSec ?? null,
        quizOpenCount: openCountDebug?.opens ?? null,
        reason: heldReason,
      });
      heldInfo = {
        // Surface the actual signal so the client can phrase the message
        // appropriately (and so the admin queue shows the right reason).
        reason: heldReason,
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

  // CRITICAL FIX (#36 — Agent 7 round 2 Blocker #1): when this read came
  // via kind:"quiz_submit" → server-validated pass, the response MUST
  // include passed/score/total/correct so the client renders the
  // success screen. Without these the client falls into the "Almost
  // there!" failure branch and rolls back the optimistic localStorage
  // write — even though the server recorded the read and awarded XP.
  // Every kid passing a quiz was silently broken until this landed.
  if (body._serverValidatedQuizPass) {
    response.passed = true;
    response.score = body._serverValidatedQuizPass.score;
    response.total = body._serverValidatedQuizPass.total;
    response.correct = body._serverValidatedQuizPass.correct;
  }

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
      trackError("caliper_emit_failed", err, { bookId });
    }
  }

  res.statusCode = 200;
  return res.end(JSON.stringify(response));
}
