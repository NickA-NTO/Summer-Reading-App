// Conversational retell tutor (#9). Voice-only alternative path to the
// MCQ quiz: kid taps "Talk about it", tutor asks 3 short questions, kid
// answers each one verbally, then we grade the transcript in the
// background and route to the same XP / leaderboard pipeline the MCQ
// quiz uses.
//
// Why a separate module instead of bolting onto api/quiz.js:
//   - Different fraud profile (audio storage, topic moderation, etc.)
//   - Different model calls (Whisper + GPT-4o + topic classifier)
//   - Different grading rubric (open-ended scoring vs deterministic MCQ)
//   - api/quiz.js is already large and the conversational path doesn't
//     share much code with the cached-pool quiz path
//
// What lives here:
//   - Session lifecycle (create / load / save / expire)
//   - OpenAI client wrapper
//   - Tutor next-question generation (LLM call with conversation history)
//   - Whisper transcription
//   - Topic moderation classifier (cheap per-turn pass)
//   - End-of-conversation grader (returns rubric + pass/fail)
//   - Audio upload to Vercel Blob with deterministic path naming
//
// What lives in api/tutor.js:
//   - HTTP routing (action=start | turn | grade)
//   - Auth + track-locking + attempt-counter gates
//   - Recording the pass through recordRead (existing #40-counted pipeline)

import OpenAI from "openai";
import { put, list, del } from "@vercel/blob";
import { redis, getCachedTtsUrl, setCachedTtsUrl, addTtsUsage } from "./store.js";
import { synthAndStore, DEFAULT_VOICE, VOICES, cacheKey, checkBlobExists } from "./tts.js";
import { containsProfanity } from "./moderation.js";

// Maximum number of kid responses before the tutor must finalize.
// V2: dropped from 3 → 2 to match the redesign (single open retell +
// at most one targeted follow-up, then a rubric pass/fail). The
// follow-up is OPTIONAL — if the kid's first response already covers
// the rubric well (≥ TUTOR_CLEAR_PASS_SCORE on the preliminary grade)
// the tutor wraps up after a single turn and the kid gets bonus XP.
// Otherwise we ask one targeted follow-up to give the kid a chance
// to bump their score across the pass threshold. This is a CEILING,
// not a fixed count.
export const TUTOR_QUESTION_COUNT = 2;

// Rubric thresholds (over the 0–8 total of the 4 axes).
//  - Clear pass after turn 1 → finalize immediately, award bonus XP.
//  - Otherwise → offer a targeted follow-up. After turn 2 the kid
//    passes iff final ≥ TUTOR_PASS_SCORE AND final > preliminary.
//    Both conditions matter: a kid who restated the same low score
//    twice should not earn the bonus.
// Rubric is 4 axes × 0-3 per axis = 0-12 total (was 0-2 × 4 = 0-8).
// The 0-3 scale gives the grader more headroom to distinguish a
// thin one-sentence retell from a rich one, and lets the XP tier
// system (lib/xp.js retellOutcomeFromRubric) map total to p1/p2/fF
// without binning everyone above 5/8 into the same "pass" bucket.
//
// XP tiers — applied to the FINAL rubric total by retellOutcomeFromRubric.
// NO HOLDS: api/tutor.js maps EVERY graded retell to one of these:
//   ≥9  = p1 — rich retell, full bonus
//   5-8 = p2 — genuine retell, partial bonus
//   <5  = fF — weak/vague, no bonus (a passed quiz still pays base XP)
// The bonus bar (5) is low and the grader is grade-calibrated, so a real
// young-reader retell earns the bonus; silence is gated upstream (a kid who
// says nothing is asked to retell, not failed/held), never auto-failed here.
//
// TUTOR_CLEAR_PASS_SCORE (9) is the turn-1 early-finalize gate: a strong
// single answer (every axis non-zero) ends without a follow-up. It matches
// the p1 cutoff so a turn-1 clear-pass also lands in the p1 XP tier.
// TUTOR_PASS_SCORE (5) is the BONUS bar — at/above it the kid earns retell
// bonus; below it they still keep base XP from a passed quiz.
export const TUTOR_CLEAR_PASS_SCORE = 9;
export const TUTOR_PASS_SCORE = 5;
export const RUBRIC_MAX_PER_AXIS = 3;
export const RUBRIC_MAX_TOTAL = 12;

// Redis TTL for an in-flight session. Long enough for a kid to take a
// break mid-conversation (bathroom, snack); short enough that stale
// sessions self-clean. Resets on every saveTutorSession call.
const TUTOR_SESSION_TTL_SEC = 30 * 60;

// Vercel Blob TTL for audio clips (#73 tracks extending this once we
// have a parent-policy review). For now: 14 days from upload, then
// auto-delete via a future cleanup cron OR Vercel Blob's own retention.
// Today we just date-stamp the path so we can find + delete later.
export const TUTOR_BLOB_RETENTION_DAYS = 14;

// Lazy OpenAI client. Returns null if OPENAI_API_KEY isn't set — caller
// should bail with a 503 so the kid sees a friendly "TTS isn't on yet"
// path instead of a 500.
let _oai = null;
export function openai() {
  if (_oai) return _oai;
  if (!process.env.OPENAI_API_KEY) return null;
  // #14 — bound every OpenAI call so a hung Whisper/gpt-4o request
  // can't stall a retell turn to the Vercel function ceiling (where
  // the kid sees a raw 500). 20s per request with one retry; a
  // timeout surfaces as a thrown error the turn handler already
  // catches → graceful "didn't catch that" / tech-fault path rather
  // than an unhandled stall.
  _oai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 20_000,
    maxRetries: 1,
  });
  return _oai;
}
export function hasOpenAI() {
  return !!openai();
}

/* ------------------------------------------------------------------ */
/* Session storage                                                     */
/* ------------------------------------------------------------------ */

// Session shape (stored as JSON in Redis):
//   {
//     sessionId: string,           uuid v4
//     email: string,               kid's email (lower-cased)
//     bookId: string,              catalog book id
//     ageGrade: string,            "PK" | "K" | "1" | ... — drives prompt tone
//     workingGrade: string,        kid's reading-level grade
//     voiceId: string,             OpenAI voice for tutor TTS
//     startedAt: number,           server timestamp
//     turnIndex: number,           0 = no kid response yet
//                                  N = N student responses received
//     transcript: [                full conversation, oldest first
//       { role: "tutor"|"student", text: string, ts: number, audioUrl?: string },
//       ...
//     ],
//     audioUrls: [string],         Vercel Blob URLs of stored audio chunks
//     graded: boolean,             true after gradeConversation runs
//     gradeResult: object | null,  rubric + pass/fail from grader
//   }

function sessionKey(sessionId) {
  return `tutor:session:${sessionId}`;
}

// Resume index (#resume / Item 4): maps a kid's in-flight retell for a book
// back to its sessionId so "quit mid-retell and come back" can pick up the
// SAME conversation instead of starting over. Maintained in lockstep with the
// session by saveTutorSession (set while live + un-graded, deleted once
// graded). Keyed by (email, bookId) so there's at most one active retell per
// book per kid.
function activeKey(email, bookId) {
  return `tutor:active:${String(email).toLowerCase()}:${bookId}`;
}

export async function createTutorSession({
  email,
  bookId,
  ageGrade,
  workingGrade,
  voiceId,
  sourcedId,
}) {
  const r = redis();
  // randomUUID is in the Node Web Crypto global since 19+. MUST be
  // called as a method on globalThis.crypto — extracting the function
  // reference loses its `this` binding and Node throws
  // "Value of 'this' must be of type Crypto".
  const sessionId = (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function")
    ? globalThis.crypto.randomUUID()
    : "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  const session = {
    sessionId,
    email: String(email).toLowerCase(),
    bookId,
    ageGrade: ageGrade || "K",
    workingGrade: workingGrade || ageGrade || "K",
    voiceId: voiceId || DEFAULT_VOICE,
    sourcedId: sourcedId || null,
    startedAt: Date.now(),
    turnIndex: 0,
    transcript: [],
    audioUrls: [],
    graded: false,
    gradeResult: null,
  };
  if (r) {
    await r.set(sessionKey(sessionId), JSON.stringify(session));
    await r.expire(sessionKey(sessionId), TUTOR_SESSION_TTL_SEC);
  }
  return session;
}

export async function getTutorSession(sessionId) {
  const r = redis();
  if (!r || !sessionId) return null;
  try {
    const raw = await r.get(sessionKey(sessionId));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function saveTutorSession(session) {
  const r = redis();
  if (!r) return;
  await r.set(sessionKey(session.sessionId), JSON.stringify(session));
  // Reset TTL so a kid taking their time doesn't time out mid-question.
  await r.expire(sessionKey(session.sessionId), TUTOR_SESSION_TTL_SEC);
  // Maintain the (email,bookId)→sessionId resume index in lockstep with the
  // session (#resume / Item 4): point at this session while it's live so a
  // returning kid resumes it, and drop the pointer once the retell is graded
  // (terminal) so they instead start a fresh talk. Best-effort — a hiccup
  // here must never fail a turn save.
  try {
    if (session.email && session.bookId) {
      const ak = activeKey(session.email, session.bookId);
      if (session.graded) {
        await r.del(ak);
      } else {
        await r.set(ak, session.sessionId);
        await r.expire(ak, TUTOR_SESSION_TTL_SEC);
      }
    }
  } catch {}
}

// Look up the kid's in-flight retell for a book (or null). Returns just the
// sessionId; the caller validates the session still exists + is un-graded.
export async function getActiveTutorSession(email, bookId) {
  const r = redis();
  if (!r || !email || !bookId) return null;
  try {
    const id = await r.get(activeKey(email, bookId));
    return id ? String(id) : null;
  } catch {
    return null;
  }
}

// Explicitly drop the resume pointer (e.g. an abandoned session we don't want
// to resume). Idempotent. Normal terminal cleanup happens via saveTutorSession
// once `graded` is set, so this is a belt-and-suspenders helper.
export async function clearActiveTutorSession(email, bookId) {
  const r = redis();
  if (!r || !email || !bookId) return;
  try {
    await r.del(activeKey(email, bookId));
  } catch {}
}

/* ------------------------------------------------------------------ */
/* OpenAI calls                                                        */
/* ------------------------------------------------------------------ */

// First tutor message — deterministic, no LLM call needed. Lets us cache
// the TTS audio per-book and serve the first turn near-instantly. Pairs
// with the OpenAI TTS cache in lib/tts.js.
export function buildFirstQuestion(book) {
  return `Great job finishing ${book.title}! Can you tell me what the book was about?`;
}

// Closing message after the final question is answered. Also deterministic
// so TTS caches per-book.
export function buildClosingMessage(book) {
  return `You did a great job. Thanks for telling me about ${book.title}. See you next time!`;
}

// System prompt for the tutor's next-question generation. We pass the
// conversation history as chat messages so the model can ground its
// follow-up in what the kid actually said.
//
// Tone goal: feel like a curious friend on a voice call, not a robot
// quizmaster. The previous prompt locked the model into a rigid
// "praise + question" template that produced repetitive output
// ("Awesome. Can you tell me about a character?" every single turn).
// This version asks for genuine reactions, varied phrasing, and
// natural follow-ups grounded in what the kid actually said.
function buildTutorSystemPrompt(book, ageGrade, weakAxis) {
  const gradeLabel =
    ageGrade === "PK" ? "pre-kindergarten" :
    ageGrade === "K"  ? "kindergarten"     :
    `grade ${ageGrade}`;
  // Stronger steer when we know which axis the preliminary rubric
  // marked as weakest. The follow-up is the kid's only chance to
  // push the score above the pass threshold, so the question needs
  // to land on the exact thing they didn't say.
  const weakSteer =
    weakAxis === "character_recall"
      ? "The preliminary rubric flagged CHARACTERS as the weak spot. Ask OPENLY who was in the book — e.g. \"Who are some of the characters?\" or \"Who else was in the story?\" Don't pin them to one exact name."
      : weakAxis === "event_recall"
      ? "The preliminary rubric flagged EVENTS as the weak spot. Ask OPENLY for more of what happened — e.g. \"What are some of the things that happened?\" or \"What else did they do?\" Don't pin them to one specific moment like 'what happened first'."
      : weakAxis === "retell_quality"
      ? "The preliminary rubric flagged the OVERALL RETELL as thin. Invite more in their own words — \"Can you tell me more about what happens?\" or \"What else do you remember about the story?\""
      : weakAxis === "stayed_on_topic"
      ? "The preliminary rubric flagged STAYING ON TOPIC as the weak spot. Warmly redirect to the book and ask OPENLY \"What are some things you remember from it?\""
      : "";
  return [
    `You are a warm, curious reading buddy on a voice call with a ${gradeLabel} student who just finished "${book.title}" by ${book.author}.`,
    "",
    "Your job: have a brief natural conversation to confirm they read the book — like a curious friend, not a teacher giving a quiz. You opened by asking what the book was about. The kid answered, but their answer wasn't a clear pass yet, so this is their ONE chance to add more — react to what they said, then ask ONE targeted follow-up. After this single follow-up the conversation ends and a rubric grades whether they showed comprehension.",
    "",
    weakSteer ? `WEAK SPOT FOR THIS FOLLOW-UP: ${weakSteer}` : "Ask an OPEN follow-up that invites the kid to share more of what they remember — not a pinpoint question about one exact moment.",
    "",
    "PREFER OPEN over specific. A young child recalls more when asked broadly, and it feels like a chat, not a test. Good: \"What are some of the things that happened?\", \"What else do you remember?\", \"Tell me more about what she did.\" AVOID narrow pinpoints like \"What did she do FIRST when she got to the house?\" — they trip kids up and cap how much they can show.",
    "",
    "Fallbacks if no axis is obviously weak:",
    "- Missed characters → \"Who are some of the characters?\"",
    "- Missed plot events → \"What are some of the things that happened?\" or \"What else did they do?\"",
    "- Missed ending → \"What else happened in the story?\" (keep it open — don't demand the exact ending)",
    "",
    "How to talk:",
    "- React genuinely to what they JUST said before asking. Examples:",
    "    \"Oh, I love that part! What happened next?\"",
    "    \"Whoa, scary! Who was with them?\"",
    "    \"Cool — how did it all end?\"",
    "- Vary your reactions. Don't repeat \"Awesome\" or \"Nice\". Mix in: \"Oh!\", \"Whoa.\", \"Cool.\", \"I love that part.\", \"That's funny.\", \"Mm-hmm.\"",
    "- If their answer was very short or vague, just say \"Tell me more about that.\" or \"What happened then?\"",
    "",
    "Hard rules:",
    "- Keep every message UNDER 25 words.",
    "- ONE question per message. Never two.",
    `- Stay on "${book.title}". If they wander off ("I have a dog!" "Thanks for watching"), redirect warmly: "Oh fun! But back to ${book.title} — what about [thing from the book]?"`,
    "- NEVER explain the book to them — they read it, not you.",
    `- Use vocabulary a ${gradeLabel} student knows.`,
    "",
    "Book summary for YOUR reference only (do not read aloud or quote):",
    book.blurb || "(summary not available)",
    "",
    "Output ONLY the next thing you'd say out loud. No labels, no quotes around it, no JSON, no stage directions.",
  ].join("\n");
}

// Generate the tutor's next message given the conversation history.
// Returns the text to speak. The caller is responsible for TTS + storage.
export async function generateTutorNextMessage({
  book,
  ageGrade,
  transcript,
  weakAxis = null,
}) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");
  const sys = buildTutorSystemPrompt(book, ageGrade, weakAxis);
  const messages = [
    { role: "system", content: sys },
    ...transcript.map((t) => ({
      // Tutor messages are assistant; student messages are user.
      role: t.role === "tutor" ? "assistant" : "user",
      content: t.text,
    })),
  ];
  const resp = await oai.chat.completions.create({
    model: "gpt-4o",
    messages,
    // Higher temperature → more varied reactions and phrasing.
    // 0.7 produced near-identical "Awesome. Can you tell me..." every
    // turn; 0.95 lets the model pick from a wider vocabulary of
    // reactions while still respecting the hard rules in the system
    // prompt. Combined with the more permissive prompt above this
    // should feel meaningfully more conversational.
    temperature: 0.95,
    max_tokens: 110, // bumped from 80 — natural reactions need a bit more room
    // Penalize repeated phrases across turns. Without this gpt-4o
    // gravitates back to the same opener ("Awesome." / "Nice.")
    // every single turn.
    frequency_penalty: 0.6,
    presence_penalty: 0.4,
  });
  const text = (resp.choices[0]?.message?.content || "").trim();
  // Defensive: if the model accidentally returns something empty or
  // wraps its response in quotes, salvage gracefully.
  if (!text) return "Can you tell me more about the book?";
  return text.replace(/^["'`]+|["'`]+$/g, "");
}

// Whisper transcription. Accepts a Buffer/Uint8Array + optional filename
// so OpenAI can hint at format. We use opus webm from the browser by
// default (getUserMedia → MediaRecorder).
//
// Known Whisper failure mode: on silence or very short / unclear
// audio, the model hallucinates phrases from its YouTube training
// corpus ("Thanks for watching", "Subscribe to my channel", etc.).
// The user saw "Thank you for watching!" from a kid who said nothing.
// We post-process the transcript to:
//   1. Bias generation with a context prompt (children describing a book)
//   2. Detect known hallucination phrases and treat them as silence
//   3. Drop transcripts that are TOO short to be meaningful (likely
//      Whisper guessing on near-silent audio)
// Phrases Whisper invents on near-silent audio. We STRIP these (they typically
// contaminate the TAIL of a real retell) rather than discarding the whole
// transcript — only what survives the strip decides empty-vs-real. (#QC6)
const HALLUCINATION_PHRASES = [
  /thanks?\s+for\s+watching[.!?]*/gi,
  /subscribe\s+to\s+my\s+channel[.!?]*/gi,
  /like\s+and\s+subscribe[.!?]*/gi,
  /don'?t\s+forget\s+to\s+subscribe[.!?]*/gi,
  /see\s+you\s+(in\s+the\s+)?next\s+(time|video)[.!?]*/gi,
];
// Whole-string noise: nothing meaningful at all (Whisper's "you you you",
// punctuation-only, or fewer than 2 real chars). These ARE silence → empty.
function isWhisperNoise(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  // Less than 2 chars after trimming punctuation = almost certainly noise.
  if (t.replace(/[.\s!?,]+/g, "").length < 2) return true;
  if (/^(\s*you\s*)+$/i.test(t)) return true;   // Whisper sometimes emits just "you"
  if (/^[.\s]*$/.test(t)) return true;          // periods only
  return false;
}

export async function transcribeAudio(audioBytes, filename = "turn.webm", { book, mimeType } = {}) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");
  // #3 follow-up — the declared MIME must agree with the actual upload bytes.
  // Safari/iOS records audio/mp4 (AAC), not webm; hardcoding "audio/webm" here
  // declared the wrong container while api/tutor.js already correctly derived
  // the filename extension from the real Content-Type. Use the caller-supplied
  // mimeType (the request's actual Content-Type, codec params stripped) when
  // present, and fall back to "audio/webm" only when no content type was
  // available at all — same default as before.
  const _type = (typeof mimeType === "string" && mimeType) ? mimeType : "audio/webm";
  const file = await OpenAI.toFile(audioBytes, filename, { type: _type });

  // Prompt-bias Whisper toward kid-reading-discussion vocabulary so it
  // doesn't drift toward YouTube-transcript hallucinations on silence.
  // Including the book title also helps with proper-noun recognition
  // (e.g. character names).
  const promptBias = book
    ? `A child is describing the book "${book.title}" by ${book.author}. They might mention ${book.title}, characters, or events.`
    : "A child is describing a book they just read.";

  // #32 — verbose_json returns per-segment no_speech_prob +
  // avg_logprob, the model's own confidence that a segment is actually
  // SILENCE rather than speech. The phrase-blocklist below only catches
  // KNOWN hallucinations ("thanks for watching"); a novel hallucinated
  // phrase on a silent clip would slip through and be graded as a real
  // on-topic answer. The probability gate catches those generically.
  const resp = await oai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "en",
    prompt: promptBias,
    temperature: 0, // deterministic — same audio → same transcript
    response_format: "verbose_json",
  });
  const raw = (resp.text || "").trim();

  // No-speech gate: if EVERY segment the model produced reads as
  // silence (high no_speech_prob) and low-confidence (very negative
  // avg_logprob), treat the whole thing as "couldn't make it out" even
  // if Whisper emitted plausible-looking words. Thresholds are
  // deliberately conservative so a real but quiet/short answer still
  // gets through — we only drop clips the model itself is confident
  // are silence. Skipped when no segments are returned (older shapes).
  const segments = Array.isArray(resp.segments) ? resp.segments : [];
  if (segments.length > 0) {
    const allSilent = segments.every(
      (s) =>
        Number(s.no_speech_prob ?? 0) > 0.6 &&
        Number(s.avg_logprob ?? 0) < -1.0
    );
    // #QC6 — a real but quiet/clipped retell on a laggy device can read as
    // "all silent." If Whisper still produced a substantial transcript (>=8
    // words), trust the words over the probability gate; only drop short clips.
    const wordCount = raw.split(/\s+/).filter(Boolean).length;
    if (allSilent && wordCount < 8) return "";
  }

  // #QC6 — strip hallucinated phrases, then judge what REMAINS. A real retell
  // ending in "...thanks for watching" keeps its real content (was previously
  // discarded wholesale → wrongful "didn't catch that"); a clip that was ONLY a
  // hallucination strips to nothing → "" (the legitimate "didn't catch" path).
  let cleaned = raw;
  for (const re of HALLUCINATION_PHRASES) cleaned = cleaned.replace(re, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (isWhisperNoise(cleaned)) return "";
  return cleaned;
}

// Topic moderation — is this student input on-topic for the book?
// Returns { onTopic: bool }. Fails open (treats as on-topic) if no API
// configured so we don't block a legitimate conversation on missing config.
export async function moderateOnTopic({ book, studentText }) {
  const oai = openai();
  if (!oai) return { onTopic: true };
  const text = String(studentText || "").slice(0, 500);
  if (!text) return { onTopic: true };
  try {
    const resp = await oai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            `You are classifying whether a student's verbal response is on-topic for a conversation about the book "${book.title}". ` +
            "Reply with exactly one word: yes or no. " +
            "Off-topic examples: talking about a different book, video games, food, completely unrelated subjects. " +
            "On-topic examples: any response that mentions characters, events, plot, or themes from the book, even if brief or confused.",
        },
        { role: "user", content: text },
      ],
      temperature: 0,
      max_tokens: 4,
    });
    const reply = (resp.choices[0]?.message?.content || "").trim().toLowerCase();
    return { onTopic: reply.startsWith("y") };
  } catch {
    // LLM hiccup → don't punish the kid for our infrastructure problem.
    return { onTopic: true };
  }
}

// Sum of the four rubric axes. Range 0..12 (was 0..8 before the
// 0-3 per-axis scale change). Helper so the api layer doesn't have
// to know the axis names.
export function totalRubricScore(grade) {
  if (!grade) return 0;
  return (
    clampAxis(grade.retell_quality) +
    clampAxis(grade.character_recall) +
    clampAxis(grade.event_recall) +
    clampAxis(grade.stayed_on_topic)
  );
}

// Given a rubric, return the axis with the LOWEST score so the tutor
// follow-up can probe exactly that gap. Ties broken in the order:
// event_recall > character_recall > retell_quality > stayed_on_topic.
export function pickWeakAxis(grade) {
  if (!grade) return "event_recall";
  const axes = [
    ["event_recall",     clampAxis(grade.event_recall)],
    ["character_recall", clampAxis(grade.character_recall)],
    ["retell_quality",   clampAxis(grade.retell_quality)],
    ["stayed_on_topic",  clampAxis(grade.stayed_on_topic)],
  ];
  axes.sort((a, b) => a[1] - b[1]);
  return axes[0][0];
}

// Quick preliminary grade after the FIRST kid response. Returns the
// rubric + a verdict ('clear_pass' | 'needs_followup') so the api layer
// can decide whether to skip the follow-up entirely. Uses gpt-4o-mini
// for speed/cost — the call is on the critical path between the kid
// finishing their first sentence and the tutor's next message playing.
//
// Threshold: total ≥ TUTOR_CLEAR_PASS_SCORE (6) AND every axis non-zero
// AND on-topic. Everything else gets the second chance.
export async function previewGradeFirstTurn({ book, ageGrade, studentText, bookSummary }) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");

  // Use the full hand-authored summary if available — that's the
  // reference truth for "did this come from the book?". Falls back
  // to the catalog blurb (1 paragraph, marketing copy) only when no
  // summary file exists. Critical for distinguishing a real retell
  // from generic genre guesses ("there was a castle" / "there were
  // animals") which a kid can produce without reading anything.
  const referenceText = bookSummary || book.blurb || "(no reference text available)";

  const sys = [
    `You are grading a single verbal response from a student who just finished "${book.title}" by ${book.author}.`,
    `Student age group: ${ageGrade}.`,
    "",
    "==== BOOK REFERENCE (the only source of truth) ====",
    referenceText,
    "==== END BOOK REFERENCE ====",
    "",
    "==== COVER-LEVEL vs BODY-LEVEL — anti-blurb-recitation ====",
    "A child can read the front/back COVER without reading the book. So",
    "COVER-LEVEL content does NOT prove they read it:",
    "  - the main character's name and the setting",
    "  - the one-sentence premise / hook (what the book is 'about')",
    "  - the genre / mood ('a funny book about a pig')",
    "To PASS, the retell must include at least one BODY-LEVEL specific —",
    "something a kid could only know by actually reading:",
    "  - HOW the story ENDS or how the main problem is RESOLVED",
    "  - a specific MIDDLE event or scene",
    "  - a secondary character or a turning point",
    "The ENDING is the strongest signal: blurbs almost never reveal it.",
    "If the entire answer is cover-level (characters + premise + setting,",
    "however many) with NOTHING from the body, cap retell_quality and",
    "event_recall at 1 each so the total stays below the pass bar — that's",
    "reciting the cover, not retelling the book. (A kid who only gives",
    "cover-level content on this first turn should land below pass and get",
    "the follow-up, where they can show they know the ending/events.)",
    "",
    "==== GRADE CALIBRATION + PROOF-OF-READING — read carefully ====",
    `This student is ${ageGrade}. TWO rules work together:`,
    "(1) GENEROUS ON LANGUAGE: never penalize simple phrasing, fragments, or",
    "    minor role mix-ups (\"they\" vs the character's name). A 5-7 year old",
    "    who read the book and tells it plainly is a real reader — don't fail",
    "    them for vocabulary, and don't demand the exact ending from young grades.",
    "(2) STRICT ON PROOF-OF-READING: a retell only scores ABOVE the base bar if",
    "    it includes something a non-reader could NOT produce from the title,",
    "    cover, blurb, or general cultural knowledge of the story.",
    "    BEWARE FAMOUS STORIES (fairy tales, classics): their iconic beats are",
    "    common knowledge. For Goldilocks, \"she went in the bears' house and ate",
    "    the porridge, sat in the chairs, slept in the beds\" is the universally-",
    "    known outline — a child can recite it WITHOUT reading THIS book, so",
    "    treat it as cover-level and cap retell_quality + event_recall at 1.",
    "    REAL proof of reading = a detail from the BOOK REFERENCE above that is",
    "    NOT part of the famous outline: a secondary character, an unusual object",
    "    or action, the SPECIFIC way the problem resolves, or accurate sequenced",
    "    detail richer than the generic tale. Score event_recall and",
    "    retell_quality 2-3 ONLY when such book-specific content is present.",
    "    (A passed quiz already earns base XP, so a generic retell is NOT",
    "    punished — it simply doesn't earn the retell BONUS until it shows real",
    "    reading of THIS telling.)",
    "",
    "This is their FIRST answer to \"Can you tell me what the book was about?\". Score each dimension on a 0-3 scale:",
    "",
    "retell_quality (overall description of the plot/idea):",
    "  0 = nothing, refused, or just a title fragment (e.g. 'fish')",
    "  1 = one short sentence with minimal content (e.g. 'It's about fish')",
    "  2 = multiple sentences capturing some plot or theme",
    "  3 = rich narrative — multiple plot points, specific details, clear comprehension",
    "",
    "character_recall (characters from the book):",
    "  0 = no characters mentioned, OR mentions only generic title words",
    "  1 = one generic role mentioned ('a boy', 'a bear', or vague description)",
    "  2 = one specific character by name OR distinctive feature",
    "  3 = multiple characters with names/details",
    "",
    "event_recall (specific scenes or events):",
    "  0 = no specific events, just listing nouns",
    "  1 = one vague event hinted at",
    "  2 = one specific event accurately described",
    "  3 = multiple events OR one event with rich accurate detail",
    "",
    "stayed_on_topic (focus + factual accuracy):",
    "  0 = wrong book, completely off-topic, OR contains a confident WRONG fact (e.g. 'there was a camel' when no camel is in the book)",
    "  1 = mostly off-topic with a brief on-topic moment, OR mixes a wrong fact in",
    "  2 = on-topic but thin",
    "  3 = fully on-topic, focused, accurate throughout",
    "",
    "==== ANTI-GUESSING — distinguish 3 cases, this matters most ====",
    "",
    "Goal: don't reward kids who didn't read, but DON'T punish a real reader who",
    "read the book and can only describe it in simple words (young / ESL / shy /",
    "speech differences). Sort every statement into one of THREE buckets:",
    "",
    "BUCKET A — PURE GENRE GUESS → score 0. Could apply to ANY book of this genre;",
    "contains NO entity, character, or event actually specific to THIS book:",
    "  - 'It was about a castle / wizards / dragons' (any fantasy)",
    "  - 'There was a forest / a princess / magic' (any fairy tale)",
    "  - 'They were friends / learned a lesson / lived happily'",
    "  - 'It was a good book / it was funny / about animals'",
    "  These earn nothing — a non-reader can say them from the cover.",
    "",
    "BUCKET B — ACCURATE BUT SIMPLE → score 1 (PARTIAL CREDIT, not 0). Names real",
    "content from THIS book's reference, even plainly / without names / low-vocab:",
    "  - 'a pig and a spider' for Charlotte's Web (those ARE the book's animals)",
    "  - 'the boy got sent to his room and went to an island' for Where the Wild Things Are",
    "  - 'the duck got lost and a boy caught him' for The Story About Ping",
    "  This is REAL evidence they read it — give partial credit so a simple-spoken",
    "  reader isn't failed. It stays BELOW the pass bar on its own, which triggers a",
    "  supportive follow-up question to draw out more (the right outcome — coach, not fail).",
    "",
    "BUCKET C — SPECIFIC / RICH → score 2-3. Named characters ('Wilbur', 'Charlotte'),",
    "named places ('Zuckerman's barn'), or specific events ('Charlotte wrote SOME PIG",
    "in her web'). Full credit.",
    "",
    "The dividing line between A and B is: does it reference something that is actually",
    "IN THE BOOK REFERENCE and is NOT predictable from the genre alone? If yes → at least",
    "Bucket B. A retell made ENTIRELY of Bucket A genre-guesses with zero book-specific",
    "content stays a fail.",
    "",
    "Worked example — Charlotte's Web, student says 'It's about a pig and a spider on a farm':",
    "  pig + spider are this book's actual animals (Bucket B), 'farm' is the real setting.",
    "  retell_quality: 1, character_recall: 1, event_recall: 0, stayed_on_topic: 2 → 4/12.",
    "  Below pass — so the kid gets a follow-up to say more, NOT a flat fail. If on the",
    "  follow-up they add an event or a name, they pass.",
    "",
    "Worked example — Charlotte's Web, 'Wilbur is a pig who would have been killed but",
    "Charlotte the spider wrote messages in her web to save him':",
    "  retell_quality 3, character_recall 3, event_recall 3, stayed_on_topic 3 → 12/12.",
    "",
    "==== OTHER STRICT RULES ====",
    "- A response that ONLY restates words from the title gets 0 on retell_quality AND 0 on character_recall.",
    "  Example: 'about red fish and blue fish' for 'One Fish Two Fish Red Fish Blue Fish' → 0/0 (title words, not content).",
    "- A response that names something NOT in the book reference (e.g. 'a camel') drops stayed_on_topic to 0-1 and event_recall to 0.",
    "- Be lenient on age-appropriate fragmentation. Factual wrongness is never a small thing, but simple TRUE statements are not wrong.",
    "",
    'Reply with strict JSON only: {"retell_quality": 0-3, "character_recall": 0-3, "event_recall": 0-3, "stayed_on_topic": 0-3}',
  ].join("\n");

  let parsed = null;
  try {
    const resp = await oai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Student's answer:\n${studentText || "(no audible response)"}` },
      ],
      temperature: 0,
      max_tokens: 100,
      response_format: { type: "json_object" },
    });
    parsed = JSON.parse(resp.choices[0]?.message?.content || "{}");
  } catch {
    parsed = null;
  }

  const grade = {
    retell_quality:   clampAxis(parsed?.retell_quality),
    character_recall: clampAxis(parsed?.character_recall),
    event_recall:     clampAxis(parsed?.event_recall),
    stayed_on_topic:  clampAxis(parsed?.stayed_on_topic),
  };
  const total = totalRubricScore(grade);
  // A "clear pass" needs the total above the bar AND no axis at zero —
  // a kid who got 3/3/3/0 with nothing on topic-stay shouldn't skip the
  // follow-up. The on-topic axis ≥1 is enforced via the no-zero rule.
  const allAxesNonZero =
    grade.retell_quality > 0 &&
    grade.character_recall > 0 &&
    grade.event_recall > 0 &&
    grade.stayed_on_topic > 0;
  const verdict =
    total >= TUTOR_CLEAR_PASS_SCORE && allAxesNonZero
      ? "clear_pass"
      : "needs_followup";

  return {
    ...grade,
    total,
    verdict,
    weakAxis: pickWeakAxis(grade),
  };
}

// End-of-conversation grader. Returns a rubric + overall verdict.
//
// `mode`:
//   - "commit" (default) → commits to pass=true|false, never null. Used
//     after the follow-up (turn 2) when the kid has had their second
//     chance and we owe them a definitive decision.
//   - "soft" → can return pass=null for an admin-review hold. Kept for
//     backward compat / future paths where we want a held-XP queue
//     instead of a hard fail. Not used on the happy path anymore.
export async function gradeConversation({ book, ageGrade, transcript, mode = "commit", bookSummary }) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");

  const studentLines = transcript
    .filter((t) => t.role === "student")
    .map((t) => t.text);

  const turnCount = studentLines.length;
  const turnLabel =
    turnCount === 1 ? "one short answer" :
    turnCount === 2 ? "two short answers in a row" :
    `${turnCount} short answers in a row`;

  // Same anti-guessing reference as previewGradeFirstTurn — use the
  // hand-authored summary when available.
  const referenceText = bookSummary || book.blurb || "(no reference text available)";

  const verdictRules =
    mode === "commit"
      ? [
          "Then set overall_pass:",
          `- true if total score ≥ ${TUTOR_PASS_SCORE}/${RUBRIC_MAX_TOTAL} AND the responses are clearly about this book`,
          `- false otherwise. Always commit — never return null.`,
        ]
      : [
          "Then set overall_pass:",
          `- true if total score ≥ ${TUTOR_PASS_SCORE}/${RUBRIC_MAX_TOTAL} AND the responses are clearly about this book`,
          "- false if responses are about a different topic entirely",
          "- null only if audio quality clearly made transcription unreliable",
        ];

  const sys = [
    `You are grading a student's verbal answers about "${book.title}" by ${book.author}.`,
    `Student age group: ${ageGrade}.`,
    "",
    "==== BOOK REFERENCE (the only source of truth) ====",
    referenceText,
    "==== END BOOK REFERENCE ====",
    "",
    "==== COVER-LEVEL vs BODY-LEVEL — anti-blurb-recitation ====",
    "A child can read the front/back COVER without reading the book.",
    "COVER-LEVEL content does NOT prove reading: the main character's name,",
    "the setting, the one-sentence premise/hook, the genre. To PASS, the",
    "retell (across BOTH turns) must include at least one BODY-LEVEL",
    "specific only a real reader would know: HOW the story ENDS or the",
    "problem RESOLVES, a specific MIDDLE event, or a secondary character /",
    "turning point. The ENDING is the strongest signal — blurbs almost",
    "never reveal it. If the whole conversation is cover-level with nothing",
    "from the body, the total MUST stay below the pass bar (fail) — reciting",
    "the cover is not retelling the book.",
    "",
    "==== GRADE CALIBRATION + PROOF-OF-READING — read carefully ====",
    `This student is ${ageGrade}. TWO rules work together:`,
    "(1) GENEROUS ON LANGUAGE: never penalize simple phrasing, fragments, or",
    "    minor role mix-ups (\"they\" vs the character's name). A 5-7 year old",
    "    who read the book and tells it plainly is a real reader — don't fail",
    "    them for vocabulary, and don't demand the exact ending from young grades.",
    "(2) STRICT ON PROOF-OF-READING: a retell only scores ABOVE the base bar if",
    "    it includes something a non-reader could NOT produce from the title,",
    "    cover, blurb, or general cultural knowledge of the story.",
    "    BEWARE FAMOUS STORIES (fairy tales, classics): their iconic beats are",
    "    common knowledge. For Goldilocks, \"she went in the bears' house and ate",
    "    the porridge, sat in the chairs, slept in the beds\" is the universally-",
    "    known outline — a child can recite it WITHOUT reading THIS book, so",
    "    treat it as cover-level and cap retell_quality + event_recall at 1.",
    "    REAL proof of reading = a detail from the BOOK REFERENCE above that is",
    "    NOT part of the famous outline: a secondary character, an unusual object",
    "    or action, the SPECIFIC way the problem resolves, or accurate sequenced",
    "    detail richer than the generic tale. Score event_recall and",
    "    retell_quality 2-3 ONLY when such book-specific content is present.",
    "    (A passed quiz already earns base XP, so a generic retell is NOT",
    "    punished — it simply doesn't earn the retell BONUS until it shows real",
    "    reading of THIS telling.)",
    "",
    `The student gave ${turnLabel}. Score each dimension on a 0-3 scale based on the FULL conversation:`,
    "",
    "retell_quality (overall description of the plot/idea):",
    "  0 = nothing, refused, or just a title fragment",
    "  1 = one short sentence with minimal content",
    "  2 = multiple sentences capturing some plot or theme",
    "  3 = rich narrative — multiple plot points, specific details, clear comprehension",
    "",
    "character_recall (characters from the book):",
    "  0 = no characters mentioned, OR mentions only generic title words",
    "  1 = one generic role ('a boy', 'a bear', vague description)",
    "  2 = one specific character by name OR distinctive feature",
    "  3 = multiple characters with names/details",
    "",
    "event_recall (specific scenes or events):",
    "  0 = no specific events, just listing nouns",
    "  1 = one vague event hinted at",
    "  2 = one specific event accurately described",
    "  3 = multiple events OR one event with rich accurate detail",
    "",
    "stayed_on_topic (focus + factual accuracy):",
    "  0 = wrong book, completely off-topic, OR contains a confident WRONG fact",
    "  1 = mostly off-topic with a brief on-topic moment, OR mixes a wrong fact in",
    "  2 = on-topic but thin",
    "  3 = fully on-topic, focused, accurate throughout",
    "",
    "==== ANTI-GUESSING — 3 buckets, this matters most ====",
    "",
    "Don't reward kids who didn't read; don't punish a real reader who can only",
    "describe the book simply (young / ESL / shy). Sort each statement:",
    "",
    "BUCKET A — PURE GENRE GUESS → 0. Applies to ANY book of the genre, no content",
    "specific to THIS book: castle/wizard/dragon (any fantasy); forest/princess/magic",
    "(any fairy tale); 'they were friends', 'learned a lesson', 'lived happily';",
    "'it was good/funny/about animals'. A non-reader can say these from the cover.",
    "",
    "BUCKET B — ACCURATE BUT SIMPLE → 1 (partial credit, NOT 0). Names real content",
    "from the book reference, even plainly or without proper names: 'a pig and a spider'",
    "for Charlotte's Web, 'the boy went to an island' for Where the Wild Things Are. This",
    "is real evidence of reading — credit it. It stays below the pass bar alone, which",
    "correctly triggers a coaching follow-up rather than a flat fail.",
    "",
    "BUCKET C — SPECIFIC / RICH → 2-3. Named characters/places from the reference, or",
    "specific accurate events. Full credit.",
    "",
    "A retell made ENTIRELY of Bucket A genre-guesses with zero book-specific content",
    "must total below the pass bar (fail) — they didn't show they read it. But any genuine Bucket-B",
    "reference earns partial credit toward the pass.",
    "",
    "==== OTHER STRICT RULES ====",
    "- Responses that ONLY restate words from the title get 0 on retell_quality AND 0 on character_recall.",
    "  Example: 'fish, red fish, blue fish' for 'One Fish Two Fish Red Fish Blue Fish' → title words, not content.",
    "- Naming something NOT in the book reference (e.g. 'a camel' when no camel exists) drops stayed_on_topic to 0-1 and event_recall to 0.",
    "- Be lenient on age-appropriate fragmentation. A simple TRUE statement is not 'wrong'; factual wrongness is.",
    "",
    ...verdictRules,
    "",
    'Reply with strict JSON only: {"retell_quality": 0-3, "character_recall": 0-3, "event_recall": 0-3, "stayed_on_topic": 0-3, "overall_pass": true|false' + (mode === "soft" ? "|null" : "") + ', "feedback": "one short positive sentence for the student"}',
  ].join("\n");

  const user = [
    `Student's answers (verbatim transcripts):`,
    ...studentLines.map((l, i) => `${i + 1}. ${l || "(no audible response)"}`),
  ].join("\n");

  let parsed = null;
  try {
    const resp = await oai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: 200,
      response_format: { type: "json_object" },
    });
    parsed = JSON.parse(resp.choices[0]?.message?.content || "{}");
  } catch {
    parsed = null;
  }
  // Defensive defaults so a malformed grader response doesn't crash the
  // endpoint. In commit mode, null collapses to false (kid gets no
  // bonus but the read still completes). In soft mode, null is allowed.
  let overall;
  if (parsed?.overall_pass === true) overall = true;
  else if (parsed?.overall_pass === false) overall = false;
  else if (mode === "soft") overall = null;
  else overall = false;
  return {
    retell_quality:   clampAxis(parsed?.retell_quality),
    character_recall: clampAxis(parsed?.character_recall),
    event_recall:     clampAxis(parsed?.event_recall),
    stayed_on_topic:  clampAxis(parsed?.stayed_on_topic),
    overall_pass:     overall,
    feedback:
      typeof parsed?.feedback === "string" && parsed.feedback.length > 0
        ? parsed.feedback.slice(0, 200)
        : "Great work talking about the book!",
  };
}
// Per-axis clamp. Scale is 0..RUBRIC_MAX_PER_AXIS (was 0..2, now 0..3).
// Rounds, then clips. Non-numeric values default to 0 (safer than NaN).
function clampAxis(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(RUBRIC_MAX_PER_AXIS, Math.round(n)));
}

/* ------------------------------------------------------------------ */
/* Audio storage                                                       */
/* ------------------------------------------------------------------ */

// Store one turn's audio blob to Vercel Blob. Path encodes session id +
// turn index + ISO date so we can find + delete by date later (#73 retention).
//
// `audioBytes` is a Buffer or Uint8Array of opus/webm bytes from the browser.
// Returns the public URL. Returns null if Blob isn't configured (fail-soft —
// tutor still works, audio just isn't kept for admin review).
export async function storeTutorAudio({
  sessionId,
  turnIndex,
  audioBytes,
  contentType = "audio/webm",
}) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  // Date prefix lets a future cleanup cron scan by upload date instead
  // of listing every session individually.
  const datePart = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `tutor/${datePart}/${sessionId}/turn-${turnIndex}.webm`;
  const blob = await put(key, audioBytes, {
    access: "public",
    contentType,
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return blob.url;
}

// #10 — retention cleanup for children's voice recordings. They're uploaded
// under tutor/<YYYY-MM-DD>/<sessionId>/turn-N but were NEVER deleted (the
// promised 14-day TTL was never implemented), so they accumulated forever on
// the bucket. This deletes anything older than `days`. Runs daily
// (piggybacked on the caliper-drain-retry cron — no extra Vercel cron job)
// and on-demand from the admin panel. Best-effort; returns a summary.
//
// NOTE: this addresses the RETENTION half of the privacy gap. The bucket is
// still `access: "public"` above — switching the child recordings to private
// (so they aren't world-readable even within the window) needs a @vercel/blob
// capability check + signed URLs for any future admin playback, and is left
// as a follow-up so it doesn't silently break access.
const AUDIO_RETENTION_DAYS = 14;
export async function cleanupOldTutorAudio({ days = AUDIO_RETENTION_DAYS, maxDeletes = 2000 } = {}) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return { ok: false, reason: "no_blob_token", scanned: 0, deleted: 0 };
  }
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const toDelete = [];
  let scanned = 0;
  let cursor;
  try {
    do {
      const page = await list({ prefix: "tutor/", cursor, limit: 1000 });
      cursor = page.cursor;
      for (const b of page.blobs || []) {
        scanned++;
        let t = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
        if (!t) {
          const m = String(b.pathname || "").match(/^tutor\/(\d{4})-(\d{2})-(\d{2})\//);
          if (m) t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime();
        }
        if (t && t < cutoff) toDelete.push(b.url);
        if (toDelete.length >= maxDeletes) { cursor = undefined; break; }
      }
    } while (cursor);
    // Delete in chunks so one oversized del() call can't fail the whole run.
    for (let i = 0; i < toDelete.length; i += 100) {
      await del(toDelete.slice(i, i + 100));
    }
    return { ok: true, scanned, deleted: toDelete.length, days };
  } catch (err) {
    return {
      ok: false, reason: "blob_error",
      error: String(err?.message || err),
      scanned, deleted: toDelete.length,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Tutor TTS helper                                                    */
/* ------------------------------------------------------------------ */

// Synth a tutor line, REUSING the TTS cache (Redis index → Blob → synth) so a
// given (voice, text) is generated by OpenAI at most once across all kids.
// #10 — the old version called synthAndStore directly, which ALWAYS hit OpenAI
// AND re-PUT the clip to Blob (allowOverwrite) on every turn. That made the
// retell's very first (deterministic) question pay full synth latency for every
// kid (the visible "lag") and burned a Blob write per turn. The deterministic
// first question / closing / "didn't catch that" lines now serve from cache
// after the first synth.
export async function synthTutorTts(text, voiceId = DEFAULT_VOICE) {
  const voice = VOICES[voiceId] ? voiceId : DEFAULT_VOICE;
  const key = await cacheKey(voice, text);
  // 1. Redis-cached URL — instant, no OpenAI, no Blob write.
  try {
    const cached = await getCachedTtsUrl(key);
    if (cached) return { url: cached, chars: text.length, cached: "redis" };
  } catch {}
  // 2. Blob exists but the Redis index was lost — re-index, still no synth.
  try {
    const blobUrl = await checkBlobExists(voice, text);
    if (blobUrl) {
      try { await setCachedTtsUrl(key, blobUrl); } catch {}
      return { url: blobUrl, chars: text.length, cached: "blob" };
    }
  } catch {}
  // 3. Miss — synth once, store, index, and record usage. Tutor speech is core
  //    to the retell, so (unlike /api/tts) it is intentionally NOT gated by the
  //    budget cap; on a hard cap the client still has its browser-TTS fallback.
  const out = await synthAndStore(text, voice);
  try { await setCachedTtsUrl(key, out.url); } catch {}
  try { await addTtsUsage(out.chars); } catch {}
  return out;
}

// #child-safety — synth a tutor line for a child WITH a safety gate and no
// added perceptible latency. The dynamic follow-up is the only model-
// generated text spoken to a child (intro / closing / "didn't catch that"
// are static templates), so only that path needs this. Two tiers:
//   1. Deterministic profanity / slur / self-harm / sexual / hate scan —
//      instant, local (lib/moderation.js). A hit → speak `fallback`.
//   2. Otherwise the OpenAI moderation endpoint (free, fast) runs IN
//      PARALLEL with the TTS synth, so the check OVERLAPS the synth instead
//      of adding a sequential round-trip. A flag (rare for an aligned model)
//      → re-synth `fallback`.
// Returns { text, url, moderated } — `text` is the line actually spoken
// (swapped to `fallback` when the original was unsafe).
export async function synthSafeTutorTts(text, fallback, voiceId = DEFAULT_VOICE) {
  const raw = String(text || "");
  if (!raw.trim() || containsProfanity(raw)) {
    const tts = await synthTutorTts(fallback, voiceId);
    return { text: fallback, url: tts.url, moderated: true };
  }
  const [flagged, tts] = await Promise.all([
    _moderationFlagged(raw),
    synthTutorTts(raw, voiceId),
  ]);
  if (flagged) {
    const safe = await synthTutorTts(fallback, voiceId);
    return { text: fallback, url: safe.url, moderated: true };
  }
  return { text: raw, url: tts.url, moderated: false };
}

// OpenAI moderation endpoint — purpose-built, free, low-latency. Best-effort:
// any error returns false (not flagged), because the deterministic
// containsProfanity gate in synthSafeTutorTts is the must-have line of
// defense and this is only the nuance net for themes plain word-matching
// misses.
async function _moderationFlagged(text) {
  const oai = openai();
  if (!oai) return false;
  try {
    const r = await oai.moderations.create({
      model: "omni-moderation-latest",
      input: String(text || "").slice(0, 2000),
    });
    return !!(r && r.results && r.results[0] && r.results[0].flagged);
  } catch {
    return false;
  }
}
