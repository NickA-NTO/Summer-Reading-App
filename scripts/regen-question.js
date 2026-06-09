#!/usr/bin/env node
// Per-question regenerator — surgical replacement for ONE question
// in an existing bank. Used by build-missing-banks.js when QC fails
// on a subset of questions; the whole-bank --fix-issues pass kept
// introducing new failures on previously-passing questions, so we
// switched to in-place per-Q fixes.
//
// Reads docs/book-questions/<id>.json, replaces the question at the
// given index with a Claude-generated fix that addresses the
// supplied QC issues, writes the file back.
//
// Usage (driver invokes this):
//   ANTHROPIC_API_KEY=... node scripts/regen-question.js \
//     --book a02 --index 4 --issues "parallelism: 3-vs-1; option #2 over 8 words"
//
// First tries to FIX the existing question (rewrite to avoid the
// issues while testing the same fact). Only swaps to a different
// fact if the model concludes the question is unfixable.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const args = parseArgs(process.argv.slice(2));
if (!args.book || args.index == null || !args.issues) {
  console.error("Usage: node scripts/regen-question.js --book <id> --index <0-based> --issues \"<issue text>\"");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY before running.");
  process.exit(1);
}

const bookId = String(args.book).toLowerCase();
const targetIdx = Number(args.index);
const issuesText = String(args.issues).trim();

const ROOT = process.cwd();
const SUMMARIES_DIR = path.join(ROOT, "docs", "book-summaries");
const QUESTIONS_DIR = path.join(ROOT, "docs", "book-questions");

const summaryFile = fs
  .readdirSync(SUMMARIES_DIR)
  .find((f) => f.toLowerCase().startsWith(bookId + "-") && f.endsWith(".md"));
if (!summaryFile) {
  console.error(`No summary file matching ${bookId}-*.md`);
  process.exit(1);
}
const summary = fs.readFileSync(path.join(SUMMARIES_DIR, summaryFile), "utf-8");

const bankPath = path.join(QUESTIONS_DIR, `${bookId}.json`);
if (!fs.existsSync(bankPath)) {
  console.error(`No bank at ${bankPath}. Run author-quiz.js first.`);
  process.exit(1);
}
const bank = JSON.parse(fs.readFileSync(bankPath, "utf-8"));
if (!Array.isArray(bank.questions) || targetIdx < 0 || targetIdx >= bank.questions.length) {
  console.error(`Index ${targetIdx} out of range (bank has ${bank.questions?.length || 0} questions).`);
  process.exit(1);
}

const broken = bank.questions[targetIdx];
const otherQuestions = bank.questions
  .map((q, i) => ({ i, q }))
  .filter(({ i }) => i !== targetIdx);

// System prompt copied (intentionally) from author-quiz.js — same
// rules, same examples, same self-check. Single-question variant
// instead of 12-question generator. Kept inline to avoid a shared
// module import on a tiny local script.
const SYSTEM_PROMPT = `You are fixing ONE multiple-choice question in a K-2
reading-comprehension quiz bank. The other 11 questions are FIXED — you
must produce one replacement for the failing question that does not
duplicate any of them topically.

EVERY question must follow ALL of these rules. The QC agent rejected
your prior attempt for specific issues — fix THOSE issues plus
re-check that you don't break anything else.

RULES (the same QC checklist that runs on your output):

1. SOURCE GROUNDING — Every fact in the correct ANSWER must trace to
   the hand-authored summary (case-insensitive substring match). The
   question stem may use generic English ("color", "kind", "feels").

2. NO TELEGRAPHING — The question stem must NOT contain any 4+
   character content word from the correct answer (proper nouns
   exempt; protagonist names in stem + answer are unavoidable).

3. NO CIRCULAR — Answer text must not appear verbatim in the question.

4. NO SELF-REFERENTIAL DISTRACTORS — Distractors' main nouns must
   differ from the question's subject. Proper-noun distractors
   (e.g. "Teddy", "Mr. Rabbit") are fine even if the stem mentions
   "teddy bear" or "rabbit" — they're names, not common nouns.

5. AGE-APPROPRIATE VOCABULARY — No grade-3+ words.

6. OPTION PARALLELISM — All 4 options share the same leading
   determiner / part-of-speech pattern.
     BAD:  ["A wagon", "A car", "A scooter", "His bike"]
     GOOD: ["A bike", "A car", "A scooter", "A wagon"]
     GOOD: ["Hops", "Sings", "Swims", "Flies"]
     GOOD: ["Ten", "Fifteen", "Twenty", "Thirty"]
   Check leading words BEFORE emitting.

7. NO EXCLUSIONARY PHRASING — Banned in the stem:
     not / never / without / besides / except / NOT (caps) /
     cannot / can't / don't / doesn't / didn't / isn't / aren't /
     wasn't / weren't / won't / shouldn't / couldn't / wouldn't /
     does not / do not / did not / is not / was not / were not.

7a. NEVER REPEAT THE QUESTION'S MAIN VERB IN THE OPTIONS.
     BAD:  Q: "Where are X's paintings shown?" / A: "shown at..."
     GOOD: Q: "Where do people see X's paintings?" / A: "At..."

7b. NUMERIC ANSWERS — When the question is "how many X", options must
    be JUST NUMBERS, not "N X". Repeating the noun telegraphs the unit.
     BAD:  ["Ten steps", "Fifteen steps", "Twenty steps", "Thirty steps"]
     GOOD: ["Ten", "Fifteen", "Twenty", "Thirty"]

8. CLOSED-LIST DISTRACTORS — Prefer distractors drawn from OTHER
   content in the summary.

9. LENGTH — Stem under 18 words, every option under 8 words.

APPROACH:
- FIRST try to fix the existing question by rewording (same fact,
  different wording that avoids the issues).
- If the question is fundamentally broken (premise not in summary,
  no fix that avoids telegraphing), produce a DIFFERENT question on
  DIFFERENT content from the summary.
- Either way, the new question must NOT duplicate any of the other
  11 questions topically.

OUTPUT FORMAT (strict):

Return ONLY a JSON object matching exactly this schema. No commentary,
no markdown fences. One question:

{
  "q": "<question text under 18 words>",
  "options": ["<opt1>", "<opt2>", "<opt3>", "<opt4>"],
  "answer": 0
}
`;

const userPrompt = `Book summary:
---
${summary}
---

The other 11 questions in the bank (DO NOT duplicate any of these):
${otherQuestions
  .map(
    ({ i, q }) =>
      `Q${i + 1}: ${q.q}\n  A) ${q.options[0]}\n  B) ${q.options[1]}\n  C) ${q.options[2]}\n  D) ${q.options[3]}\n  [correct: ${"ABCD"[q.answer]}]`
  )
  .join("\n\n")}

REJECTED question (index ${targetIdx}):
${broken.q}
  A) ${broken.options[0]}
  B) ${broken.options[1]}
  C) ${broken.options[2]}
  D) ${broken.options[3]}
  [correct: ${"ABCD"[broken.answer]}]

QC issues to fix:
${issuesText}

Produce the replacement question now as a single JSON object.`;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
console.log(`[regen-question] ${bookId} Q${targetIdx + 1}: calling Claude (~15s)…`);
const response = await client.messages.create({
  model: "claude-opus-4-5",
  max_tokens: 800,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: userPrompt }],
});

const text = response.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("");
const jsonStr = text
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```\s*$/i, "")
  .trim();

let replacement;
try {
  replacement = JSON.parse(jsonStr);
} catch (err) {
  console.error("[regen-question] Claude returned invalid JSON:");
  console.error(text);
  process.exit(1);
}

if (
  typeof replacement?.q !== "string" ||
  !Array.isArray(replacement?.options) ||
  replacement.options.length !== 4 ||
  !Number.isInteger(replacement?.answer) ||
  replacement.answer < 0 || replacement.answer > 3
) {
  console.error("[regen-question] replacement failed schema check:");
  console.error(JSON.stringify(replacement, null, 2));
  process.exit(1);
}

bank.questions[targetIdx] = {
  q: replacement.q,
  options: replacement.options.slice(),
  answer: replacement.answer,
};
fs.writeFileSync(bankPath, JSON.stringify(bank, null, 2) + "\n", "utf-8");
console.log(`[regen-question] replaced Q${targetIdx + 1}: ${replacement.q}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) { out[key] = true; }
      else { out[key] = next; i++; }
    }
  }
  return out;
}
