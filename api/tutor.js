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
  appendRetellLog,
} from "../lib/store.js";
import { resolveVisibleTracks, trackForBook } from "../lib/tracks.js";
import { getBook } from "../lib/books.js";
import { normalizeGrade, pointsForBook, xpForReadingSession, outcomeCode } from "../lib/xp.js";
import { trackError, trackEvent } from "../lib/observability.js";
import { checkRateLimit, send429, LIMITS } from "../lib/rate-limit.js";
import {
  TUTOR_QUESTION_COUNT,
  TUTOR_PASS_SCORE,
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
  previewGradeFirstTurn,
  totalRubricScore,
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

  // #82 per-email rate limit. The retell uses OpenAI for transcription
  // + LLM follow-ups — the most expensive per-call route in the app.
  // Tight cap so a compromised account can't grind it.
  {
    const rl = await checkRateLimit({
      email: session.email, bucket: "tutor",
      max: LIMITS.tutor.max, windowSec: LIMITS.tutor.windowSec,
    });
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.retryAfter));
      return json(res, 429, {
        error: "rate_limited", retryAfter: rl.retryAfter, limit: rl.max,
      });
    }
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

  // Eligibility gate — kid must be either:
  //   a) actively currently-reading this book (the standard path), OR
  //   b) auto-flowing from a quiz they just submitted on this book
  //      (i.e., a reading session exists with a quizOutcome already
  //      recorded). Required because /api/activity quiz_submit clears
  //      currentlyReading in some flows, and we don't want to force
  //      the kid to re-declare a book they just answered 5 Qs about.
  // Admins always pass — they're the ones testing.
  const active = await getCurrentlyReading(sessionAuth.email);
  const matchesActive = active && active.bookId === bookId;
  let matchesRecentQuiz = false;
  if (!matchesActive && !isAdmin(sessionAuth.email)) {
    try {
      const readSess = await getReadingSession(sessionAuth.email, bookId);
      matchesRecentQuiz = !!(readSess && readSess.quizOutcome);
    } catch {}
  }
  if (!matchesActive && !matchesRecentQuiz && !isAdmin(sessionAuth.email)) {
    return json(res, 403, {
      error: "not_currently_reading",
      bookId,
      message:
        "Tap \"I'm reading this\" on the book first so we know it's the one you're working on.",
    });
  }

  // Daily attempt counter (#40) — the tutor shares the same budget as
  // the MCQ quiz, so a kid can't bypass the cap by switching modes.
  // Admin bypass: skip INCR and the limit check entirely so admins can
  // iterate without being locked out after two test runs.
  const isAdminUser = isAdmin(sessionAuth.email);
  const attemptCount = isAdminUser
    ? 1
    : await recordQuizAttempt(sessionAuth.email, bookId);
  if (!isAdminUser && attemptCount != null && attemptCount > QUIZ_DAILY_ATTEMPT_LIMIT) {
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

  // Transcribe via Whisper (with book-context prompt-bias to suppress
  // YouTube-transcript hallucinations like "Thanks for watching").
  let transcript = "";
  try {
    transcript = await transcribeAudio(audioBytes, "turn.webm", { book });
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

  // Empty transcript = Whisper either heard silence or hallucinated
  // a YouTube-transcript phrase we filtered out (lib/tutor.js).
  // Treat as "didn't catch that" retry — don't advance turn, ask
  // the kid to repeat. Same path as a thrown Whisper error.
  if (!transcript) {
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
  // - turn 1 → run a PRELIMINARY rubric grade. If the kid already
  //   nailed it (clear pass) we finalize NOW with the preliminary as
  //   the final grade and they get the bonus XP. Otherwise we ask one
  //   targeted follow-up that probes the rubric's weakest axis — the
  //   kid's second chance to bump their score across the pass threshold.
  // - turn 2 → finalize with the commit-mode grader and compare against
  //   the preliminary. If the score didn't improve past the pass bar,
  //   it's an internal fail (no bonus XP) per the second-chance rule.
  const isFinalTurn = tutorSession.turnIndex >= TUTOR_QUESTION_COUNT;

  if (!isFinalTurn) {
    // We're between turn 1 and the follow-up. Run the preliminary grade
    // on this single response to decide: clear pass → finalize early,
    // otherwise → targeted follow-up. The preliminary grade is cheap
    // (gpt-4o-mini) and on the critical-path latency budget.
    let preliminary = null;
    try {
      preliminary = await previewGradeFirstTurn({
        book,
        ageGrade: tutorSession.ageGrade,
        studentText: transcript,
      });
    } catch (err) {
      trackError("tutor_preview_grade_failed", { err: String(err?.message || err) });
      // If the preview grade fails, fall back to the legacy behavior:
      // always ask the follow-up. We never want a failed preview call
      // to deny a kid their chance to add more.
      preliminary = null;
    }
    tutorSession.preliminaryGrade = preliminary;

    // If on-topic moderation already said this was off-topic, we don't
    // want to bail on the kid — we still want the follow-up so they can
    // course-correct. But surface it in the preliminary's weakAxis hint
    // so the tutor's next question gently redirects.
    if (preliminary && !moderation.onTopic) {
      preliminary.weakAxis = "stayed_on_topic";
      preliminary.verdict = "needs_followup";
    }

    if (preliminary && preliminary.verdict === "clear_pass") {
      // Clear pass on the first answer — finalize NOW. We re-use the
      // commit-mode grader on the single-turn transcript so the final
      // grade payload + feedback line are consistent with the two-turn
      // path. The early-exit is recorded so admin can audit it.
      tutorSession.earlyPass = true;
      trackEvent("tutor_early_pass", {
        bookId: tutorSession.bookId,
        previewTotal: preliminary.total,
      });
      return await finalizeAndGrade(res, tutorSession, book);
    }

    // Needs follow-up — generate a targeted next message that probes
    // the weak axis. The weakAxis hint goes into the system prompt
    // so the tutor doesn't ask the same kind of question twice.
    const weakAxis = preliminary?.weakAxis || null;
    let nextMessage;
    try {
      nextMessage = await generateTutorNextMessage({
        book,
        ageGrade: tutorSession.ageGrade,
        transcript: tutorSession.transcript,
        weakAxis,
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
    trackEvent("tutor_followup_asked", {
      bookId: tutorSession.bookId,
      weakAxis,
      previewTotal: preliminary?.total ?? null,
    });
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

  // Grade selection:
  //   - earlyPass (clear pass on turn 1) → trust the preliminary rubric
  //     as the final grade. We already saw all four axes non-zero and
  //     total ≥ TUTOR_CLEAR_PASS_SCORE. Re-grading with gpt-4o would
  //     risk a contradiction and burn an extra LLM call for no gain.
  //   - otherwise → COMMIT-mode grader over the full transcript. After
  //     the kid's had their second chance we owe them a definitive
  //     pass/fail, not an admin-review null. Borderline collapses to
  //     fail (no bonus XP).
  let grade;
  if (tutorSession.earlyPass && tutorSession.preliminaryGrade) {
    const p = tutorSession.preliminaryGrade;
    grade = {
      retell_quality:   p.retell_quality,
      character_recall: p.character_recall,
      event_recall:     p.event_recall,
      stayed_on_topic:  p.stayed_on_topic,
      overall_pass:     true,
      feedback: "Great job telling me about the book!",
    };
  } else {
    try {
      grade = await gradeConversation({
        book,
        ageGrade: tutorSession.ageGrade,
        transcript: tutorSession.transcript,
        mode: "commit",
      });
    } catch (err) {
      trackError("tutor_grade_failed", { err: String(err?.message || err) });
      grade = {
        retell_quality: 0,
        character_recall: 0,
        event_recall: 0,
        stayed_on_topic: 0,
        // Grader call failed (LLM down / network blip) — DO hold for
        // admin review here. This is a tech fault, not a kid problem,
        // and we shouldn't penalize them for our outage.
        overall_pass: null,
        feedback: "We're having trouble grading right now. We'll check this and get back to you!",
      };
    }
  }

  // Second-chance rule (#85): if the kid got a follow-up, the final
  // score MUST exceed the preliminary AND clear the pass bar. A kid
  // who restated the same low score twice doesn't earn the bonus.
  // Skipped when:
  //   - earlyPass: clear pass on turn 1, no follow-up was offered
  //   - no preliminaryGrade: grader fell back (preview call failed)
  //   - overall_pass === null: grader infrastructure fault, held path
  if (
    !tutorSession.earlyPass &&
    tutorSession.preliminaryGrade &&
    grade.overall_pass === true
  ) {
    const prelimTotal = totalRubricScore(tutorSession.preliminaryGrade);
    const finalTotal = totalRubricScore(grade);
    if (finalTotal <= prelimTotal || finalTotal < TUTOR_PASS_SCORE) {
      grade.overall_pass = false;
      grade.feedback =
        "Thanks for telling me about the book! Next time, try sharing a bit more about what happened and who's in it.";
      trackEvent("tutor_second_chance_failed", {
        bookId: tutorSession.bookId,
        prelimTotal,
        finalTotal,
      });
    }
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
      // currentlyReading clear handled by the unconditional block at
      // the bottom of finalizeAndGrade — see #77 fix.
    }
    trackEvent("tutor_session_awarded", {
      bookId: tutorSession.bookId,
      quizOutcome,
      retellOutcome,
      xp: result.points,
    });
  } else {
    // Total XP is zero (both halves failed). No leaderboard write,
    // but the kid still completed the section — clear their
    // currentlyReading so picking a new book doesn't prompt
    // "are you sure you want to switch?".
    response.passed = false;
    response.points = 0;
    trackEvent("tutor_session_zero", {
      bookId: tutorSession.bookId,
      quizOutcome,
      retellOutcome,
    });
  }

  // #77 — ALWAYS clear currentlyReading once the atomic session is
  // finalized, regardless of outcome (pass / held / zero). The kid
  // is "done with" this book in this session; whether they earned XP
  // is a separate concern from the in-progress marker. Without this,
  // a kid who passed a quiz + did the retell still gets prompted
  // "switch to a new book?" when they tap a different cover.
  try {
    const active = await getCurrentlyReading(email);
    if (active && active.bookId === tutorSession.bookId) {
      await clearCurrentlyReading(email);
      response.clearedCurrentlyReading = true;
    }
  } catch (err) {
    trackError("tutor_clear_current_failed", { err: String(err?.message || err) });
  }

  // Clear the reading-session record either way — atomic award succeeded
  // or the kid bottomed out at 0 XP. New session needed for next attempt.
  await clearReadingSession(email, tutorSession.bookId);

  // #94 — persist the retell rubric + transcript so admin can audit
  // how the kid was graded. Per-user Redis LIST, capped at 50 entries,
  // 90d TTL. Best-effort: if Redis is down we still return the
  // response — the log is an admin aid, not a kid-facing feature.
  try {
    await appendRetellLog({
      email,
      bookId: tutorSession.bookId,
      bookTitle: book.title || tutorSession.bookId,
      workingGrade: tutorSession.workingGrade,
      ageGrade: tutorSession.ageGrade,
      rubric: grade,
      transcript: tutorSession.transcript,
      xpBreakdown: response.xpBreakdown,
      quizOutcome,
      retellOutcome,
      earlyPass: !!tutorSession.earlyPass,
      held: !!response.held,
    });
  } catch (err) {
    trackError("tutor_retell_log_failed", { err: String(err?.message || err) });
  }

  return json(res, 200, response);
}
