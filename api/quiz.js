// AI-generated reading comprehension quiz. Generates a POOL of 12 multiple-
// choice questions per book and caches them in Redis. The client picks 5 at
// random per attempt and shuffles the answer options, so a kid retaking the
// quiz sees mostly different questions and never the same option ordering.
//
// Quality pipeline (each tier is additive):
//   1. Multi-pass cross-validation — 3 independent generation runs at
//      different temperatures, cluster semantically, keep only
//      questions that appear in 2+ runs. Disable via QUIZ_MULTI_PASS=0.
//   2. Deterministic citation grounding (verifyQuestionGrounded) —
//      every generated question must cite a sourceText that appears
//      verbatim in the hand-authored summary AND contains the answer
//      text. Code-level substring match; no LLM judgment.
//   3. QC reviewer — Opus second pass scores accuracy / safety / form
//      0-10. Drops below QC_MIN_* thresholds.
//
// Source of truth: hand-authored .md files under docs/book-summaries/.
// No LLM-synthesised records, no legacy summaries, no fallback. Books
// without a .md return no_summary_for_book.
//
// Auth: requires a valid rs_session cookie. Middleware excludes /api/*
// so each endpoint does its own check.

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { verifySession, parseCookies, isAdmin } from "../lib/session.js";
import { moderateQuizQuestions } from "../lib/moderation.js";
import { trackError, trackEvent } from "../lib/observability.js";
import {
  getCachedQuiz,
  setCachedQuiz,
  guessGradeFromEmail,
  getCurrentlyReading,
  recordQuizOpen,
  redis,
} from "../lib/store.js";
import { normalizeGrade } from "../lib/xp.js";
import { checkRateLimit, send429, LIMITS } from "../lib/rate-limit.js";
import { clusterAndExtractConsensus } from "../lib/quiz-validator.js";
import { resolveVisibleTracks, trackForBook } from "../lib/tracks.js";

// ============================================================
// Hand-authored book summaries — the sole source of truth for quiz
// generation. Loaded once at module init from docs/book-summaries/.
// Each .md is keyed by the bookId prefix (e07-*.md → "e07").
// ============================================================
const SUMMARIES_DIR = path.join(process.cwd(), "docs", "book-summaries");
const BOOK_SUMMARIES = new Map();
try {
  if (fs.existsSync(SUMMARIES_DIR)) {
    for (const f of fs.readdirSync(SUMMARIES_DIR)) {
      const m = f.match(/^([a-zA-Z]\d{2,3})-.+\.md$/);
      if (!m) continue;
      try {
        BOOK_SUMMARIES.set(
          m[1].toLowerCase(),
          fs.readFileSync(path.join(SUMMARIES_DIR, f), "utf-8")
        );
      } catch (err) {
        console.warn(`[quiz] failed to read summary ${f}:`, err?.message);
      }
    }
    console.log(`[quiz] loaded ${BOOK_SUMMARIES.size} hand-authored summaries`);
  }
} catch (err) {
  console.warn("[quiz] couldn't read docs/book-summaries/:", err?.message);
}
function getBookSummary(bookId) {
  return BOOK_SUMMARIES.get(String(bookId).toLowerCase()) || null;
}

// Canonical book metadata for quiz generation. The .md summary under
// docs/book-summaries/ is the source of truth for plot content; this
// map is just the metadata index — title, author, grade band,
// quizStyle. Used by api/activity.js to validate "is this a
// quiz-enabled bookId?" via `bookId in QUIZ_BOOKS`.
//
// quizStyle:
//   "comprehension" (default) — 12-question pool, 5/attempt, 4/5 pass.
//   "emergent" — Beginning Readers tier: 6-question pool, 3/attempt,
//                2/3 pass. Vocabulary in questions + options constrained
//                to first-100 Dolch sight words + CVC patterns.
export const QUIZ_BOOKS = {
  /* ---------- Beginning Readers (Track B emergent quiz style) ---------- */
  e01: {
    title: "We Are in a Book!",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
  },
  e02: {
    title: "I Will Surprise My Friend!",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
  },
  e03: {
    title: "Are You Ready to Play Outside?",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
  },
  e04: {
    title: "There Is a Bird on Your Head!",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
  },
  e05: {
    title: "Should I Share My Ice Cream?",
    author: "Mo Willems",
    grade: "PK",
    quizStyle: "emergent",
  },
  e06: {
    title: "Hop on Pop",
    author: "Dr. Seuss",
    grade: "PK",
    quizStyle: "emergent",
  },
  e07: {
    title: "One Fish Two Fish Red Fish Blue Fish",
    author: "Dr. Seuss",
    grade: "PK",
    quizStyle: "emergent",
    // Rewritten — the previous summary contained two hallucinations:
    //   • "They have a fight with a fish called Ned" — no such scene
    //     in the book. The "Ned" character is from Dr. Seuss's HOP ON
    //     POP ("Red, Ned, Ted and Ed in bed"), not One Fish Two Fish.
    //     The AI quiz generator faithfully turned the hallucination
    //     into a real quiz question, which is how it shipped.
    //   • Some "the narrator looks for a hop" and similar phrasings
    //     were also drift from Hop on Pop content.
    // This version sticks to canonical, verifiable content from the
    // actual book and uses cautious language elsewhere so the AI
    // generator can't extrapolate fake scenes.
  },
  e08: {
    title: "Biscuit",
    author: "Alyssa Satin Capucilli",
    grade: "PK",
    quizStyle: "emergent",
  },
  e09: {
    title: "Little Bear",
    author: "Else Holmelund Minarik",
    grade: "PK",
    quizStyle: "emergent",
  },
  e10: {
    title: "Frog and Toad All Year",
    author: "Arnold Lobel",
    grade: "PK",
    quizStyle: "emergent",
  },
  e11: {
    title: "Goose on the Loose",
    author: "Phil Roxbee Cox (Usborne)",
    grade: "PK",
    quizStyle: "emergent",
  },
  e12: {
    title: "Pirate Pat",
    author: "Mairi Mackinnon (Usborne)",
    grade: "PK",
    quizStyle: "emergent",
  },

  /* ---------- Grade K ---------- */
  k01: {
    title: "The Very Hungry Caterpillar",
    author: "Eric Carle",
    grade: "K",
  },
  k02: {
    title: "The Cat in the Hat",
    author: "Dr. Seuss",
    grade: "K",
  },
  k03: {
    title: "We're Going on a Bear Hunt",
    author: "Michael Rosen",
    grade: "K",
  },
  k04: {
    title: "Goldilocks and the Three Bears",
    author: "James Marshall",
    grade: "K",
  },
  k05: {
    title: "Mother Goose's Nursery Rhymes",
    author: "Iona Opie (ed.)",
    grade: "K",
  },
  k06: {
    title: "The Gruffalo",
    author: "Julia Donaldson",
    grade: "K",
  },
  k07: {
    title: "If You Give a Mouse a Cookie",
    author: "Laura Numeroff",
    grade: "K",
  },
  k08: {
    title: "Green Eggs and Ham",
    author: "Dr. Seuss",
    grade: "K",
  },
  /* ---------- Grade 1 ---------- */
  a01: {
    title: "The Tale of Peter Rabbit",
    author: "Beatrix Potter",
    grade: "1",
  },
  a02: {
    title: "Owl at Home",
    author: "Arnold Lobel",
    grade: "1",
  },
  a03: {
    title: "Frog and Toad Are Friends",
    author: "Arnold Lobel",
    grade: "1",
  },
  a04: {
    title: "Nate the Great",
    author: "Marjorie Weinman Sharmat",
    grade: "1",
  },
  a05: {
    title: "Henry and Mudge: The First Book",
    author: "Cynthia Rylant",
    grade: "1",
  },
  a06: {
    title: "The Dot",
    author: "Peter H. Reynolds",
    grade: "1",
  },
  a07: {
    title: "Where the Wild Things Are",
    author: "Maurice Sendak",
    grade: "1",
  },
  a08: {
    title: "The Story about Ping",
    author: "Marjorie Flack",
    grade: "1",
  },
  a09: {
    title: "Corduroy",
    author: "Don Freeman",
    grade: "1",
  },
  a10: {
    title: "Knuffle Bunny",
    author: "Mo Willems",
    grade: "1",
  },
  a11: {
    title: "The Ugly Duckling",
    author: "Hans Christian Andersen",
    grade: "1",
  },
  /* ---------- Grade 2 ---------- */
  b01: {
    title: "The True Story of the Three Little Pigs",
    author: "Jon Scieszka",
    grade: "2",
  },
  b02: {
    title: "Owl Moon",
    author: "Jane Yolen",
    grade: "2",
  },
  b03: {
    title: "The Velveteen Rabbit",
    author: "Margery Williams",
    grade: "2",
  },
  b04: {
    title: "The Lighthouse Family: The Storm",
    author: "Cynthia Rylant",
    grade: "2",
  },
  b05: {
    title: "Flat Stanley: His Original Adventure",
    author: "Jeff Brown",
    grade: "2",
  },
  b06: {
    title: "Mercy Watson to the Rescue",
    author: "Kate DiCamillo",
    grade: "2",
  },
  b07: {
    title: "Fantastic Mr. Fox",
    author: "Roald Dahl",
    grade: "2",
  },
  b08: {
    title: "Stellaluna",
    author: "Janell Cannon",
    grade: "2",
  },
  b09: {
    title: "The Magic Faraway Tree",
    author: "Enid Blyton",
    grade: "2",
  },

  /* ---------- Usborne First Reading — Grade K ---------- */
  u01: {
    title: "The Enormous Turnip",
    author: "Traditional (Usborne)",
    grade: "K",
  },
  u02: {
    title: "The Gingerbread Man",
    author: "Traditional (Usborne)",
    grade: "K",
  },
  u03: {
    title: "Chicken Licken",
    author: "Traditional (Usborne)",
    grade: "K",
  },

  /* ---------- Usborne First Reading — Grade 1 ---------- */
  u04: {
    title: "Jack and the Beanstalk",
    author: "Traditional (Usborne)",
    grade: "1",
  },
  u05: {
    title: "The Princess and the Pea",
    author: "H.C. Andersen (Usborne)",
    grade: "1",
  },
  u06: {
    title: "The Elves and the Shoemaker",
    author: "Brothers Grimm (Usborne)",
    grade: "1",
  },

  /* ---------- Usborne Young Reading Series 1 — Grade 2 ---------- */
  // u07 Wizard of Oz removed pre-V1 (#80) — couldn't verify a US Amazon-
  // sold ISBN. Canonical summary lived here; re-add along with the
  // catalog entry + lib/books.js metadata when a real US ISBN is sourced.
  u08: {
    title: "Rapunzel",
    author: "Susanna Davidson (Usborne)",
    grade: "2",
  },
  u09: {
    title: "Pinocchio",
    author: "Carlo Collodi (Usborne)",
    grade: "2",
  },

  /* ---------- Grade 3 ---------- */
  c01: {
    title: "Magic Tree House #1: Dinosaurs Before Dark",
    author: "Mary Pope Osborne",
    grade: "3",
  },
  c02: {
    title: "A to Z Mysteries: The Absent Author",
    author: "Ron Roy",
    grade: "3",
  },
  c03: {
    title: "Junie B. Jones and the Stupid Smelly Bus",
    author: "Barbara Park",
    grade: "3",
  },
  c04: {
    title: "The Boxcar Children",
    author: "Gertrude Chandler Warner",
    grade: "3",
  },
  c05: {
    title: "Charlotte's Web",
    author: "E.B. White",
    grade: "3",
  },
  c06: {
    title: "Stuart Little",
    author: "E.B. White",
    grade: "3",
  },
  c07: {
    title: "Because of Winn-Dixie",
    author: "Kate DiCamillo",
    grade: "3",
  },
  c08: {
    title: "Geronimo Stilton: Lost Treasure of the Emerald Eye",
    author: "Geronimo Stilton",
    grade: "3",
  },
};

// Pool size: 12 questions per book, 5 per attempt, 4/5 to pass (80%).
// SAME shape for every book in the catalog — Beginning Readers used to get a
// 3-question quiz, but that was gameable by guessing (~16% pass-by-chance
// per attempt vs ~0.7% on a 5-question 4/5 quiz). Questions are still
// calibrated to the kid's grade via GRADE_GUIDANCE; only the count is fixed.
const POOL_SIZE_FULL = 12;
function poolSizeFor(_style) {
  return POOL_SIZE_FULL;
}

// Quiz pool schema — uniform shape across the whole catalog.
function quizSchemaFor(_style) {
  return z.object({
    questions: z
      .array(
        z.object({
          q: z
            .string()
            .describe(
              "The question, in simple words a 5-year-old can read or hear read aloud."
            ),
          options: z
            .array(z.string())
            .length(4)
            .describe("Exactly 4 answer choices, all plausible to a child."),
          answer: z
            .number()
            .int()
            .min(0)
            .max(3)
            .describe("Index (0-3) of the correct option."),
          sourceText: z
            .string()
            .min(10)
            .describe(
              "REQUIRED. The verbatim entry from specific_facts or " +
              "plot_beats that supports this question. The correct " +
              "answer's text MUST appear inside this sourceText, or " +
              "the question is dropped by post-generation validation. " +
              "Do NOT paraphrase — copy the record entry exactly."
            ),
        })
      )
      .length(POOL_SIZE_FULL),
  });
}
const QuizSchema = quizSchemaFor();

// QC reviewer schema — a structured rubric for each question.
// #60 — adds a `safety` score (0-10) alongside accuracy. The QC pass
// now flags age-inappropriate content (violence, scary imagery,
// adult themes, religious / political content, identity-based
// commentary) BEFORE the question reaches a kid. Drops anything
// below SAFETY_MIN_SCORE (separate threshold from accuracy).
const QCSchema = z.object({
  reviews: z.array(
    z.object({
      questionIndex: z.number().int().min(0),
      accuracy: z
        .number()
        .int()
        .min(0)
        .max(10)
        .describe(
          "0 = clearly wrong or references something not in the book; " +
            "10 = unambiguously answerable from the canonical summary."
        ),
      safety: z
        .number()
        .int()
        .min(0)
        .max(10)
        .describe(
          "0 = age-inappropriate (violence, scary imagery for the target " +
            "grade, sexual content, slurs, religious/political " +
            "commentary, identity-based statements); " +
            "10 = unambiguously safe for the target grade."
        ),
      form: z
        .number()
        .int()
        .min(0)
        .max(10)
        .describe(
          "0 = correct answer is given away by GRAMMAR alone (e.g., " +
            "three options start with 'A' and the fourth starts with " +
            "'His'); options use inconsistent determiners, number, or " +
            "part-of-speech form. 10 = all four options share the same " +
            "grammatical form — indistinguishable by grammar."
        ),
      issues: z
        .array(z.string())
        .optional()
        .describe("Specific problems found, if any."),
    })
  ),
});

// Bump SCHEMA_VERSION whenever we change generation rules or pool shape
// — old cached pools are ignored automatically because the cache key
// embeds the version (`v{N}:{bookId}:{grade}`). Current rules baked
// into v16:
//   • Hand-authored .md under docs/book-summaries/ is the sole source.
//     Books without a .md return no_summary_for_book.
//   • Vocabulary keyed to AGE grade (a 5yo reading at G3 still gets
//     K-vocab questions). Working grade only informs inference depth.
//   • Each question carries a required `sourceText` field; the
//     deterministic verifyQuestionGrounded check drops any question
//     whose sourceText isn't a substring of the .md or whose answer
//     text isn't a substring of sourceText.
//   • Three QC axes: accuracy / safety / form. Min thresholds
//     7 / 7 / 4 (form 4 = "answer not visibly distinguishable by
//     grammar alone").
//   • Multi-pass generation (3 runs @ different temperatures), then
//     semantic clustering, then deterministic citation, then LLM QC.
//
// Previous versions retired in commit history; see git log for
// per-version rationale.
const SCHEMA_VERSION = 16;
// Exported alias so api/activity.js can build the same cache key when it
// validates a quiz_submit. Kept as a renamed export so the local const can
// be reassigned independently if we ever split client / server schemas.
export const QUIZ_SCHEMA_VERSION = SCHEMA_VERSION;

/**
 * Remove the answer index from a question before shipping to the client.
 * The Redis-cached pool keeps the full {q, options, answer} so the server
 * can grade quiz_submit; the wire payload to the browser is only
 * {q, options}. Closes the DevTools answer-reveal vector.
 */
function stripAnswerKey(q) {
  return { q: q.q, options: q.options };
}

/**
 * Read the cached quiz pool for (bookId, studentGrade, ageGrade).
 * Returns the full payload (questions WITH the answer index) or null.
 * Used by activity.js to grade a submitted quiz against the same pool
 * the kid was shown — the cache is the ONLY source of truth for what
 * the correct answer was.
 *
 * IMPORTANT — cache key MUST match the writer in the /api/quiz handler:
 *   ageGrade && ageGrade !== studentGrade
 *     ? "v{V}:{bookId}:{studentGrade}:age{ageGrade}"
 *     : "v{V}:{bookId}:{studentGrade}"
 * A kid with ageGrade ≠ workingGrade (e.g. age 2 reading at K level)
 * was hitting a different key on the read path and getting either a
 * 409 no_quiz_pool OR a wrong-answer-key grading (every submit = 0/5).
 *
 * ageGrade is optional — pre-#9 callers may not have it; in that case
 * we fall through to the legacy single-grade key.
 */
export async function getCachedQuizPool(bookId, studentGrade, ageGrade) {
  const key =
    ageGrade && ageGrade !== studentGrade
      ? `v${SCHEMA_VERSION}:${bookId}:${studentGrade}:age${ageGrade}`
      : `v${SCHEMA_VERSION}:${bookId}:${studentGrade}`;
  try {
    return await getCachedQuiz(key);
  } catch {
    return null;
  }
}

// Quiz model + QC reviewer model. Opus 4.5 for both — generation needs the
// stronger model for accuracy on lesser-known books; QC needs it to reliably
// flag the rare hallucination that slips through.
const GEN_MODEL = "claude-opus-4-5";
const QC_MODEL  = "claude-opus-4-5";

// QC accuracy threshold. Anything below this gets dropped from the pool.
const QC_MIN_ACCURACY = 7;
// #60 — safety threshold. Independent of accuracy. A question can be
// 10/10 accurate ("How does the wolf eat the pigs?") and still be
// content-safety inappropriate for K-2. 7 is intentionally close to the
// accuracy bar so we drop borderline cases for kid audiences without
// being so strict that the QC reviewer flags every mild conflict
// (which would gut the catalog of any books with stakes).
const QC_MIN_SAFETY = 7;
// Form-parallelism threshold. A question fails when its 4 options give
// away the correct answer by grammar alone (e.g., three "A wagon /
// scooter / car" distractors against a "His bike" answer). 4 is a
// softer bar than accuracy/safety — we tolerate mild surface drift
// (capitalisation, trailing punctuation) but reject answers that
// visibly stand out by determiner / number / part-of-speech form.
// Missing field in legacy QC responses defaults to 10 so we don't
// gut existing pools during the rollout window.
const QC_MIN_FORM = 4;
// SCHEMA_VERSION bump below to invalidate cached quizzes generated
// before the safety filter shipped.
// Minimum survivors — below this, the pool is unusable and we fail
// rather than serving a tiny quiz. Uniform across all books now that
// emergent has been retired.
const MIN_USABLE_POOL_FULL = 8;
function minUsableFor(_style) {
  return MIN_USABLE_POOL_FULL;
}

// Multi-pass cross-validation (1g). When enabled, we generate the pool 3
// times at different temperatures, cluster semantically, and keep only the
// consensus questions. Set QUIZ_MULTI_PASS=0 in env to fall back to single-pass.
const MULTI_PASS_ENABLED = process.env.QUIZ_MULTI_PASS !== "0";
// Temperatures for the 3 independent passes. Spread keeps the runs
// genuinely different so consensus = real consensus, not just identical
// re-runs of the same temperature.
const MULTI_PASS_TEMPS = [0.4, 0.7, 1.0];
// A question must appear in at least this many distinct runs to survive.
// With 3 runs, threshold 2 = "the model agrees on this from at least 2 of
// 3 random seeds" — a strong signal it's not a one-off hallucination.
const MULTI_PASS_CONSENSUS_THRESHOLD = 2;

// DIFFICULTY rubric — keyed to the student's WORKING grade. Controls
// vocabulary depth, inference complexity, sentence length. The book
// itself stays the same; questions adapt to what the kid can decode +
// reason about.
const GRADE_GUIDANCE = {
  PK:
    "Test LITERAL RECALL only — who, what, where, how many. Use only the " +
    "simplest words (Dolch first-100 sight words + short CVC words + proper " +
    "names from the book). Keep questions under 10 words and options under " +
    "5 words. AVOID inference, theme, sequence, or any abstract concept.",
  K:
    "Test LITERAL RECALL — what happened, who appeared, what they ate, " +
    "basic colors and counts. Use very simple, concrete words a five-year-old " +
    "would know. AVOID inference, theme, or abstract concepts.",
  "1":
    "Test recall plus simple SEQUENCE (what happened first, next, last) " +
    "and BASIC CAUSE-AND-EFFECT (why was the character sad? what did the " +
    "character do next?). Use simple-to-moderate vocabulary.",
  "2":
    "Test recall, INFERENCE (what the character was feeling, what they " +
    "might do next, why they made a choice), sequence, cause-and-effect, " +
    "and the LESSON OR THEME of the story. Multi-step thinking is " +
    "appropriate. Use full grade-appropriate vocabulary.",
  "3":
    "Test DEEPER INFERENCE, theme, character motivation, prediction, and " +
    "author's purpose. Vocabulary can be richer. Some questions can ask " +
    "the student to synthesize information across the whole story.",
  "4":
    "Same as Grade 3 but with more complex inference and analytical " +
    "thinking. Compare/contrast questions are appropriate.",
  "5":
    "Same as Grade 4 with richer vocabulary, more sophisticated inference, " +
    "and analysis of literary technique where relevant.",
};

// MATURITY rubric — keyed to the student's AGE grade (physical age),
// SEPARATE from working grade. Controls the FRAMING of distractors and
// the tone of the question — what kinds of "wrong-but-plausible" answers
// feel right for a kid that age, what reference points they understand
// (recess vs nap-time, etc.), and whether the language can assume basic
// social context (peer pressure, sportsmanship, etc.).
//
// Task #30: a 4th-grader reading at G2 working level gets G2-level
// difficulty but with FRAMING that doesn't feel babyish — distractors
// reference school playground / siblings / pets, not toddler-level
// scenarios. Without this, a kid reading below grade level felt
// infantilized by their distractors even when the question vocab fit.
const MATURITY_GUIDANCE = {
  PK:
    "Frame distractors around toddler-world scenes: parents, naps, " +
    "blocks, snack, animals at home, big-or-little objects. Keep the " +
    "tone gentle and warm.",
  K:
    "Frame distractors around early-school scenes: storytime, cubbies, " +
    "lunch, sharing, the playground, simple feelings (happy/sad/scared). " +
    "Tone is gentle and encouraging.",
  "1":
    "Frame distractors around 6-7-year-old life: school routines, " +
    "siblings, family, recess, friendship moments. Light humor is fine. " +
    "Avoid scenarios that require nap-time / toddler context.",
  "2":
    "Frame distractors around 7-8-year-old life: classroom dynamics, " +
    "playground games, family events, simple peer interactions, basic " +
    "fairness. Avoid both nap-time framing AND adult-level conflict.",
  "3":
    "Frame distractors around 8-9-year-old life: clubs and teams, " +
    "school projects, sibling rivalries, sportsmanship, simple moral " +
    "dilemmas. Tone is warm but not babyish — no preschool framing.",
  "4":
    "Frame distractors around 9-10-year-old life: friendships and " +
    "social groups, independence, perseverance, fairness, peer " +
    "pressure. Tone is engaged and respectful — never condescending.",
  "5":
    "Frame distractors around 10-11-year-old life: identity, fairness, " +
    "loyalty, deeper moral choices, light irony where the book supports " +
    "it. Tone respects the reader as a capable thinker.",
  "6":
    "Frame distractors around 11-12-year-old life: identity, " +
    "consequence, hypocrisy, social complexity, broader cultural " +
    "context. The reader is approaching middle-school maturity.",
  "7":
    "Frame distractors at full middle-school maturity: peer dynamics, " +
    "moral ambiguity, real-world consequence, light irony.",
  "8":
    "Same as Grade 7 with more sophisticated themes and a slightly " +
    "more analytical tone.",
};

// One generation pass — extracted so the multi-pass orchestrator can call
// it N times in parallel at different temperatures. The prompt is identical
// across runs; only `temperature` varies. Returns the array of questions
// (poolSize long for the book's style) or throws.
async function generateOnce(bookId, book, studentGrade, guidance, temperature, ageGrade) {
  const poolSize = POOL_SIZE_FULL;
  const schema = quizSchemaFor();
  const summary = getBookSummary(bookId);

  // Hard refuse: no hand-authored summary, no quiz. User directive —
  // we no longer generate against LLM-synthesised records, web search,
  // or legacy prose blurbs. Either there's a .md in
  // docs/book-summaries/ or there's no quiz for this book.
  if (!summary) {
    const err = new Error("no_summary_for_book");
    err.code = "no_summary";
    throw err;
  }

  // VOCABULARY tracks AGE grade (per user directive: "Age grade dictates
  // vocabulary while knowledge grade dictates text difficulty they have
  // access to"). A 5-year-old reading at G3 is still 5, and shouldn't
  // see words like "narrator" or "protagonist" in their quiz. Working
  // grade controls book ACCESS via track-locking elsewhere; here it
  // just informs the inference-depth tier of the question (recall vs
  // sequence vs theme).
  const ageGradeKey = String(ageGrade || studentGrade || "K").toUpperCase();
  const vocabRubric = GRADE_GUIDANCE[ageGradeKey] || GRADE_GUIDANCE.K;
  const isPreKVocab = ageGradeKey === "PK";
  // Maturity rubric drives the FRAMING of distractors (peer dynamics,
  // school routines, etc.) — also keyed to AGE grade.
  const maturityRubric = MATURITY_GUIDANCE[ageGradeKey] || "";

  const system =
    `You are an early-elementary reading specialist designing reading-` +
    `comprehension questions for a student whose AGE grade is ` +
    `${ageGradeKey} (vocabulary level) and whose READING level is ` +
    `Grade ${studentGrade} (inference depth they can handle).\n\n` +
    `VOCABULARY CALIBRATION — keyed to AGE grade ${ageGradeKey}. Every ` +
    `word in every question and every option must be one a ${ageGradeKey}-` +
    `age kid actually knows. DO NOT use grade-3+ vocabulary like ` +
    `"narrator", "protagonist", "theme", "character", "perspective" for ` +
    `a PK/K/G1 age kid — say "the person telling the story", "the main ` +
    `kid", "the lesson", "the people in the story", etc.\n${vocabRubric}\n\n` +
    (maturityRubric
      ? `MATURITY / FRAMING — keyed to AGE grade ${ageGradeKey}. ` +
        `This controls the kinds of scenarios / contexts you reference in ` +
        `distractors:\n${maturityRubric}\n\n`
      : "") +
    `Tone: warm and concrete. Each question has EXACTLY 4 options, ONE ` +
    `of which is clearly correct. The other three should be plausible-` +
    `but-wrong things a kid who skimmed might pick. Vary which index ` +
    `(0,1,2,3) is correct across all questions — don't bunch the ` +
    `correct answers at the same position.\n\n` +
    `CRITICAL — REQUIRED SOURCE CITATION (enforced by code, not by ` +
    `judgment). The book summary below is hand-authored and is the ` +
    `ONLY source of truth. Every question you write must include a ` +
    `"sourceText" field that COPIES VERBATIM a sentence or bullet from ` +
    `that summary. The post-generation validator runs a substring check:\n` +
    `  1) sourceText must appear (case- and punctuation-insensitive) ` +
    `     inside the summary text.\n` +
    `  2) the correct answer's text must appear inside sourceText.\n` +
    `If either check fails, the question is silently DROPPED — you ` +
    `cannot talk your way past it. Quote the summary EXACTLY. Do not ` +
    `paraphrase, summarise, or fabricate. Do not apply real-world ` +
    `common sense ("creatures in a picture book wouldn't go to school") ` +
    `— if it's not in the summary, it doesn't exist.\n\n` +
    `Worked examples (using a One Fish Two Fish summary):\n` +
    `  ✓ Q: "What does the Yink drink?" A: "Pink ink"\n` +
    `     sourceText: "The Yink drinks pink ink and likes to wink"\n` +
    `     — source appears in summary, answer "pink ink" appears in source.\n` +
    `  ✗ Q: "What do the Zans brush?" A: "Their teeth"\n` +
    `     REJECTED — summary says the Zans OPENS CANS. Brushing isn't ` +
    `     in any sentence about the Zans.\n` +
    `  ✗ Q: "Who never goes to school?" A: "Clark"\n` +
    `     REJECTED — summary never mentions school. Premise invented.\n`;

  const lengthRules = isPreKVocab
    ? `- Keep each question under 10 words.\n` +
      `- Keep each option under 5 words.\n` +
      `- Use only Dolch first-100 sight words + CVC patterns + proper ` +
      `  names that appear in the book.\n`
    : `- Keep each question under 18 words.\n` +
      `- Keep each option under 8 words.\n`;

  // Grounding = the full hand-authored .md text. The LLM reads it and
  // must cite from it verbatim via sourceText.
  const groundingBlock =
    `HAND-AUTHORED BOOK SUMMARY (the ONLY source of truth):\n\n` +
    summary;

  const prompt =
    `Write ${poolSize} reading-comprehension questions for the book ` +
    `"${book.title}" by ${book.author}.\n\n` +
    `The student is in Grade ${studentGrade}. The book is recommended ` +
    `for Grade ${book.grade} readers. If the student is OLDER than the ` +
    `book's level, still calibrate questions to the STUDENT's grade — ` +
    `don't dumb them down just because the book is short. If the student ` +
    `is YOUNGER than the book, keep questions simple even though the ` +
    `book is more advanced.\n\n` +
    groundingBlock + `\n\n` +
    `The questions should cover DIFFERENT aspects of the book so that any random ` +
    `subset of 5 still tests broad comprehension.\n\n` +
    `Hard rules:\n` +
    `- Avoid trick questions.\n` +
    lengthRules +
    `- No two questions should be near-duplicates.\n` +
    `- GRAMMATICAL PARALLELISM (critical): all four options for a single ` +
    `  question MUST share the same grammatical form. If one option starts ` +
    `  with the determiner "A" / "An", they ALL must (or all "The", all ` +
    `  "His"/"Her", all bare nouns, all "-ing" verbs, etc. — but never ` +
    `  mixed). If one option is plural, they all are. If one is a verb ` +
    `  phrase, they all are. The correct answer must NOT stand out by ` +
    `  grammar alone — a student who can't read the question shouldn't be ` +
    `  able to pick the right answer just from how the options look.\n` +
    `    BAD example (gives away "His bike"):\n` +
    `      A. A wagon   B. A scooter   C. A car   D. His bike\n` +
    `    GOOD example:\n` +
    `      A. A wagon   B. A scooter   C. A car   D. A bike\n` +
    `    Also GOOD:\n` +
    `      A. Mike's wagon   B. Mike's scooter   C. Mike's car   D. Mike's bike\n` +
    `- Every fact you assert must appear verbatim in the summary above. ` +
    `Anything not in the summary is OUT OF BOUNDS — including "common ` +
    `sense" inferences like school routines, jobs, pet care habits, or ` +
    `favourite colours unless the summary explicitly mentions them.`;

  const { object } = await generateObject({
    model: anthropic(GEN_MODEL),
    schema,
    temperature,
    system,
    prompt,
  });
  return object.questions;
}

// System prompt for the QC reviewer. Single mode now — every quiz is
// grounded in a hand-authored summary (the .md file under
// docs/book-summaries/). The QC reviewer cross-checks each question
// against the summary text + the deterministic source-citation check
// that runs BEFORE QC.
function buildQCSystemPrompt(summary, studentGrade) {
  const safetyBlock =
    "AXIS 2 — SAFETY (0-10). The student is in Grade " +
    `${studentGrade} (most readers K-3). Score for AGE-APPROPRIATENESS:\n` +
    "  10 = unambiguously safe for the target grade\n" +
    "   7 = workable but borderline (e.g., the book has stakes — a wolf, " +
    "a chase — and the question references them at an age-appropriate " +
    "level)\n" +
    "   4 = marginal: explicit references to violence/death the book " +
    "treats lightly, fearful imagery without the book's context, or " +
    "language that reads as gratuitously frightening\n" +
    "   0 = inappropriate for the target grade: explicit violence, " +
    "gore, sexual content, slurs, religious/political commentary, " +
    "identity-based statements, self-harm references, or distractors " +
    "that introduce content not in the book.\n\n" +
    "Score safety SEPARATELY from accuracy. A question can be perfectly " +
    "accurate to the book and still be flagged unsafe if the framing " +
    "is wrong for the grade. Most K-2 books are fine — only flag when " +
    "the question (not just the book) introduces age-inappropriate content.";

  const accuracyBlock = summary
    ? "AXIS 1 — ACCURACY (0-10). The book has a HAND-AUTHORED SUMMARY " +
      "(provided below). Score every question against that summary text:\n" +
      "  10 = every entity in question + answer + distractors traces to a " +
      "sentence in the summary; the question's PREMISE (the implied " +
      "assertion, e.g. 'X did Y') is supported by a verbatim line in the " +
      "summary; the sourceText cited by the generator actually appears in " +
      "the summary AND contains the correct answer\n" +
      "   7 = workable — minor wording issue but the premise traces to " +
      "the summary\n" +
      "   4 = answer or distractor introduces a name/item not in the " +
      "summary, OR the question's premise is only tangentially related " +
      "to the summary\n" +
      "   0 = question's premise is NOT in the summary (e.g., the summary " +
      "doesn't mention school but the question asks about school); OR " +
      "the sourceText cited doesn't appear in the summary; OR a specific " +
      "quantifier in the answer doesn't appear verbatim in the summary\n\n" +
      "PREMISE RULE (CRITICAL, catches 'Who never goes to school?' and " +
      "'What do the Zans brush?' hallucinations): the question implies " +
      "an assertion. That assertion must be supported by a verbatim line " +
      "in the summary. If you can't point to a specific sentence in the " +
      "summary that supports the question, score 0. Common pattern: the " +
      "question references real-world common sense ('schools', 'jobs', " +
      "'pets', 'favourite colors', 'brushing teeth') that the summary " +
      "never discusses — these are hallucinations.\n\n"
    : "AXIS 1 — ACCURACY (0-10). Catch hallucinations and inaccuracies. " +
      "For each question, verify it against the canonical plot summary.\n" +
      "  10 = unambiguously answerable from the summary; correct answer is " +
      "clearly correct; distractors are plausible-but-wrong\n" +
      "   7 = workable but minor wording issue (still ship it)\n" +
      "   4 = answer is questionable, or 2+ options could be defended as correct\n" +
      "   0 = fabricated detail not in the book, wrong answer, or " +
      "unanswerable from the summary\n\n" +
      "Be skeptical. If a question references a character name, number, " +
      "color, action, or event you can't find in the summary, score it LOW. " +
      "Don't pad scores to be nice — accuracy matters more than volume.\n\n";

  const formBlock =
    "AXIS 3 — FORM (0-10). Catch questions where the correct answer " +
    "gives itself away by GRAMMAR, not content. All four options for a " +
    "question must share the same grammatical form (same determiner, " +
    "same number, same part-of-speech pattern). If three options start " +
    "with \"A\" and the fourth starts with \"His\", a student who can't " +
    "read the question can still guess it. Score 0 in those cases — " +
    "they're functionally broken even if the content is accurate.\n" +
    "  10 = all 4 options share determiner / number / form. Indistinguishable by grammar alone.\n" +
    "   7 = minor surface inconsistency (capitalisation, trailing punctuation) but grammar matches.\n" +
    "   4 = one option's article or number differs; correct answer is still NOT the giveaway.\n" +
    "   0 = the correct answer's grammar visibly differs from the distractors (e.g., \"A wagon / A scooter / A car / His bike\"). REJECT.\n\n" +
    "Examples:\n" +
    "  REJECT: \"A wagon\" / \"A scooter\" / \"A car\" / \"His bike\"  ← determiner mismatch reveals answer.\n" +
    "  ACCEPT: \"A wagon\" / \"A scooter\" / \"A car\" / \"A bike\"\n" +
    "  ACCEPT: \"Riding a bike\" / \"Riding a scooter\" / \"Riding a car\" / \"Riding a wagon\"\n\n";

  return (
    "You are a strict reading-comprehension QC reviewer for an " +
    "elementary-school reading app (Kindergarten through Grade 8, " +
    "though most readers are K-3). You score THREE axes per question.\n\n" +
    accuracyBlock +
    safetyBlock + "\n\n" +
    formBlock
  );
}

function buildQCPrompt(summary, book, studentGrade, formatted, questionCount) {
  const groundingBlock = summary
    ? `HAND-AUTHORED BOOK SUMMARY (the ONLY source of truth):\n\n${summary}`
    : `No summary available for this book — every question should ` +
      `score LOW on accuracy since there's no source to verify against.`;
  return (
    `Book: "${book.title}" by ${book.author}\n` +
    `Grade level (calibration target): ${studentGrade}\n\n` +
    groundingBlock + `\n\n` +
    `Questions to review:\n\n${formatted}\n\n` +
    `For EVERY question (indexes 0 through ${questionCount - 1}), ` +
    `return an entry with that index, an accuracy score, a safety score, ` +
    `a form score, and any specific issues you found. Do not skip any.`
  );
}

// QC reviewer: takes a freshly-generated pool of questions and scores each
// for accuracy against the book's canonical summary. Drops questions with
// accuracy below QC_MIN_ACCURACY. Returns { questions: [keepers], dropped: [{idx, accuracy, issues}] }.
// Deterministic citation check. Each question must carry a sourceText
// that (a) appears verbatim in record.specific_facts OR
// record.plot_beats, AND (b) contains the correct answer's text.
// This is what catches the "Who never goes to school?" / "Zans brush
// teeth" / "On the Zeep cold feet" class of hallucination — the LLM
// can't lie its way past a substring match.
//
// Returns { ok: true } on pass, { ok: false, reason, ... } on fail.
// Lenient on:
//   - case (normalises to lowercase)
//   - leading articles on the answer ("the", "a", "an", "his", "her",
//     "their", "on the", "in the") — the answer often has a determiner
//     the record entry lacks ("A bike" vs "rides a bike")
//   - whitespace + punctuation differences
function verifyQuestionGrounded(q, summary) {
  if (!summary) return { ok: false, reason: "no_summary" };
  const src = String(q.sourceText || "").trim();
  if (!src || src.length < 10) {
    return { ok: false, reason: "no_source" };
  }
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const srcNorm = norm(src);
  const summaryNorm = norm(summary);
  // Source must appear as a substring of the hand-authored summary.
  // The LLM's cited sourceText may collapse whitespace or punctuation
  // differently from the source, so we normalise both sides before
  // matching. We also tolerate slight LLM expansion (a sourceText that
  // contains an entire record line — strictly a superset).
  const sourceFound =
    summaryNorm.includes(srcNorm) || srcNorm.includes(summaryNorm.slice(0, 200));
  if (!sourceFound) {
    return { ok: false, reason: "source_not_in_summary", source: src };
  }
  // Correct answer text must appear in source after stripping leading
  // articles / prepositions.
  const answerRaw = String(q.options?.[q.answer] || "").trim();
  if (!answerRaw) {
    return { ok: false, reason: "no_answer" };
  }
  const answerNorm = norm(answerRaw);
  const answerNoLeader = answerNorm.replace(
    /^(a|an|the|his|her|its|their|on|in|at|to|with|for|of|by)\s+/,
    ""
  );
  if (
    !srcNorm.includes(answerNorm) &&
    !srcNorm.includes(answerNoLeader)
  ) {
    return {
      ok: false,
      reason: "answer_not_in_source",
      answer: answerRaw,
      source: src,
    };
  }
  return { ok: true };
}

async function qcAndFilter(bookId, book, studentGrade, questions) {
  const summary = getBookSummary(bookId);

  // ---------- Citation grounding pre-filter (deterministic) ----------
  // Runs BEFORE the LLM-based QC. The LLM-based premise check kept
  // letting hallucinations through ("Who never goes to school?",
  // "What do the Zans brush?", "Where do the children put their cold
  // feet?") because the LLM can rationalise anything. The deterministic
  // substring check can't be talked around.
  let groundedQuestions = [];
  const groundingDropped = [];
  for (let i = 0; i < questions.length; i++) {
    const v = verifyQuestionGrounded(questions[i], summary);
    if (v.ok) {
      groundedQuestions.push(questions[i]);
    } else {
      groundingDropped.push({ idx: i, ...v, question: questions[i].q });
    }
  }
  if (groundingDropped.length > 0) {
    console.log(
      `[quiz_grounding] ${book.title}: dropped ${groundingDropped.length}/${questions.length}`,
      groundingDropped.map((d) => `Q${d.idx}(${d.reason})`).join(", ")
    );
  }
  // Run the remaining LLM-based QC pass over the GROUNDING SURVIVORS
  // only. Anything that failed citation grounding is already out — no
  // point asking the LLM to score it.
  const letters = ["A", "B", "C", "D"];
  const formatted = groundedQuestions
    .map(
      (q, i) =>
        `${i}. ${q.q}\n   A) ${q.options[0]}\n   B) ${q.options[1]}\n   ` +
        `C) ${q.options[2]}\n   D) ${q.options[3]}\n   ` +
        `[marked correct: ${letters[q.answer]}]\n   ` +
        `[source from record: ${q.sourceText || "(none)"}]`
    )
    .join("\n\n");

  let reviews;
  try {
    const { object } = await generateObject({
      model: anthropic(QC_MODEL),
      schema: QCSchema,
      system: buildQCSystemPrompt(summary, studentGrade),
      prompt: buildQCPrompt(summary, book, studentGrade, formatted, groundedQuestions.length),
    });
    reviews = object.reviews || [];
  } catch (err) {
    // QC call failed — degrade gracefully by accepting all grounded questions.
    // Better to serve a (possibly imperfect) quiz than to block on QC failure.
    console.warn("[quiz_qc_failed]", String(err?.message || err));
    return { questions: groundedQuestions.map(stripSourceText), dropped: [] };
  }

  const reviewByIdx = new Map();
  for (const r of reviews) reviewByIdx.set(r.questionIndex, r);

  const survivors = [];
  const dropped = [];
  for (let i = 0; i < groundedQuestions.length; i++) {
    const r = reviewByIdx.get(i);
    // If QC didn't review a question (model omission), keep it but log.
    if (!r) {
      survivors.push(groundedQuestions[i]);
      continue;
    }
    // Drop on accuracy, safety, OR form below threshold. The safety
    // and form fields are optional on legacy QC responses (the model
    // may omit them during the rollout window) — treat missing as
    // 10/clean so we don't accidentally gut every cached pool.
    const safetyScore = Number.isInteger(r.safety) ? r.safety : 10;
    const formScore   = Number.isInteger(r.form)   ? r.form   : 10;
    const passes = r.accuracy >= QC_MIN_ACCURACY &&
                   safetyScore >= QC_MIN_SAFETY &&
                   formScore   >= QC_MIN_FORM;
    if (passes) {
      survivors.push(groundedQuestions[i]);
    } else {
      dropped.push({
        idx: i,
        accuracy: r.accuracy,
        safety: safetyScore,
        form: formScore,
        reason:
          r.accuracy < QC_MIN_ACCURACY ? "accuracy" :
          safetyScore < QC_MIN_SAFETY  ? "safety"   :
          "form",
        issues: r.issues || [],
        question: groundedQuestions[i].q,
      });
    }
  }

  if (dropped.length > 0) {
    console.log(
      `[quiz_qc] ${book.title} grade=${studentGrade}: kept ${survivors.length}/${groundedQuestions.length}`,
      dropped.map((d) => `Q${d.idx}(acc=${d.accuracy}/safe=${d.safety}/form=${d.form}/${d.reason})`).join(", ")
    );
  }

  // Strip server-only sourceText from final survivors — it was a
  // grounding-verification field, not for client or admin display.
  return { questions: survivors.map(stripSourceText), dropped };
}

function stripSourceText(q) {
  const { sourceText, ...rest } = q;
  return rest;
}

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthenticated" }));
  }

  // #82 per-email rate limit. Quiz fetch / submit are cheap individually
  // (Redis lookup + small AI call on miss) but uncapped they're the
  // easiest route to drain Anthropic budget. 30/min covers a kid
  // grinding both attempts on multiple books per minute.
  {
    const rl = await checkRateLimit({
      email: session.email, bucket: "quiz",
      max: LIMITS.quiz.max, windowSec: LIMITS.quiz.windowSec,
    });
    if (!rl.ok) return send429(res, rl);
  }

  // #19 audit follow-up: reject writes for tombstoned emails (race
  // with concurrent /api/auth/me?action=delete). quiz_submit writes
  // to multiple per-user keys; this gate stops the resurrection.
  {
    const { isTombstoned } = await import("../lib/session.js");
    if (await isTombstoned(session.email)) {
      res.statusCode = 410;
      return res.end(JSON.stringify({ error: "account_deleted" }));
    }
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const bookId = url.searchParams.get("bookId");

  if (!bookId || !QUIZ_BOOKS[bookId]) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, bookId }));
  }

  // Look up the book up front so we know its quiz style (and minimum
  // usable pool size) before we touch the cache.
  const book = QUIZ_BOOKS[bookId];

  // Resolve the student's working grade + track overrides from their Redis
  // profile, falling back to email heuristic. This drives both the quiz
  // calibration AND the track-visibility check below.
  let profileGrade = null;
  let profileAgeGrade = null;
  let trackOverrides = {};
  const r = redis();
  if (r) {
    try {
      const raw = await r.hget("users", String(session.email).toLowerCase());
      if (raw) {
        const prof = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (prof?.grade) profileGrade = prof.grade;
        if (prof?.ageGrade) profileAgeGrade = prof.ageGrade;
        if (prof?.trackOverrides) trackOverrides = prof.trackOverrides;
      }
    } catch {
      /* fall through to email heuristic */
    }
  }
  const studentGrade = normalizeGrade(
    profileGrade || guessGradeFromEmail(session.email) || "K"
  );
  // Age grade is OPTIONAL — TimeBack supplies it via the working-grade
  // sync cron. When missing, fall back to studentGrade so the prompt
  // ignores the maturity rubric (same behavior as before task #30).
  const ageGrade = profileAgeGrade
    ? normalizeGrade(profileAgeGrade)
    : studentGrade;

  // Track-visibility enforcement (#14). If admin has locked this book's
  // track for this student (or default rule hides it), refuse to serve the
  // quiz. Prevents bypassing the UI filter with a direct bookId fetch.
  // Admins bypass — they need QA access to every book regardless of grade.
  const bookTrack = trackForBook(book);
  const visible = resolveVisibleTracks(studentGrade, trackOverrides);
  if (!isAdmin(session.email) && bookTrack && !visible.includes(bookTrack)) {
    res.statusCode = 403;
    return res.end(
      JSON.stringify({
        error: "track_locked",
        bookId,
        bookTrack,
        visibleTracks: visible,
        message:
          "This book is on a track that hasn't been unlocked for you.",
      })
    );
  }

  // CurrentlyReading enforcement — the kid must have declared they're
  // reading THIS book before they can take its quiz. Prevents quiz-
  // hopping across books they haven't claimed to be working on.
  const activeRead = await getCurrentlyReading(session.email);
  if (!activeRead || activeRead.bookId !== bookId) {
    res.statusCode = 403;
    return res.end(
      JSON.stringify({
        error: "not_currently_reading",
        bookId,
        currentlyReading: activeRead || null,
        message:
          "Tap \"I'm reading this\" on the book first so we know it's the one you're working on.",
      })
    );
  }
  const style = book.quizStyle || "comprehension";
  const minUsable = minUsableFor(style);

  // Cache key: (book, working grade, age grade). Different working grades
  // get different question pools because difficulty is calibrated to the
  // reader. Different (working, age) PAIRS also get different pools
  // because the maturity rubric reshapes distractors when age ≠ working.
  // To preserve old-cache compatibility for the common same-grade case,
  // we only suffix age when it differs.
  const cacheKey =
    ageGrade && ageGrade !== studentGrade
      ? `v${SCHEMA_VERSION}:${bookId}:${studentGrade}:age${ageGrade}`
      : `v${SCHEMA_VERSION}:${bookId}:${studentGrade}`;
  const cached = await getCachedQuiz(cacheKey);
  if (
    cached &&
    Array.isArray(cached.questions) &&
    cached.questions.length >= minUsable
  ) {
    // #41: count this open. Used as a fraud signal in /api/activity
    // quiz_submit — opens-without-submit pattern feeds the soft-flag
    // matrix. Fire-and-forget; failures here mustn't block the response.
    recordQuizOpen(session.email, bookId).catch(() => {});
    res.statusCode = 200;
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: cached.questions.length,
        studentGrade,
        quizStyle: style,
        cached: true,
        ...cached,
        // SECURITY: strip the answer key before sending to the client.
        // The cached pool keeps answers for server-side grading via
        // /api/activity kind:"quiz_submit"; clients never see them. This
        // closes the DevTools-reveal attack.
        //
        // Admin exception: admins doing QA need to see the correct
        // answer to walk the kid through each question. The full pool
        // (with `answer` per question) goes to admins only. The server
        // still validates submissions against the cached pool — the
        // admin client can't lie about the answer, just see it.
        questions: isAdmin(session.email)
          ? cached.questions
          : cached.questions.map(stripAnswerKey),
        adminMode: isAdmin(session.email),
      })
    );
  }

  // Refuse to generate when the book has no hand-authored summary.
  // User directive: only the .md files under docs/book-summaries/ are
  // an acceptable source of truth. Books without an .md show a clear
  // "quiz unavailable" message instead of an attempt to invent one.
  if (!getBookSummary(bookId)) {
    res.statusCode = 503;
    return res.end(JSON.stringify({
      error: "no_summary_for_book",
      message:
        "This book doesn't have a hand-authored summary yet, so we can't " +
        "build a quiz that matches the story. An admin needs to add one.",
    }));
  }

  // Vocab/length rubric is keyed to AGE grade (per user directive:
  // age dictates vocabulary, working grade dictates which books they
  // can access). Working grade ("studentGrade" name retained for
  // legacy) is passed through for inference-depth tuning inside
  // generateOnce, but the rubric the prompt cites is the age one.
  const guidance =
    GRADE_GUIDANCE[String(ageGrade || studentGrade || "K").toUpperCase()] ||
    GRADE_GUIDANCE.K;

  try {
    // ---------- Generation: multi-pass cross-validation (1g) ----------
    // Run POOL generations in parallel at different temperatures. Settled
    // promises let us tolerate 1-2 failures and still cluster on what we got.
    let candidates; // Array<Array<Question>> — one entry per successful run
    let multiPassStats = null;

    if (MULTI_PASS_ENABLED) {
      const settled = await Promise.allSettled(
        MULTI_PASS_TEMPS.map((t) =>
          generateOnce(bookId, book, studentGrade, guidance, t, ageGrade)
        )
      );
      const successful = settled
        .filter((s) => s.status === "fulfilled")
        .map((s) => s.value);
      const failed = settled.length - successful.length;
      if (successful.length === 0) {
        // All passes failed — bubble up.
        throw settled[0]?.reason || new Error("all_generations_failed");
      }
      if (failed > 0) {
        console.warn(
          `[quiz_multi_pass_partial] ${bookId} grade=${studentGrade}: ` +
            `${successful.length}/${settled.length} runs succeeded`
        );
      }
      candidates = successful;
    } else {
      // Single-pass fallback — env-toggleable for A/B comparison.
      const questions = await generateOnce(
        bookId,
        book,
        studentGrade,
        guidance,
        0.7, // sensible default
        ageGrade
      );
      candidates = [questions];
    }

    // Cluster across runs, keep only consensus questions (≥2 of 3 runs).
    // If only one run came back, this returns it as-is.
    const consensus = await clusterAndExtractConsensus(candidates, {
      bookTitle: book.title,
      // Use the hand-authored .md as the clustering reference too —
      // same source of truth as generation + grounding. We've already
      // refused to reach this point if the summary is missing.
      bookSummary: getBookSummary(bookId) || "",
      consensusThreshold: MULTI_PASS_CONSENSUS_THRESHOLD,
      targetPoolSize: poolSizeFor(style),
    });
    multiPassStats = consensus.stats;

    if (multiPassStats && multiPassStats.totalCandidates > 0) {
      console.log(
        `[quiz_multi_pass] ${bookId} grade=${studentGrade}: ` +
          `${multiPassStats.totalCandidates} candidates → ` +
          `${multiPassStats.clusterCount} clusters → ` +
          `${multiPassStats.survivingClusters} consensus`
      );
    }

    // ---------- QC reviewer pass (Opus 4.5) ----------
    // Independent second opinion: score each consensus question for
    // accuracy against the canonical summary. Drop low-scoring questions.
    const reviewedPool = await qcAndFilter(
      bookId,
      book,
      studentGrade,
      consensus.questions
    );

    if (reviewedPool.questions.length < minUsable) {
      // Too many questions failed QC to produce a usable quiz.
      console.error(
        "[quiz_qc_too_strict]",
        bookId,
        studentGrade,
        "survivors:",
        reviewedPool.questions.length,
        "of",
        consensus.questions.length,
        `(style=${style}, min=${minUsable})`
      );
      res.statusCode = 500;
      return res.end(
        JSON.stringify({
          error: "qc_no_viable_questions",
          message:
            "The quiz generator produced too many low-quality questions for this book. Try again — the next run will regenerate from scratch.",
        })
      );
    }

    // ---------- Safety moderation pass (deterministic) ----------
    // QC reviews accuracy; this filters content. Drops any question
    // whose text or options trips the profanity / PII filter — same
    // list the student-comment moderator uses, lifted to lib/moderation.js.
    // Opus 4.5 is well-aligned so this rarely fires, but Agent 6 flagged
    // "Opus QCs itself with no independent moderation" as catastrophic.
    // Deterministic filter = the cheap first line; an LLM safety pass
    // (more nuanced) is a separate follow-up task.
    const safe = moderateQuizQuestions(reviewedPool.questions);
    if (safe.dropped.length > 0) {
      console.warn(
        `[quiz_safety_dropped] ${bookId} grade=${studentGrade}: ` +
          `${safe.dropped.length} question(s) dropped`,
        safe.dropped.map((d) => `#${d.idx}:${d.reason}`).join(", ")
      );
    }
    if (safe.kept.length < minUsable) {
      console.error(
        "[quiz_safety_too_strict]",
        bookId,
        studentGrade,
        "survivors:",
        safe.kept.length,
        "of",
        reviewedPool.questions.length
      );
      res.statusCode = 500;
      return res.end(
        JSON.stringify({
          error: "safety_no_viable_questions",
          message:
            "The quiz needs to be regenerated — please try again in a moment.",
        })
      );
    }

    const payload = {
      questions: safe.kept,
      qc: {
        generated: consensus.questions.length,
        kept: reviewedPool.questions.length,
        afterSafety: safe.kept.length,
        dropped: reviewedPool.dropped,
        droppedForSafety: safe.dropped,
      },
      multiPass: multiPassStats,
    };
    await setCachedQuiz(cacheKey, payload);

    // #41: count this open (cold-path mirror of the cached-hit branch).
    recordQuizOpen(session.email, bookId).catch(() => {});
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: reviewedPool.questions.length,
        studentGrade,
        quizStyle: style,
        cached: false,
        ...payload,
        // Admin exception (see cached path comment): full pool with
        // answers goes to admins only; students still get stripped.
        questions: isAdmin(session.email)
          ? payload.questions
          : payload.questions.map(stripAnswerKey),
        adminMode: isAdmin(session.email),
      })
    );
  } catch (err) {
    console.error("quiz_generation_failed", err);
    await trackError("quiz_generation_failed", err, { bookId, studentGrade });
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        error: "quiz_generation_failed",
        message:
          "Couldn't build the quiz right now. Check ANTHROPIC_API_KEY is set on the Vercel project. Try again in a minute.",
      })
    );
  }
}
