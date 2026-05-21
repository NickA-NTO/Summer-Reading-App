// AI-generated reading comprehension quiz. Returns 4 multiple-choice
// questions for a given book, generated once and cached in Redis so the
// kid sees the same questions if they retry.
//
// Auth: requires a valid rs_session cookie (gated by middleware in prod,
// but we double-check here so the endpoint can't be hit from cURL by a
// non-authenticated client even if the matcher slips).

import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { verifySession, parseCookies } from "../lib/session.js";
import { getCachedQuiz, setCachedQuiz } from "../lib/store.js";

// Canonical book metadata for quiz generation. We deliberately keep this
// small for now — only books with AI quizzes enabled live here. The
// frontend hits /api/quiz?bookId=... and gracefully falls back to the
// plain "I read this" button if availability is false.
const QUIZ_BOOKS = {
  k01: {
    title: "The Very Hungry Caterpillar",
    author: "Eric Carle",
    grade: "K",
    summary:
      "A tiny caterpillar hatches from an egg and eats his way through one apple on Monday, two pears on Tuesday, three plums on Wednesday, four strawberries on Thursday, and five oranges on Friday. On Saturday he eats through a huge feast of junk food including chocolate cake, ice cream, a pickle, Swiss cheese, salami, a lollipop, cherry pie, sausage, a cupcake, and watermelon — and gets a stomach ache. On Sunday he eats one nice green leaf and feels better. He's no longer a tiny caterpillar but a big fat one. He builds a cocoon, stays inside for two weeks, and finally emerges as a beautiful butterfly.",
  },
};

const QuizSchema = z.object({
  questions: z
    .array(
      z.object({
        q: z.string().describe("The question, in simple words a 5-year-old can read or hear read aloud."),
        options: z.array(z.string()).length(4).describe("Exactly 4 answer choices, all plausible to a child."),
        answer: z.number().int().min(0).max(3).describe("Index (0-3) of the correct option."),
      })
    )
    .length(4),
});

export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  // Auth check
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
    // Not an error — just no AI quiz yet for this book. Client falls back
    // to the manual "I read this" button.
    res.statusCode = 200;
    return res.end(JSON.stringify({ available: false, bookId }));
  }

  // Try the cache first
  const cached = await getCachedQuiz(bookId);
  if (cached && cached.questions && cached.questions.length === 4) {
    res.statusCode = 200;
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.end(
      JSON.stringify({ available: true, bookId, cached: true, ...cached })
    );
  }

  // Generate via the AI Gateway (auto-authenticated on Vercel)
  const book = QUIZ_BOOKS[bookId];
  try {
    const { object } = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: QuizSchema,
      system:
        "You are an early-elementary reading specialist who designs quick " +
        "reading-comprehension checks. Tone: warm and concrete. Vocabulary: " +
        "Grade K-2 level. Each question has EXACTLY 4 options, ONE of which " +
        "is clearly correct. The other three should be plausible-but-wrong " +
        "things a kid who skimmed might pick. Vary which index (0,1,2,3) is " +
        "correct across the 4 questions — don't always make it the same.",
      prompt:
        `Write 4 reading-comprehension questions for the book "${book.title}" by ${book.author}.\n` +
        `Target reader: Grade ${book.grade}.\n\n` +
        `Plot summary (for your reference only — do NOT quote it verbatim):\n${book.summary}\n\n` +
        `Question rules:\n` +
        `- Focus on concrete plot points a child would remember (what the character ate, the days of the week, what happened at the end).\n` +
        `- Avoid trick questions or anything requiring inference outside the text.\n` +
        `- Keep each question under 15 words.\n` +
        `- Keep each option under 8 words.`,
    });

    const payload = { questions: object.questions };
    await setCachedQuiz(bookId, payload);

    res.statusCode = 200;
    return res.end(
      JSON.stringify({ available: true, bookId, cached: false, ...payload })
    );
  } catch (err) {
    // Don't expose internal errors to the client, but log details server-side
    console.error("quiz_generation_failed", err);
    res.statusCode = 500;
    return res.end(
      JSON.stringify({
        error: "quiz_generation_failed",
        message:
          "Couldn't build the quiz right now. The AI Gateway may not be configured. Try again in a minute.",
      })
    );
  }
}
