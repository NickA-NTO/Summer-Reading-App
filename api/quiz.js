// AI-generated reading comprehension quiz. Generates a POOL of 8 multiple-
// choice questions per book and caches them in Redis. The client picks 4 at
// random per attempt and shuffles the answer options, so a kid retaking the
// quiz sees mostly different questions and never the same option ordering.
//
// Auth: requires a valid rs_session cookie. Middleware excludes /api/* so
// each endpoint does its own check.

import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { verifySession, parseCookies } from "../lib/session.js";
import { getCachedQuiz, setCachedQuiz } from "../lib/store.js";

// Canonical book metadata for quiz generation. We deliberately keep this
// small for now — only books with AI quizzes enabled live here. The frontend
// hits /api/quiz?bookId=... and gracefully falls back to the plain "I read
// this" button if availability is false.
const QUIZ_BOOKS = {
  k01: {
    title: "The Very Hungry Caterpillar",
    author: "Eric Carle",
    grade: "K",
    summary:
      "A tiny caterpillar hatches from an egg and eats his way through one apple on Monday, two pears on Tuesday, three plums on Wednesday, four strawberries on Thursday, and five oranges on Friday. On Saturday he eats through a huge feast of junk food including chocolate cake, ice cream, a pickle, Swiss cheese, salami, a lollipop, cherry pie, sausage, a cupcake, and watermelon — and gets a stomach ache. On Sunday he eats one nice green leaf and feels better. He's no longer a tiny caterpillar but a big fat one. He builds a cocoon, stays inside for two weeks, and finally emerges as a beautiful butterfly.",
  },
};

// 8 questions in the pool. Client picks 4 per attempt, so a kid on attempt 2
// will see mostly (often entirely) different questions than attempt 1.
const POOL_SIZE = 8;

const QuizSchema = z.object({
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
      })
    )
    .length(POOL_SIZE),
});

// Bump the schema version whenever we change shape — old cached entries are
// then ignored automatically (cache key includes the version).
const SCHEMA_VERSION = 2;

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const secret = process.env.AUTH_SECRET;
  const cookies = parseCookies(req.headers.cookie);
  const session = await verifySession(cookies.rs_session, secret);
  if (!session) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthenticated" }));
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const bookId = url.searchParams.get("bookId");

  if (!bookId || !QUIZ_BOOKS[bookId]) {
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, bookId }));
  }

  // Cache key includes schema version so we naturally evict old entries
  const cacheKey = `v${SCHEMA_VERSION}:${bookId}`;
  const cached = await getCachedQuiz(cacheKey);
  if (
    cached &&
    Array.isArray(cached.questions) &&
    cached.questions.length === POOL_SIZE
  ) {
    res.statusCode = 200;
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: POOL_SIZE,
        cached: true,
        ...cached,
      })
    );
  }

  const book = QUIZ_BOOKS[bookId];
  try {
    const { object } = await generateObject({
      model: anthropic("claude-haiku-4-5"),
      schema: QuizSchema,
      system:
        "You are an early-elementary reading specialist who designs quick " +
        "reading-comprehension checks. Tone: warm and concrete. Vocabulary: " +
        "Grade K-2 level. Each question has EXACTLY 4 options, ONE of which " +
        "is clearly correct. The other three should be plausible-but-wrong " +
        "things a kid who skimmed might pick. Vary which index (0,1,2,3) is " +
        "correct across all questions — don't bunch the correct answers at " +
        "the same position.",
      prompt:
        `Write ${POOL_SIZE} reading-comprehension questions for the book ` +
        `"${book.title}" by ${book.author}.\n` +
        `Target reader: Grade ${book.grade}.\n\n` +
        `Plot summary (for your reference only — do NOT quote it verbatim):\n${book.summary}\n\n` +
        `The questions should cover DIFFERENT aspects of the book so that any random ` +
        `subset of 4 still tests broad comprehension. Mix question types:\n` +
        `  - What happened on a specific day / in a specific scene\n` +
        `  - What the character ate / saw / did\n` +
        `  - Counting / sequence questions\n` +
        `  - End-of-book outcome / transformation\n` +
        `  - Cause-and-effect (what made the character feel a certain way)\n\n` +
        `Hard rules:\n` +
        `- Avoid trick questions or anything requiring inference outside the text.\n` +
        `- Keep each question under 15 words.\n` +
        `- Keep each option under 8 words.\n` +
        `- No two questions should be near-duplicates.`,
    });

    const payload = { questions: object.questions };
    await setCachedQuiz(cacheKey, payload);

    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        available: true,
        bookId,
        poolSize: POOL_SIZE,
        cached: false,
        ...payload,
      })
    );
  } catch (err) {
    console.error("quiz_generation_failed", err);
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
