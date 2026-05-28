// Conversational retell tutor (#9) — voice-only alternative to the MCQ quiz.
//
// SINGLE ENDPOINT with action routing — Vercel Hobby tier caps us at 12
// functions, so we keep all three tutor operations behind /api/tutor:
//
//   POST /api/tutor?action=start
//        body (JSON): { bookId }
//        → creates a Redis session, generates + TTS-synths the first
//          question, increments the daily attempt counter, returns the
//          session id + first tutor message + audio URL.
//
//   POST /api/tutor?action=turn&sessionId=...
//        body (binary): raw audio bytes (audio/webm, opus codec)
//        → stores the audio to Vercel Blob, transcribes via Whisper,
//          appends both kid's transcript and tutor's previous question
//          to the session, generates the next tutor message (or grades
//          if this was the final turn), returns the tutor's next
//          message + audio URL OR the grade verdict.
//
//   POST /api/tutor?action=grade&sessionId=...
//        body: empty
//        → manually triggers grading on an existing session. Used if
//          the client crashed mid-turn and the kid wants to claim credit
//          for what they already said. Normally grading happens
//          automatically when turnIndex hits TUTOR_QUESTION_COUNT.
//
// Routes through the same recordRead pipeline as the MCQ quiz when a
// session passes, so XP / leaderboard / Caliper events / held-XP queue
// all behave identically downstream.

import { verifySession, parseCookies, isAdmin } from "../lib/session.js";
import {
  redis,
  recordRead,
  recordQuizAttempt,
  QUIZ_DAILY_ATTEMPT_LIMIT,
  getCurrentlyReading,
  clearCurrentlyReading,
  evaluateAchievementsForUser,
  addHeldXpEntry,
  applyFraudFlag,
  guessGradeFromEmail,
  getReadingSession,
  clearReadingSession,
} from "../lib/store.js";
import { resolveVisibleTracks, trackForBook } from "../lib/tracks.js";
import { getBook } from "../lib/books.js";
import { normalizeGrade, pointsForBook, xpForReadingSession, outcomeCode } from "../lib/xp.js";
import { trackError, trackEvent } from "../lib/observability.js";
import {
  TUTOR_QUESTION_COUNT,
  hasOpenAI,
  createTutorSession,
  getTutorSession,
  saveTutorSession,
  buildFirstQuestion,
  buildClosingMessage,
  generateTutorNextMessage,
  transcribeAudio,
  moderateOnTopic,
  gradeConversation,
  storeTutorAudio,
  synthTutorTts,
} from "../lib/tutor.js";

// Hard cap on raw audio body to keep a buggy/malicious client from
// uploading a 10-minute file and burning our Whisper quota. 5 MB ≈
// ~5 min of opus webm at typical browser quality — far more than the
// 5-10 sec turns we expect.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Read raw binary body for the audio upload. Returns a Buffer or null
// on overflow. Streams in chunks so a giant payload doesn't OOM us.
async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

// Profile fetch with safe defaults — same shape as api/activity.js does.
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

function resolveGrade(profile, email) {
  if (profile?.grade) return normalizeGrade(profile.grade);
  return normalizeGrade(guessGradeFromEmail(email) || "K");
}

function resolveAgeGrade(profile, fallback) {
  if (profile?.ageGrade) return normalizeGrade(profile.ageGrade);
  return fallback;
}

// Track-locking gate — same logic as /api/quiz + /api/activity.
function bookVisibleForUser(book, profile, email) {
  if (isAdmin(email)) return true;
  const t = trackForBook(book);
  if (!t) return true; // defensive: unknown track → don't block
  const grade = resolveGrade(profile, email);
  const visible = resolveVisibleTracks(grade, profile?.trackOverrides || {});
  return visible.includes(t);
}

/* ================================================================== */
/* Handler                                                             */
/* ================================================================== */

export default async function handler(req, res) {
  // -------- Auth --------
  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) {
    return json(res, 401, { error: "unauthenticated" });
  }

  if (!hasOpenAI()) {
    return json(res, 503, {
      error: "tutor_not_configured",
      message: "Voice tutor isn't enabled yet. Try the regular quiz instead.",
    });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const action = url.searchParams.get("action");

  if (req.method !== "POST") {
    return json(res, 405, { error: "method_not_allowed" });
  }

  try {
    if (action === "start")  return await actionStart(req, res, session);
    if (action === "turn")   return await actionTurn(req, res, session, url);
    if (action === "grade")  return await actionGrade(req, res, session, url);
    return json(res, 400, { error: "unknown_action", action });
  } catch (err) {
    trackError("tutor_handler_failed", { action, err: String(err?.message || err) });
    return json(res, 500, {
      error: "tutor_failed",
      message: String(err?.message || err).slice(0, 300),
    });
  }
}

/* ------------------------------------------------------------------ */
/* action=start                                                        */
/* ------------------------------------------------------------------ */

async function actionStart(req, res, sessionAuth) {
  const body = await readJsonBody(req);
  if (body === null) return json(res, 400, { error: "invalid_json" });
  const bookId = String(body.bookId || "").trim();
  if (!bookId) return json(res, 400, { error: "bookId_required" });

  const book = getBook(bookId);
  if (!book) return json(res, 404, { error: "unknown_book", bookId });

  const profile = await loadProfile(sessionAuth.email);
  const workingGrade = resolveGrade(profile, sessionAuth.email);
  const ageGrade = resolveAgeGrade(profile, workingGrade);

  // Track-locking — refuse if the kid isn't allowed to see this book.
  if (!bookVisibleForUser(book, profile, sessionAuth.email)) {
    return json(res, 403, {
      error: "track_locked",
      message: "This book isn't available at your grade level.",
    });
  }

  // CurrentlyReading enforcement — same gate as /api/quiz. Kid must
  // have declared they're reading THIS book before they can take the
  // tutor for it. Prevents tutor-hopping across books they haven't
  // claimed to be working on.
  const active = await getCurrentlyReading(sessionAuth.email);
  if (!active || active.bookId !== bookId) {
    return json(res, 403, {
      error: "not_currently_reading",
      bookId,
      message:
        "Tap \"I'm reading this\" on the book first so we know it's the one you're working on.",
    });
  }

  // Daily attempt counter (#40) — the tutor shares the same budget as
  // the MCQ quiz, so a kid can't bypass the cap by switching modes.
  const attemptCount = await recordQuizAttempt(sessionAuth.email, bookId);
  if (attemptCount != null && attemptCount > QUIZ_DAILY_ATTEMPT_LIMIT) {
    trackEvent("tutor_attempt_blocked", { bookId, attempt: attemptCount });
    return json(res, 429, {
      error: "too_many_attempts",
      message:
        "You've used your attempts for this book today. Come back tomorrow and try again!",
      attempt: attemptCount,
      limit: QUIZ_DAILY_ATTEMPT_LIMIT,
    });
  }

  // Voice preference — fall back to profile preferredVoiceId, then default.
  const voiceId = profile?.preferredVoiceId || null;

  const tutorSession = await createTutorSession({
    email: sessionAuth.email,
    bookId,
    ageGrade,
    workingGrade,
    voiceId,
  });

  const firstQuestion = buildFirstQuestion(book);

  // Synth TTS audio for the first message. Cached per-book by the
  // (voice, text) key in lib/tts.js so subsequent kids hit the same blob.
  let firstAudioUrl = null;
  try {
    const tts = await synthTutorTts(firstQuestion, tutorSession.voiceId);
    firstAudioUrl = tts.url;
  } catch (err) {
    trackError("tutor_tts_failed", { stage: "start", err: String(err?.message || err) });
    // Non-fatal — client can fall back to browser SpeechSynthesis.
  }

  tutorSession.transcript.push({
    role: "tutor",
    text: firstQuestion,
    ts: Date.now(),
  });
  await saveTutorSession(tutorSession);

  trackEvent("tutor_started", { bookId, attemptCount: attemptCount || 1 });

  return json(res, 200, {
    ok: true,
    sessionId: tutorSession.sessionId,
    bookId,
    bookTitle: book.title,
    turnIndex: tutorSession.turnIndex, // 0 — no student response yet
    questionCount: TUTOR_QUESTION_COUNT,
    tutorMessage: firstQuestion,
    tutorAudioUrl: firstAudioUrl,
    voiceId: tutorSession.voiceId,
    done: false,
  });
}

/* ------------------------------------------------------------------ */
/* action=turn                                                         */
/* ------------------------------------------------------------------ */

async function actionTurn(req, res, sessionAuth, url) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return json(res, 400, { error: "sessionId_required" });

  const tutorSession = await getTutorSession(sessionId);
  if (!tutorSession) return json(res, 404, { error: "session_not_found_or_expired" });

  // Ownership check — a kid can't post audio into someone else's session.
  if (tutorSession.email !== String(sessionAuth.email).toLowerCase()) {
    return json(res, 403, { error: "session_not_yours" });
  }
  if (tutorSession.graded) {
    return json(res, 409, { error: "session_already_graded" });
  }

  const book = getBook(tutorSession.bookId);
  if (!book) return json(res, 404, { error: "unknown_book" });

  // Read the audio blob from the raw request body.
  const audioBytes = await readRawBody(req, MAX_AUDIO_BYTES);
  if (audioBytes === null) {
    return json(res, 413, {
      error: "audio_too_large",
      maxBytes: MAX_AUDIO_BYTES,
    });
  }
  if (!audioBytes || audioBytes.length === 0) {
    return json(res, 400, { error: "audio_required" });
  }

  // Store the audio first (so even if Whisper later fails, we have the
  // file for admin review). Failures here are non-fatal.
  let audioUrl = null;
  try {
    audioUrl = await storeTutorAudio({
      sessionId: tutorSession.sessionId,
      turnIndex: tutorSession.turnIndex + 1,
      audioBytes,
    });
  } catch (err) {
    trackError("tutor_audio_store_failed", { err: String(err?.message || err) });
  }

  // Transcribe via Whisper.
  let transcript = "";
  try {
    transcript = await transcribeAudio(audioBytes, "turn.webm");
  } catch (err) {
    trackError("tutor_whisper_failed", { err: String(err?.message || err) });
    // Couldn't transcribe — ask the kid to repeat. Don't advance the turn.
    let retryAudioUrl = null;
    try {
      const tts = await synthTutorTts(
        "Oops, I didn't quite catch that. Can you say that again?",
        tutorSession.voiceId
      );
      retryAudioUrl = tts.url;
    } catch {}
    return json(res, 200, {
      ok: true,
      sessionId: tutorSession.sessionId,
      turnIndex: tutorSession.turnIndex,
      tutorMessage: "Oops, I didn't quite catch that. Can you say that again?",
      tutorAudioUrl: retryAudioUrl,
      retry: true,
      done: false,
    });
  }

  // Topic moderation. Off-topic responses count as a turn but the tutor
  // gently redirects rather than asking a new question.
  const moderation = await moderateOnTopic({ book, studentText: transcript });

  // Append the student's transcript + audio URL to the session.
  tutorSession.turnIndex += 1;
  tutorSession.transcript.push({
    role: "student",
    text: transcript,
    audioUrl,
    onTopic: moderation.onTopic,
    ts: Date.now(),
  });
  if (audioUrl) tutorSession.audioUrls.push(audioUrl);

  // Decide what happens next based on turn count.
  // - If kid has answered fewer than TUTOR_QUESTION_COUNT questions: ask the next one.
  // - If they've answered all questions: send closing message + grade.
  const isFinalTurn = tutorSession.turnIndex >= TUTOR_QUESTION_COUNT;

  if (!isFinalTurn) {
    // Generate the next tutor message based on the full conversation.
    let nextMessage;
    try {
      nextMessage = await generateTutorNextMessage({
        book,
        ageGrade: tutorSession.ageGrade,
        transcript: tutorSession.transcript,
      });
    } catch (err) {
      trackError("tutor_next_message_failed", { err: String(err?.message || err) });
      nextMessage = "Can you tell me more about the book?";
    }
    // Synth TTS for the new tutor message.
    let nextAudioUrl = null;
    try {
      const tts = await synthTutorTts(nextMessage, tutorSession.voiceId);
      nextAudioUrl = tts.url;
    } catch (err) {
      trackError("tutor_tts_failed", { stage: "turn", err: String(err?.message || err) });
    }
    tutorSession.transcript.push({
      role: "tutor",
      text: nextMessage,
      ts: Date.now(),
    });
    await saveTutorSession(tutorSession);
    return json(res, 200, {
      ok: true,
      sessionId: tutorSession.sessionId,
      turnIndex: tutorSession.turnIndex,
      studentTranscript: transcript,
      tutorMessage: nextMessage,
      tutorAudioUrl: nextAudioUrl,
      done: false,
    });
  }

  // Final turn — grade the conversation and route to recordRead.
  return await finalizeAndGrade(res, tutorSession, book);
}

/* ------------------------------------------------------------------ */
/* action=grade                                                        */
/* ------------------------------------------------------------------ */

async function actionGrade(req, res, sessionAuth, url) {
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return json(res, 400, { error: "sessionId_required" });
  const tutorSession = await getTutorSession(sessionId);
  if (!tutorSession) return json(res, 404, { error: "session_not_found_or_expired" });
  if (tutorSession.email !== String(sessionAuth.email).toLowerCase()) {
    return json(res, 403, { error: "session_not_yours" });
  }
  if (tutorSession.graded) {
    return json(res, 200, {
      ok: true,
      sessionId,
      graded: true,
      already: true,
      gradeResult: tutorSession.gradeResult,
    });
  }
  const book = getBook(tutorSession.bookId);
  if (!book) return json(res, 404, { error: "unknown_book" });
  return await finalizeAndGrade(res, tutorSession, book);
}

/* ------------------------------------------------------------------ */
/* Grading + recordRead routing                                        */
/* ------------------------------------------------------------------ */

async function finalizeAndGrade(res, tutorSession, book) {
  const email = tutorSession.email;

  // Grade the retell conversation via the LLM rubric.
  let grade;
  try {
    grade = await gradeConversation({
      book,
      ageGrade: tutorSession.ageGrade,
      transcript: tutorSession.transcript,
    });
  } catch (err) {
    trackError("tutor_grade_failed", { err: String(err?.message || err) });
    grade = {
      retell_quality: 0,
      character_recall: 0,
      event_recall: 0,
      stayed_on_topic: 0,
      overall_pass: null,
      feedback: "We're having trouble grading right now. We'll check this and get back to you!",
    };
  }

  tutorSession.graded = true;
  tutorSession.gradeResult = grade;

  // Closing message (regardless of pass/fail) — kid gets a warm sign-off.
  const closing = buildClosingMessage(book);
  let closingAudioUrl = null;
  try {
    const tts = await synthTutorTts(closing, tutorSession.voiceId);
    closingAudioUrl = tts.url;
  } catch {}
  tutorSession.transcript.push({
    role: "tutor",
    text: closing,
    ts: Date.now(),
  });
  await saveTutorSession(tutorSession);

  // #9 atomic award — read the quiz outcome from the reading session
  // stored by api/activity.js quiz_submit. If missing (session expired
  // or quiz never submitted on this device), treat as "quiz failed"
  // so the kid still earns the retell-only ratio if their retell
  // passes. retellRequired=true on quiz_submit means a happy-path kid
  // should always have a reading session present when we land here.
  const readingSession = await getReadingSession(email, tutorSession.bookId);
  const quizOutcome = readingSession?.quizOutcome || "fF";
  const quizAttempt = readingSession?.quizAttempt || 2;

  // Map LLM grader verdict → retell outcome code.
  //   grader pass=true  → retell pass on this attempt (p1 or p2)
  //   grader pass=false → retell fail this attempt (could be p2 if att 2)
  //   grader pass=null  → defer to admin review (treat as held; still
  //                       compute XP as if pass for the user response,
  //                       but mark held so XP goes to the queue not the
  //                       leaderboard).
  // Server uses the per-(email,bookId) attempt counter to know what
  // retell attempt this was — for now we infer from tutorSession.
  // TODO: retell-specific attempt counter is a follow-up; v1 counts
  // any reaching of finalize as attempt 1.
  const retellAttempt = 1; // v1 — single retell attempt per session
  const retellPassed = grade.overall_pass === true;
  const retellOutcome = retellPassed
    ? outcomeCode(true, retellAttempt)
    : "fF";
  const retellHeld = grade.overall_pass === null;

  // Compute combined XP using the ratio table.
  const xpCalc = xpForReadingSession({
    wordCount: book.wordCount,
    workingGrade: tutorSession.workingGrade,
    quizOutcome,
    retellOutcome,
    emergent: book.quizStyle === "emergent",
  });

  let response = {
    ok: true,
    sessionId: tutorSession.sessionId,
    bookId: tutorSession.bookId,
    bookTitle: book.title,
    done: true,
    graded: true,
    gradeResult: grade,
    tutorMessage: closing,
    tutorAudioUrl: closingAudioUrl,
    quizOutcome,
    retellOutcome,
    xpBreakdown: {
      readingMin: xpCalc.readingMin,
      quizMin: xpCalc.quizMin,
      retellMin: xpCalc.retellMin,
      totalMin: xpCalc.totalMin,
      ratio: xpCalc.ratio,
      outcomeKey: xpCalc.outcomeKey,
      xp: xpCalc.xp,
    },
  };

  if (retellHeld) {
    // LLM grader was unsure — hold the XP for admin review even if the
    // ratio says non-zero. Quiz outcome still counts in the audit trail.
    try {
      const flagResult = await applyFraudFlag(email);
      const heldResult = await addHeldXpEntry({
        email,
        name: tutorSession.email.split("@")[0],
        bookId: tutorSession.bookId,
        bookTitle: book.title || tutorSession.bookId,
        grade: tutorSession.workingGrade,
        points: xpCalc.xp,
        reason: "tutor_review",
        tutorRubric: grade,
        tutorTranscript: tutorSession.transcript,
        tutorAudioUrls: tutorSession.audioUrls,
        quizOutcome,
      });
      response.held = true;
      response.heldInfo = {
        reason: "tutor_review",
        cooldownUntil: flagResult.cooldownUntil,
        flagCount: flagResult.flagCount,
        heldId: heldResult.id || null,
      };
    } catch (err) {
      trackError("tutor_held_xp_failed", { err: String(err?.message || err) });
    }
    trackEvent("tutor_held", { bookId: tutorSession.bookId });
  } else if (xpCalc.xp > 0) {
    // Atomic award — single recordRead call routes through the same
    // leaderboard/dedupe/Caliper pipeline as the legacy quiz path.
    const result = await recordRead({
      email,
      name: tutorSession.email.split("@")[0],
      grade: tutorSession.workingGrade,
      bookId: tutorSession.bookId,
      points: xpCalc.xp,
    });
    response.passed = retellPassed;
    response.recorded = result.recorded;
    response.points = result.points || 0;
    response.reason = result.reason || null;
    if (result.recorded) {
      try {
        const profile = await loadProfile(email);
        const newAch = await evaluateAchievementsForUser(email, profile, {
          justRead: { bookId: tutorSession.bookId },
        });
        if (newAch.length > 0) response.newAchievements = newAch;
      } catch (err) {
        trackError("tutor_achievement_eval_failed", { err: String(err?.message || err) });
      }
      try {
        const active = await getCurrentlyReading(email);
        if (active && active.bookId === tutorSession.bookId) {
          await clearCurrentlyReading(email);
          response.clearedCurrentlyReading = true;
        }
      } catch {}
    }
    trackEvent("tutor_session_awarded", {
      bookId: tutorSession.bookId,
      quizOutcome,
      retellOutcome,
      xp: result.points,
    });
  } else {
    // Total XP is zero (both halves failed). No leaderboard write, no
    // currentlyReading clear (kid may still want to switch books).
    response.passed = false;
    response.points = 0;
    trackEvent("tutor_session_zero", {
      bookId: tutorSession.bookId,
      quizOutcome,
      retellOutcome,
    });
  }

  // Clear the reading-session record either way — atomic award succeeded
  // or the kid bottomed out at 0 XP. New session needed for next attempt.
  await clearReadingSession(email, tutorSession.bookId);

  return json(res, 200, response);
}
