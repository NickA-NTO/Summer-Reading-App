#!/usr/bin/env node
// Quiz authoring agent — runs OUTSIDE the deployed app.
//
// Reads a hand-authored summary from docs/book-summaries/<id>-*.md
// and produces a draft question bank at
// docs/book-questions/<id>.json.
//
// Usage:
//   ANTHROPIC_API_KEY=... node scripts/author-quiz.js --book e07
//   ANTHROPIC_API_KEY=... node scripts/author-quiz.js --book e07 --overwrite
//
// The output is a DRAFT. After running this, you MUST:
//   1. Run `node scripts/qc-quiz.js --book e07` to validate.
//   2. Open the .json and read every question yourself.
//   3. Commit + push when satisfied.
//
// This script does NOT run on Vercel. It's a local authoring tool.

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const args = parseArgs(process.argv.slice(2));
if (!args.book) {
  console.error("Usage: node scripts/author-quiz.js --book <bookId> [--overwrite]");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY before running.");
  process.exit(1);
}

const bookId = String(args.book).toLowerCase();
const overwrite = !!args.overwrite;

const ROOT = process.cwd();
const SUMMARIES_DIR = path.join(ROOT, "docs", "book-summaries");
const QUESTIONS_DIR = path.join(ROOT, "docs", "book-questions");

// Locate the summary file matching this bookId.
const summaryFile = fs
  .readdirSync(SUMMARIES_DIR)
  .find((f) => f.toLowerCase().startsWith(bookId + "-") && f.endsWith(".md"));
if (!summaryFile) {
  console.error(`No summary file found matching ${bookId}-*.md in ${SUMMARIES_DIR}`);
  process.exit(1);
}
const summary = fs.readFileSync(path.join(SUMMARIES_DIR, summaryFile), "utf-8");
console.log(`[author-quiz] read ${summaryFile} (${summary.length} chars)`);

const outFile = path.join(QUESTIONS_DIR, `${bookId}.json`);
if (fs.existsSync(outFile) && !overwrite) {
  console.error(
    `${outFile} already exists. Pass --overwrite to replace, or rename ` +
      `the existing file if you want to keep the prior version.`
  );
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are a quiz-authoring agent for a K-8 reading app. You produce
multiple-choice questions strictly grounded in a hand-authored book summary.

EVERY question you generate must follow ALL of these rules. A question that
breaks any rule will be rejected by the downstream QC agent and you will be
required to regenerate.

RULES (the QC checklist):

1. SOURCE GROUNDING — Every fact in the question + correct answer must
   trace to a sentence or bullet in the summary. Do NOT invent characters,
   items, events, or attributes that aren't in the summary. Do NOT apply
   real-world common sense ("a creature in a picture book wouldn't go to
   school") if the summary doesn't establish it.

2. NO TELEGRAPHING — The question stem must NOT contain words that match
   the correct answer.
     BAD:  Q: "What is the cookbook on the Nook's hook called?" A: "How to Cook"
           (the word "cookbook" telegraphs "Cook")
     GOOD: Q: "What is the book on the Nook's hook called?" A: "How to Cook"

3. NO CIRCULAR — The answer text must NOT appear verbatim in the question.
     BAD:  Q: "What color socks does the narrator wear for boxing?" A: "Yellow socks"
           (when "yellow socks" was already in the question stem)
     GOOD: Q: "What color are the socks worn for boxing the Gox?" A: "Yellow"

4. NO SELF-REFERENTIAL DISTRACTORS — Distractors must not use the
   question's subject noun as their main noun.
     BAD:  Q: "What do some fish have that is little?" Distractor: "A little fish"
           (fish can't have fish — logically nonsensical)
     GOOD: distractors should be other "little X" items from the book (a little
           car, a little bed, etc.) or other concrete nouns from the summary.

5. AGE-APPROPRIATE VOCABULARY — Do not use grade-3+ words like
   "narrator", "protagonist", "theme", "character", "perspective" for a
   PK/K/G1 audience. Use plain language: "the person telling the story",
   "the main kid", "the lesson", "the people in the story". The default
   target is K-2.

6. OPTION PARALLELISM — All 4 options must share the same grammatical
   form: same determiner (all "A" / all "The" / all bare nouns / all
   possessive), same number, same part-of-speech pattern. ALL FOUR
   OPTIONS MUST START WITH THE SAME WORD-TYPE.
     BAD:  ["A wagon", "A scooter", "A car", "His bike"]
           (3-vs-1 determiner split: 3 options start with "A", 1 with
           "His". The kid spots the odd-one-out without reading.)
     BAD:  ["The teacher", "The art class", "Vashti's mom", "Vashti"]
           (3 options start with "The", 1 bare name.)
     BAD:  ["In the river", "In the den", "On a leaf", "In the boat"]
           (3 "In", 1 "On".)
     GOOD: ["A bike", "A car", "A scooter", "A wagon"]
     GOOD: ["Hops", "Sings", "Swims", "Flies"]
     GOOD: ["The teacher", "The mother", "The art class", "The shopkeeper"]
   Before you write the final options, look at the LEADING WORD of
   each. If 3 of them are the same and 1 is different, REWRITE so
   they all match.

7. NO EXCLUSIONARY OR NEGATIVE PHRASING — K-2 readers can't reliably
   parse negation. THESE WORDS ARE BANNED in question stems:
     "not"  "never"  "without"  "besides"  "except"  "other than"
     "cannot"  "can't"  "don't"  "doesn't"  "didn't"  "isn't"
     "aren't"  "wasn't"  "weren't"  "won't"  "shouldn't"  "couldn't"
     "wouldn't"  "does not"  "do not"  "did not"  "is not"  "was not"
     "were not"  "NOT" (uppercase)
   If you find yourself writing one of these, rewrite the question
   positively.
     BAD:  "Which animal is NOT one who comes to watch?"
     GOOD: "Which animal comes to watch?"
     BAD:  "Why can't Trixie tell her daddy?"
     GOOD: "Why does Trixie struggle to tell her daddy?"

7a. NEVER REPEAT ANY MAIN-CONTENT WORD FROM THE QUESTION STEM IN
    THE ANSWER OR DISTRACTORS. This includes verbs AND short nouns
    (3+ chars). If the stem says "shown", "fox", "owl", "bus", or
    any other 3+ char content word, that word must not appear in
    the correct answer.
     BAD:  Q: "Where are Vashti's paintings shown?"
           A: "Shown at the art show" — telegraphs "shown".
     GOOD: Q: "Where do people see Vashti's paintings?"
           A: "At the school art show"
     BAD:  Q: "Who tells a story to cheer up the other?"
           Distractor: "Toad tells Frog" — telegraphs "tells".
     GOOD: Q: "Who cheers up the other by sharing a story?"
           A: "Frog cheers up Toad"
     BAD:  Q: "What does the mouse say the Gruffalo eats when he meets the fox?"
           A: "Roasted fox" — telegraphs "fox" (the 3-char animal name).
           This pattern repeated across multiple questions (one per
           animal) makes EVERY question trivially answerable from
           the stem alone.
     GOOD: Q: "What scary food does the mouse mention first?"
           A: "Roasted fox"
           — or —
           Q: "Which scary food does the mouse invent for the first
              animal he meets?"
           A: "Roasted fox"
     Animals like "fox", "owl", "cat", "dog", "rat", "bee", "ant",
     "bug" are all flagged — short doesn't mean safe.

7b. NUMERIC ANSWERS — When the question is "how many X", the options
    must be JUST NUMBERS, not "N X". Repeating the noun in every
    option telegraphs the unit and pulls the kid's eye to the
    numeric difference.
     BAD:  Q: "How many steps are on Owl's staircase?"
           Options: ["Ten steps", "Fifteen steps", "Twenty steps",
                     "Thirty steps"]
           (Every option repeats "steps" from the stem — answer is
           clear from a glance.)
     GOOD: Q: "How many steps are on Owl's staircase?"
           Options: ["Ten", "Fifteen", "Twenty", "Thirty"]
     SAME RULE for "How many days/cookies/animals/buttons/etc."

8. CLOSED-LIST DISTRACTORS WHERE POSSIBLE — Prefer distractors drawn
   from OTHER content in the same summary (other named characters, other
   named items) over generic real-world distractors. A kid who didn't
   actually read the book should be able to confuse the wrong answers
   with the right one.

9. FLIP THE QUESTION WHEN APPROPRIATE — When the correct answer is a
   uniquely identifiable real-world thing (e.g. only "bike" is pedalable;
   only "pink ink" is a Seuss-style beverage in this book), the question
   stem may telegraph the answer to anyone with common sense. Rephrase
   to ask about the SUBJECT instead.
     BAD:  Q: "What does the Yink drink?" with juice/milk/water/pink-ink
           (3 distractors aren't from the book; "pink ink" is the obvious
           silly answer)
     GOOD: Q: "Who drinks pink ink?" with The Yink / The Yop / The Zans /
           The Nook (all from the book)

PRE-EMIT SELF-CHECK — Before you output the JSON, walk through each
question and answer YES to every line:
  □ Stem under 18 words, every option under 8 words?
  □ Does the stem contain any banned negation word? (not / never /
    cannot / can't / NOT / doesn't / does not / etc.) → REWRITE if yes.
  □ Do all 4 options start with the same part-of-speech (all "A" or
    all "The" or all bare numbers or all bare verbs)? → REWRITE if no.
  □ Does the question's main verb (or its variants: shown/show/shows,
    tells/told/tell) appear in any option? → REWRITE the question.
  □ For "how many X" questions: are the options JUST numbers
    (no repeated "X")? → strip the noun from options.
  □ Are at least 2 of the 4 options drawn from OTHER content in the
    summary, not generic real-world distractors?
  □ Is the correct answer ACTUALLY in the summary (verbatim or as a
    direct paraphrase)?
If any answer is "no", fix it before moving on.

OUTPUT FORMAT (strict):

Return ONLY a JSON object matching exactly this schema. No commentary,
no markdown fences, no leading or trailing text. Just the JSON.

{
  "bookId": "<the bookId>",
  "version": 1,
  "questions": [
    {
      "q": "<question text under 18 words>",
      "options": ["<opt1>", "<opt2>", "<opt3>", "<opt4>"],
      "answer": 0
    },
    ... 14 more questions, 15 total
  ]
}

Constraints:
- Exactly 15 questions. (Downstream QC keeps the best 12+, so a few
  flagged questions get dropped instead of triggering a full rewrite.)
- Each "options" array has exactly 4 strings.
- "answer" is 0, 1, 2, or 3 indexing into "options".
- Cover DIFFERENT content from the summary across the 15 questions
  (different characters, events, objects, facts) — don't ask the
  same thing 4 different ways. Aim for breadth across the book.
- Vary which index is the correct answer across questions (don't put
  all correct answers at index 0).
`;

// On a regenerate pass, the driver passes --fix-issues "..." with the
// concrete QC findings from the prior attempt. Injecting them into the
// user prompt lets Opus correct specific violations instead of just
// re-rolling the dice. The orchestrator caps retries at 2; if it still
// fails after 2 fixes, the book stays in the "needs human" bucket.
const fixIssuesText = typeof args["fix-issues"] === "string" ? args["fix-issues"].trim() : "";
const userPrompt = `Generate the question bank for bookId "${bookId}" using only
this hand-authored summary as source material:

---
${summary}
---
${
  fixIssuesText
    ? `

A previous attempt at this question bank was REJECTED by the QC agent for
the following issues. You MUST fix every one of these in this regeneration:

${fixIssuesText}

Do not repeat any of the above mistakes. Re-read the rules above before
generating. If a question is fundamentally broken (e.g. its premise isn't
in the summary), replace it with an entirely different question rather
than trying to salvage the wording.
`
    : ""
}
Output the JSON object now.`;

console.log(`[author-quiz] calling Claude (this takes ~30-60s)…`);
const response = await client.messages.create({
  model: "claude-opus-4-5",
  max_tokens: 4000,
  system: SYSTEM_PROMPT,
  messages: [{ role: "user", content: userPrompt }],
});

const text = response.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("");

// Strip markdown fences if Claude added them despite the instruction.
const jsonStr = text
  .replace(/^```(?:json)?\s*/i, "")
  .replace(/\s*```\s*$/i, "")
  .trim();

let parsed;
try {
  parsed = JSON.parse(jsonStr);
} catch (err) {
  console.error("[author-quiz] Claude returned invalid JSON. Raw output:");
  console.error(text);
  process.exit(1);
}

// Cheap sanity check before writing — proper validation is qc-quiz.js.
// Accept 12-15 questions: we ask for 15 but Opus occasionally returns
// 12-14 when content is thin. Anything under 12 won't survive QC's
// --min-passing 12 gate downstream, so we still pass it through.
if (
  !parsed ||
  parsed.bookId !== bookId ||
  !Array.isArray(parsed.questions) ||
  parsed.questions.length < 12
) {
  console.error("[author-quiz] output failed sanity check (bookId mismatch, missing questions, or count < 12):");
  console.error(JSON.stringify(parsed, null, 2));
  process.exit(1);
}

if (!fs.existsSync(QUESTIONS_DIR)) {
  fs.mkdirSync(QUESTIONS_DIR, { recursive: true });
}
fs.writeFileSync(outFile, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
console.log(`[author-quiz] wrote ${outFile}`);
console.log(`[author-quiz] NEXT: run "node scripts/qc-quiz.js --book ${bookId}" to validate.`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}
