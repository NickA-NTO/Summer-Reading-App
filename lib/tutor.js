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
import { put } from "@vercel/blob";
import { redis } from "./store.js";
import { synthAndStore, DEFAULT_VOICE } from "./tts.js";

// Number of questions the tutor asks before grading.
// 1 retell + 2 specific follow-ups = 3 student answers.
export const TUTOR_QUESTION_COUNT = 3;

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
  _oai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
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

export async function createTutorSession({
  email,
  bookId,
  ageGrade,
  workingGrade,
  voiceId,
}) {
  const r = redis();
  // randomUUID is in the Node Web Crypto global since 19+
  const sessionId = (globalThis.crypto?.randomUUID || (() => {
    // Fallback if running on a runtime without Web Crypto for some reason.
    return "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }))();
  const session = {
    sessionId,
    email: String(email).toLowerCase(),
    bookId,
    ageGrade: ageGrade || "K",
    workingGrade: workingGrade || ageGrade || "K",
    voiceId: voiceId || DEFAULT_VOICE,
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
// Guardrails:
//   - On-topic only (book content)
//   - Grade-appropriate vocabulary (driven by ageGrade)
//   - Short questions (kid attention span)
//   - Praise the kid before each new question
function buildTutorSystemPrompt(book, ageGrade) {
  const gradeLabel =
    ageGrade === "PK" ? "pre-kindergarten" :
    ageGrade === "K"  ? "kindergarten"     :
    `grade ${ageGrade}`;
  return [
    `You are a friendly reading buddy talking to a ${gradeLabel} student about a book they just finished.`,
    `The book is "${book.title}" by ${book.author}.`,
    `Book summary: ${book.blurb || "(summary not available)"}.`,
    "",
    "Your job is to verbally quiz the student to check their understanding. You will ask 3 short questions total. The student has already heard your first question.",
    "",
    "Rules:",
    "- Keep every message SHORT — under 15 words.",
    "- Use simple vocabulary the student will know at their grade level.",
    `- Stay on topic — only talk about "${book.title}". If the student says something off-topic, gently redirect: "That's cool — but let's talk about ${book.title}."`,
    "- Praise the student briefly before each new question (e.g., \"Awesome.\", \"Nice.\", \"Well done.\").",
    "- Question 2 should be about a specific character or important event.",
    "- Question 3 should be about how the story ends or what the student learned.",
    "- NEVER ask more than one question in a single turn.",
    "- NEVER lecture or explain — only ask short questions with brief praise.",
    "",
    "Output ONLY the next thing you say to the student. No labels, no quotes, no JSON.",
  ].join("\n");
}

// Generate the tutor's next message given the conversation history.
// Returns the text to speak. The caller is responsible for TTS + storage.
export async function generateTutorNextMessage({
  book,
  ageGrade,
  transcript,
}) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");
  const sys = buildTutorSystemPrompt(book, ageGrade);
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
    temperature: 0.7,
    max_tokens: 80,
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
export async function transcribeAudio(audioBytes, filename = "turn.webm") {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");
  // OpenAI SDK provides toFile() which adapts a Buffer/Blob/Uint8Array
  // into the File-like shape the audio API needs.
  const file = await OpenAI.toFile(audioBytes, filename, {
    type: "audio/webm",
  });
  const resp = await oai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "en",
    // Short prompts can hint at expected vocabulary (book title, etc.)
    // but for v1 we keep it generic — Whisper handles K-2 speech well.
  });
  return (resp.text || "").trim();
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

// End-of-conversation grader. Returns a rubric + overall verdict.
// pass=true → release XP, pass=false → no XP, pass=null → admin review.
export async function gradeConversation({ book, ageGrade, transcript }) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");

  const studentLines = transcript
    .filter((t) => t.role === "student")
    .map((t) => t.text);

  const sys = [
    `You are grading a student's verbal answers about "${book.title}" by ${book.author}.`,
    `Book summary: ${book.blurb || "(summary not available)"}.`,
    `Student age group: ${ageGrade}.`,
    "",
    "The student gave 3 short answers in a row. Score each dimension 0-2:",
    "- retell_quality: Did they describe the plot of the book?",
    "- character_recall: Did they identify or describe a character?",
    "- event_recall: Did they remember a specific event from the book?",
    "- stayed_on_topic: Did they stay focused on the book?",
    "",
    "Then set overall_pass:",
    "- true if total score ≥ 5/8 AND the responses are clearly about this book",
    "- false if total score < 4/8 OR responses are about a different topic entirely",
    "- null if borderline / unclear / audio quality made transcription unreliable",
    "",
    "Be lenient with young students — partial answers, fragments, and brief responses are fine if they show understanding.",
    "Be strict about wrong-book responses — if they're describing a different story, score zero on event/character.",
    "",
    'Reply with strict JSON only: {"retell_quality": 0-2, "character_recall": 0-2, "event_recall": 0-2, "stayed_on_topic": 0-2, "overall_pass": true|false|null, "feedback": "one short positive sentence for the student"}',
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
  // endpoint — fall to "needs review" instead.
  return {
    retell_quality:   clamp02(parsed?.retell_quality),
    character_recall: clamp02(parsed?.character_recall),
    event_recall:     clamp02(parsed?.event_recall),
    stayed_on_topic:  clamp02(parsed?.stayed_on_topic),
    overall_pass:
      parsed?.overall_pass === true || parsed?.overall_pass === false
        ? parsed.overall_pass
        : null,
    feedback:
      typeof parsed?.feedback === "string" && parsed.feedback.length > 0
        ? parsed.feedback.slice(0, 200)
        : "Great work talking about the book!",
  };
}
function clamp02(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(2, Math.round(n)));
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

/* ------------------------------------------------------------------ */
/* Tutor TTS helper                                                    */
/* ------------------------------------------------------------------ */

// Wraps synthAndStore so the caller doesn't need to import lib/tts.js.
// Reuses the same Vercel Blob cache so common tutor phrases ("Awesome.",
// "Can you tell me more?") are synthesized once across all sessions.
export async function synthTutorTts(text, voiceId = DEFAULT_VOICE) {
  return synthAndStore(text, voiceId);
}
