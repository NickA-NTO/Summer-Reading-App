#!/usr/bin/env node
// Quiz QC agent — runs OUTSIDE the deployed app.
//
// Validates docs/book-questions/<id>.json against the QC checklist.
// Runs eight deterministic checks first (pure code, no LLM judgment)
// then optionally runs an LLM second-opinion pass for premise grounding
// and grade-appropriate vocabulary.
//
// Usage:
//   node scripts/qc-quiz.js --book e07            (deterministic only)
//   ANTHROPIC_API_KEY=... node scripts/qc-quiz.js --book e07 --llm
//
// Exit code 0 means the bank passes. Non-zero with per-question
// issues printed means it failed and must be fixed before deploy.

import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
if (!args.book) {
  console.error("Usage: node scripts/qc-quiz.js --book <bookId> [--llm]");
  process.exit(1);
}
const bookId = String(args.book).toLowerCase();
const runLlm = !!args.llm;

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

const jsonFile = path.join(QUESTIONS_DIR, `${bookId}.json`);
if (!fs.existsSync(jsonFile)) {
  console.error(`No question bank at ${jsonFile}. Run author-quiz.js first.`);
  process.exit(1);
}
const bank = JSON.parse(fs.readFileSync(jsonFile, "utf-8"));

// ---------- Deterministic checks ----------

const SHARED_STOPWORDS = new Set([
  "the","a","an","and","or","but","not","of","in","on","at","to","for","with","from",
  "is","are","was","were","be","been","being","has","have","had","do","does","did",
  "will","would","could","should","may","might","can","like","by","as","into","onto",
  "this","that","these","those","there","here","where","when","why","how","what","who","which","whose",
  "his","her","its","their","our","my","your","i","he","she","it","they","we","you","me","us","them",
  "out","up","down","off","over","under","than","also","just","very","much",
  "some","many","most","few","several","one","two","three","four","five","six","seven","eight","nine","ten",
  "little","big","small","large","tall","short","high","low","new","old",
]);

const GRADE3_PLUS_WORDS = new Set([
  "narrator", "protagonist", "antagonist", "theme", "perspective", "viewpoint",
  "metaphor", "simile", "analogy", "symbolism", "imagery", "rhetoric",
  "convey", "depict", "portray", "illustrate", "demonstrate", "represent",
  "infer", "imply", "suggest", "convey", "indicate",
  "author", "illustrator", "publication", "edition",
]);

const COMPLEX_PHRASING = [
  /\bbesides\b/i, /\bexcept\b/i, /\bother than\b/i, /\bapart from\b/i,
  /\bis not\b/i, /\bare not\b/i, /\bdoes not\b/i, /\bdo not\b/i, /\bdid not\b/i,
  /\bwas not\b/i, /\bwere not\b/i, /\bcan not\b/i, /\bcannot\b/i,
  /\bdoesn[’']t\b/i, /\bdon[’']t\b/i, /\bdidn[’']t\b/i, /\bisn[’']t\b/i,
  /\baren[’']t\b/i, /\bwasn[’']t\b/i, /\bweren[’']t\b/i, /\bcan[’']t\b/i,
  /\bnever\b/i, /\bwithout\b/i,
];

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function contentWords(text) {
  const words = String(text || "").toLowerCase().match(/\b[a-z]+\b/g) || [];
  return words.filter((w) => w.length >= 3 && !SHARED_STOPWORDS.has(w));
}

function checkSchema(bank) {
  const issues = [];
  if (typeof bank !== "object" || !bank) {
    issues.push("bank is not an object");
    return issues;
  }
  if (bank.bookId !== bookId) {
    issues.push(`bookId mismatch (file says "${bank.bookId}", expected "${bookId}")`);
  }
  if (!Number.isInteger(bank.version) || bank.version < 1) {
    issues.push("version must be a positive integer");
  }
  if (!Array.isArray(bank.questions)) {
    issues.push("questions is not an array");
    return issues;
  }
  if (bank.questions.length < 6) {
    issues.push(`only ${bank.questions.length} questions (minimum 6 to serve a quiz)`);
  }
  return issues;
}

function checkQuestion(q, idx, summary) {
  const issues = [];
  const qText = String(q?.q || "");
  if (qText.length < 5) {
    issues.push("question text too short");
    return issues;
  }
  if (!Array.isArray(q.options) || q.options.length !== 4) {
    issues.push("must have exactly 4 options");
    return issues;
  }
  if (!q.options.every((o) => typeof o === "string" && o.length > 0)) {
    issues.push("all options must be non-empty strings");
  }
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) {
    issues.push("answer must be an integer 0-3");
    return issues;
  }
  const correct = String(q.options[q.answer]);

  // (1) SOURCE GROUNDING — every content word in question + correct
  // answer must appear in the summary (case-insensitive substring).
  const summaryNorm = norm(summary);
  const qWords = contentWords(qText);
  const aWords = contentWords(correct);
  const missingFromSummary = [...qWords, ...aWords].filter(
    (w) => !summaryNorm.includes(w)
  );
  if (missingFromSummary.length > 0) {
    issues.push(
      `source grounding fail: words not in summary: ${missingFromSummary.join(", ")}`
    );
  }

  // (2) TELEGRAPHING — question stem must not contain words that match
  // the correct answer's content.
  const qNorm = norm(qText);
  const correctNorm = norm(correct);
  const aTokens = correctNorm.split(/\s+/).filter((t) => t.length >= 4 && !SHARED_STOPWORDS.has(t));
  const telegraphed = aTokens.filter((t) => qNorm.includes(t));
  if (telegraphed.length > 0) {
    issues.push(
      `telegraphing: question contains answer word(s): ${telegraphed.join(", ")}`
    );
  }

  // (3) CIRCULAR — answer's full text must not appear verbatim in the
  // question. Looser than telegraphing (matches multi-word strings).
  if (correctNorm.length >= 4 && qNorm.includes(correctNorm)) {
    issues.push(`circular: answer text "${correct}" appears in question`);
  }

  // (4) SELF-REFERENTIAL DISTRACTORS — distractors must not use the
  // question's subject noun as their main noun.
  const qNouns = new Set(qWords);
  for (let i = 0; i < q.options.length; i++) {
    if (i === q.answer) continue;
    const optNouns = contentWords(q.options[i]);
    const overlap = optNouns.find((w) => qNouns.has(w));
    if (overlap) {
      issues.push(
        `self-referential distractor #${i + 1} "${q.options[i]}": shares "${overlap}" with question`
      );
    }
  }

  // (5) AGE-APPROPRIATE VOCABULARY — flag Grade-3+ words.
  const grade3Found = [...qWords, ...aWords].filter((w) => GRADE3_PLUS_WORDS.has(w));
  if (grade3Found.length > 0) {
    issues.push(
      `grade-3+ vocabulary: ${[...new Set(grade3Found)].join(", ")} — use plain language`
    );
  }

  // (6) OPTION PARALLELISM — leading-word check for 3-vs-1 splits.
  const leading = q.options.map(
    (o) => (String(o).match(/[a-zA-Z]+/)?.[0] || "").toLowerCase()
  );
  const counts = {};
  for (const w of leading) counts[w] = (counts[w] || 0) + 1;
  const pairs = Object.entries(counts);
  if (pairs.length === 2) {
    const max = Math.max(...pairs.map((p) => p[1]));
    if (max === 3) {
      const lone = pairs.find((p) => p[1] === 1)?.[0];
      issues.push(
        `parallelism: 3-vs-1 leading-word split, lone word "${lone}" gives away the answer`
      );
    }
  }

  // (7) NO EXCLUSIONARY PHRASING.
  for (const re of COMPLEX_PHRASING) {
    if (re.test(qText)) {
      issues.push(`complex phrasing in question matches /${re.source}/`);
      break;
    }
  }

  // (8) LENGTH — questions under 18 words, options under 8 each.
  if (qText.split(/\s+/).length > 18) {
    issues.push(`question over 18 words long (K-2 readability limit)`);
  }
  for (let i = 0; i < q.options.length; i++) {
    if (String(q.options[i]).split(/\s+/).length > 8) {
      issues.push(`option #${i + 1} over 8 words long`);
    }
  }

  return issues;
}

// ---------- Run checks ----------

console.log(`\n[qc-quiz] validating ${bookId}.json against ${summaryFile}`);
console.log("─".repeat(70));

const schemaIssues = checkSchema(bank);
if (schemaIssues.length > 0) {
  console.log("\nSCHEMA ISSUES:");
  for (const issue of schemaIssues) console.log(`  ✗ ${issue}`);
}

let totalIssues = schemaIssues.length;
const perQuestion = [];
if (Array.isArray(bank.questions)) {
  for (let i = 0; i < bank.questions.length; i++) {
    const issues = checkQuestion(bank.questions[i], i, summary);
    perQuestion.push({ idx: i, q: bank.questions[i]?.q || "(missing)", issues });
    totalIssues += issues.length;
  }
}

const cleanCount = perQuestion.filter((p) => p.issues.length === 0).length;
console.log(
  `\nDETERMINISTIC RESULT: ${cleanCount}/${perQuestion.length} questions pass deterministic checks`
);

for (const p of perQuestion) {
  if (p.issues.length === 0) {
    console.log(`  ✓ Q${p.idx + 1}: ${truncate(p.q, 80)}`);
  } else {
    console.log(`  ✗ Q${p.idx + 1}: ${truncate(p.q, 80)}`);
    for (const issue of p.issues) console.log(`      → ${issue}`);
  }
}

if (totalIssues > 0) {
  console.log(`\n[qc-quiz] FAILED — ${totalIssues} issue(s) found. Fix the JSON and re-run.`);
  process.exit(1);
}

console.log(`\n[qc-quiz] all deterministic checks passed.`);

if (!runLlm) {
  console.log(`[qc-quiz] (skip --llm for second-opinion review — pass --llm to enable)`);
  process.exit(0);
}

// ---------- LLM second-opinion pass ----------

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("--llm requires ANTHROPIC_API_KEY env var");
  process.exit(1);
}

const { default: Anthropic } = await import("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REVIEW_PROMPT = `You are reviewing a K-2 quiz bank for content quality.
Deterministic checks (telegraphing, parallelism, source grounding) have
already passed. Your job is the JUDGMENT-BASED reviews:

  A. PREMISE GROUNDING beyond word-level — is the question's IMPLIED
     ASSERTION actually supported by the summary? (E.g. "Who never goes
     to school?" — even if individual words appear in the summary, the
     IDEA of "going to school" might not be in the book at all.)
  B. AGE-APPROPRIATE FRAMING — is the question something a 5-7 year
     old can grasp? Not just vocab, but conceptual difficulty.
  C. DISTRACTOR PLAUSIBILITY — are the wrong answers actually
     plausible to a kid who didn't read carefully? Or are 3 of them
     obviously absurd?

For each question, score 0 (reject) or 1 (acceptable). Reply with
strict JSON only:

{"reviews":[{"idx":0,"verdict":1,"issue":""},{"idx":1,"verdict":0,"issue":"..."},...]}

Book summary:
---
${summary}
---

Questions to review:
${bank.questions
  .map(
    (q, i) =>
      `${i + 1}. ${q.q}\n   A) ${q.options[0]}\n   B) ${q.options[1]}\n   C) ${q.options[2]}\n   D) ${q.options[3]}\n   [correct: ${"ABCD"[q.answer]}]`
  )
  .join("\n\n")}`;

console.log(`\n[qc-quiz] running LLM review pass (~30s)…`);
const r = await client.messages.create({
  model: "claude-opus-4-5",
  max_tokens: 2000,
  messages: [{ role: "user", content: REVIEW_PROMPT }],
});
const txt = r.content.filter((b) => b.type === "text").map((b) => b.text).join("");
const json = txt.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
let reviewed;
try { reviewed = JSON.parse(json); } catch (e) {
  console.error("[qc-quiz] LLM returned non-JSON:", txt);
  process.exit(1);
}
const flagged = (reviewed.reviews || []).filter((r) => r.verdict === 0);
console.log(
  `\nLLM REVIEW: ${(reviewed.reviews || []).length - flagged.length}/${(reviewed.reviews || []).length} questions accepted`
);
for (const r of reviewed.reviews || []) {
  if (r.verdict === 0) {
    console.log(`  ✗ Q${r.idx + 1}: ${r.issue}`);
  }
}
if (flagged.length > 0) {
  console.log(`\n[qc-quiz] LLM REVIEW FAILED — ${flagged.length} question(s) flagged.`);
  process.exit(1);
}
console.log(`\n[qc-quiz] ALL CHECKS PASSED. Bank is ready to commit.`);

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

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
