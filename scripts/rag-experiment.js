// 1h Archive.org RAG experiment.
//
// Question: would feeding Claude the ACTUAL public-domain text of a book
// produce better/cleaner comprehension questions than our hand-written
// summary?
//
// Method:
//   - Pick Peter Rabbit (a01) — known PD (1902), Project Gutenberg #14838.
//   - Run our normal quiz-generation pipeline TWICE at the same params:
//       (a) "summary" — using the hand-written plot summary we ship today
//       (b) "fulltext" — using the cleaned Gutenberg text instead
//   - Save both pools side-by-side so we can eyeball whether full-text
//     generation is clearly better, clearly worse, or roughly equal.
//
// Single-pass at temp 0.4 to keep variance low and the comparison fair.
// (Multi-pass clustering would mask the source-of-truth effect we're trying
// to measure.)
//
// Run:   node scripts/rag-experiment.js
// Reqs:  ANTHROPIC_API_KEY in env.

import { readFileSync, writeFileSync } from "node:fs";
import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const POOL_SIZE = 12;
const MODEL = "claude-opus-4-5";
const TEMP = 0.4;

const BOOK = {
  id: "a01",
  title: "The Tale of Peter Rabbit",
  author: "Beatrix Potter",
  // Hand-written summary currently shipped in api/quiz.js.
  summary:
    "Mrs. Rabbit tells her four bunny children — Flopsy, Mopsy, Cotton-tail, and Peter — that they may play in the field but they must NOT go into Mr. McGregor's garden, because their father had been caught and put in a pie there. The three good little bunnies go to gather blackberries. Peter, who is naughty, runs straight to the garden and squeezes under the gate. He eats lettuces, French beans, and radishes, then looks for parsley to settle his stomach. Mr. McGregor spots him and chases him with a rake. Peter loses his blue jacket and his shoes escaping. He hides in a watering can, sneezes, runs again, and finally finds the gate. He gets home tired and sick. Mrs. Rabbit puts him to bed with chamomile tea while his sisters Flopsy, Mopsy, and Cotton-tail have bread and milk and blackberries for supper.",
};

const QuizSchema = z.object({
  questions: z
    .array(
      z.object({
        q: z.string(),
        options: z.array(z.string()).length(4),
        answer: z.number().int().min(0).max(3),
      })
    )
    .length(POOL_SIZE),
});

// Strip the Project Gutenberg header/footer + the [Illustration] sprinkles
// so we pass Claude clean prose, no metadata.
function cleanGutenberg(raw) {
  const start = raw.indexOf(
    "*** START OF THE PROJECT GUTENBERG EBOOK"
  );
  const end = raw.indexOf("*** END OF THE PROJECT GUTENBERG EBOOK");
  let body = raw.slice(
    raw.indexOf("\n", start) + 1,
    end > 0 ? end : raw.length
  );
  // Drop "[Illustration]" lines (purely visual cues with no story content).
  body = body.replace(/\[Illustration\][\r\n]*/g, "");
  // Collapse triple+ blank lines.
  body = body.replace(/\n{3,}/g, "\n\n");
  // Trim leading "THE END\n" trailers.
  body = body.replace(/THE END\s*$/i, "");
  return body.trim();
}

// One generation call — same prompt skeleton we use in api/quiz.js, but
// the source-of-truth block is swappable.
async function generate({ label, sourceLabel, sourceText }) {
  console.log(`\n=== generating: ${label} (${sourceText.length} chars) ===`);
  const { object } = await generateObject({
    model: anthropic(MODEL),
    schema: QuizSchema,
    temperature: TEMP,
    system:
      "You are an early-elementary reading specialist designing reading-" +
      "comprehension questions for a GRADE 1 reader.\n\n" +
      "DIFFICULTY CALIBRATION for Grade 1:\nTest recall plus simple " +
      "SEQUENCE (what happened first, next, last) and BASIC " +
      "CAUSE-AND-EFFECT (why was the character sad? what did the " +
      "character do next?). Use simple-to-moderate vocabulary.\n\n" +
      "Tone: warm and concrete. Each question has EXACTLY 4 options, ONE " +
      "of which is clearly correct. The other three should be plausible-" +
      "but-wrong things a kid who skimmed might pick. Vary which index " +
      "(0,1,2,3) is correct across all questions.\n\n" +
      "CRITICAL: Only ask about details that are explicitly in the " +
      sourceLabel +
      " provided. Do NOT invent characters, events, items, or numbers. " +
      "If you can't verify a detail in the " +
      sourceLabel +
      ", do NOT use it as a question or distractor.",
    prompt:
      `Write ${POOL_SIZE} reading-comprehension questions for the book ` +
      `"${BOOK.title}" by ${BOOK.author}.\n\n` +
      `The student is in Grade 1.\n\n` +
      `${sourceLabel} (the source of truth — every question must be ` +
      `answerable from these details):\n\n${sourceText}\n\n` +
      `Hard rules:\n` +
      `- Avoid trick questions.\n` +
      `- Keep each question under 18 words.\n` +
      `- Keep each option under 8 words.\n` +
      `- No two questions should be near-duplicates.\n` +
      `- Every fact you assert must appear in the ${sourceLabel} above.`,
  });
  return object.questions;
}

function formatPool(label, questions) {
  const letters = ["A", "B", "C", "D"];
  let out = `\n${"=".repeat(72)}\n${label}\n${"=".repeat(72)}\n\n`;
  questions.forEach((q, i) => {
    out += `Q${i + 1}. ${q.q}\n`;
    q.options.forEach((opt, j) => {
      const marker = j === q.answer ? "  ✓" : "   ";
      out += `   ${letters[j]}) ${opt}${marker}\n`;
    });
    out += "\n";
  });
  return out;
}

async function main() {
  // Load Gutenberg text from local snapshot (already fetched in advance).
  const raw = readFileSync("scripts/.peter-rabbit-raw.txt", "utf8");
  const fullText = cleanGutenberg(raw);

  console.log(`Summary chars: ${BOOK.summary.length}`);
  console.log(`Full-text chars: ${fullText.length}`);
  console.log(`Full-text starts: "${fullText.slice(0, 80)}…"`);

  // Run both generations sequentially (avoid burst rate limits on free tier).
  const summaryPool = await generate({
    label: "SUMMARY source",
    sourceLabel: "Plot summary",
    sourceText: BOOK.summary,
  });
  const fulltextPool = await generate({
    label: "FULL-TEXT source",
    sourceLabel: "Full book text",
    sourceText: fullText,
  });

  const report =
    `Peter Rabbit RAG experiment\n` +
    `Model: ${MODEL}  ·  Temp: ${TEMP}  ·  Pool size: ${POOL_SIZE}\n` +
    `Summary: ${BOOK.summary.length} chars  ·  ` +
    `Full text: ${fullText.length} chars\n` +
    formatPool("(a) Generated from HAND-WRITTEN SUMMARY", summaryPool) +
    formatPool("(b) Generated from FULL GUTENBERG TEXT", fulltextPool);

  writeFileSync("scripts/rag-experiment-output.txt", report);
  writeFileSync(
    "scripts/rag-experiment-output.json",
    JSON.stringify(
      { summaryPool, fulltextPool, fulltextChars: fullText.length },
      null,
      2
    )
  );
  console.log(
    "\nWrote scripts/rag-experiment-output.txt (human-readable) and .json"
  );
}

main().catch((err) => {
  console.error("Experiment failed:", err);
  process.exit(1);
});
