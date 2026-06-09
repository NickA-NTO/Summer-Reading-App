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
// Thresholds:
//   ≥10 = clear pass (p1 in XP table) — strong retell with detail
//   7-9 = marginal pass (p2 in XP table) — passed but thin
//    <7 = fail (fF in XP table) — title regurgitation, off-topic, etc.
export const TUTOR_CLEAR_PASS_SCORE = 10;
export const TUTOR_PASS_SCORE = 7;
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
      ? "The preliminary rubric flagged CHARACTERS as the weak spot. Ask specifically about WHO is in the book — name a character, or who the main character met, or who helped them."
      : weakAxis === "event_recall"
      ? "The preliminary rubric flagged SPECIFIC EVENTS as the weak spot. Ask for one concrete moment — what happened first, what changed in the middle, or a single scene they remember."
      : weakAxis === "retell_quality"
      ? "The preliminary rubric flagged the OVERALL RETELL as thin. Ask them to walk through it — \"What happens in the book from start to end?\" or \"Can you tell me the story in your own words?\""
      : weakAxis === "stayed_on_topic"
      ? "The preliminary rubric flagged STAYING ON TOPIC as the weak spot. Warmly redirect back to the book and ask one specific thing they remember from it."
      : "";
  return [
    `You are a warm, curious reading buddy on a voice call with a ${gradeLabel} student who just finished "${book.title}" by ${book.author}.`,
    "",
    "Your job: have a brief natural conversation to confirm they read the book — like a curious friend, not a teacher giving a quiz. You opened by asking what the book was about. The kid answered, but their answer wasn't a clear pass yet, so this is their ONE chance to add more — react to what they said, then ask ONE targeted follow-up. After this single follow-up the conversation ends and a rubric grades whether they showed comprehension.",
    "",
    weakSteer ? `WEAK SPOT FOR THIS FOLLOW-UP: ${weakSteer}` : "Pick the follow-up to probe whichever part of comprehension they didn't cover (characters, plot events, or ending/theme).",
    "",
    "Fallbacks if no axis is obviously weak:",
    "- Missed characters → \"Who was the main character?\" or \"Who did they meet?\"",
    "- Missed plot events → \"What happened in the middle?\" or \"What did they do next?\"",
    "- Missed ending/theme → \"How did the book end?\" or \"What did the character learn?\"",
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
const WHISPER_HALLUCINATIONS = [
  /thanks?\s+for\s+watching/i,
  /subscribe\s+to\s+my\s+channel/i,
  /like\s+and\s+subscribe/i,
  /don'?t\s+forget\s+to\s+subscribe/i,
  /see\s+you\s+(in\s+the\s+)?next\s+(time|video)/i,
  /^(\s*you\s*)+$/i,                  // Whisper sometimes emits just "you"
  /^[.\s]*$/,                         // periods only
];
function isWhisperHallucination(text) {
  const t = String(text || "").trim();
  if (!t) return true;
  // Less than 2 chars after trimming punctuation = almost certainly noise.
  if (t.replace(/[.\s!?,]+/g, "").length < 2) return true;
  return WHISPER_HALLUCINATIONS.some((re) => re.test(t));
}

export async function transcribeAudio(audioBytes, filename = "turn.webm", { book } = {}) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");
  const file = await OpenAI.toFile(audioBytes, filename, { type: "audio/webm" });

  // Prompt-bias Whisper toward kid-reading-discussion vocabulary so it
  // doesn't drift toward YouTube-transcript hallucinations on silence.
  // Including the book title also helps with proper-noun recognition
  // (e.g. character names).
  const promptBias = book
    ? `A child is describing the book "${book.title}" by ${book.author}. They might mention ${book.title}, characters, or events.`
    : "A child is describing a book they just read.";

  const resp = await oai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "en",
    prompt: promptBias,
    temperature: 0, // deterministic — same audio → same transcript
  });
  const raw = (resp.text || "").trim();
  if (isWhisperHallucination(raw)) {
    // Empty string signals "we couldn't make it out" to the caller,
    // which triggers the tutor's "Oops, didn't catch that" retry path.
    return "";
  }
  return raw;
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
export async function previewGradeFirstTurn({ book, ageGrade, studentText }) {
  const oai = openai();
  if (!oai) throw new Error("openai_not_configured");

  const sys = [
    `You are grading a single verbal response from a student who just finished "${book.title}" by ${book.author}.`,
    `Book summary: ${book.blurb || "(summary not available)"}.`,
    `Student age group: ${ageGrade}.`,
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
    "STRICT RULES — do not be generous on these:",
    "- A response that ONLY restates words from the title gets 0 on retell_quality AND 0 on character_recall.",
    "  Example: 'The book is about red fish and blue fish' for the book 'One Fish Two Fish Red Fish Blue Fish' → 0/0 (title words don't count).",
    "- A response that names something NOT in the book (e.g. 'a camel') drops stayed_on_topic to 0-1 and event_recall to 0.",
    "- Be lenient on age-appropriate fragmentation, but factual wrongness is never a small thing.",
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
export async function gradeConversation({ book, ageGrade, transcript, mode = "commit" }) {
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
    `Book summary: ${book.blurb || "(summary not available)"}.`,
    `Student age group: ${ageGrade}.`,
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
    "STRICT RULES — do not be generous on these:",
    "- Responses that ONLY restate words from the title get 0 on retell_quality AND 0 on character_recall.",
    "  Example: 'fish, red fish, blue fish' for 'One Fish Two Fish Red Fish Blue Fish' → those are title words, not content.",
    "- Naming something NOT in the book (e.g. 'a camel' when no camel exists) drops stayed_on_topic to 0-1 and event_recall to 0.",
    "- Be lenient on age-appropriate fragmentation. Factual wrongness is never a small thing.",
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

/* ------------------------------------------------------------------ */
/* Tutor TTS helper                                                    */
/* ------------------------------------------------------------------ */

// Wraps synthAndStore so the caller doesn't need to import lib/tts.js.
// Reuses the same Vercel Blob cache so common tutor phrases ("Awesome.",
// "Can you tell me more?") are synthesized once across all sessions.
export async function synthTutorTts(text, voiceId = DEFAULT_VOICE) {
  return synthAndStore(text, voiceId);
}
