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
// --min-passing N: tolerant mode. When set, qc-quiz exits 0 if at
// least N questions pass ALL checks (deterministic + LLM if --llm).
// On success, the JSON is rewritten to keep ONLY the passing
// questions (capped at MAX_KEEP) so the deployed bank doesn't
// include flagged content. Without this flag, qc-quiz behaves as
// before: ANY failure = exit 1, file untouched. Used by the
// build-missing-banks driver to avoid the "regen breaks a passing
// question" cycle — generate 15, keep the best 12+.
const minPassing = args["min-passing"] != null
  ? Number(args["min-passing"])
  : null;
const MAX_KEEP = 15;

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

// Proper nouns in a stem are the unavoidable subject context — the
// protagonist's name (Ping, Max, Corduroy, McGregor, Vashti) shows up
// in both stem and distractors because the story is ABOUT that
// character. Excluding proper nouns from the self-ref / telegraphing
// overlap stops the QC from flagging "Who carries Ping?" / "He gives
// Ping to another family" as a self-referential distractor. Real
// self-refs (fish-has-a-little-fish) use common nouns and are still
// caught.
//
// Heuristic: a word is "proper-noun-ish" if it appears Capitalized in
// the original text and isn't the sentence-initial word. We also
// collect proper nouns from the SUMMARY (since a kid's-book summary
// usually capitalizes proper nouns even when used mid-sentence) so we
// catch names that appear in distractors even if the question stem
// uses a pronoun.
function extractProperNounsFromText(text) {
  const out = new Set();
  const sentences = String(text || "").split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    const tokens = s.match(/\b[A-Z][a-zA-Z]+\b/g) || [];
    // Skip the first token of each sentence (could just be sentence-initial
    // capitalization rather than a proper noun).
    for (let i = 1; i < tokens.length; i++) {
      out.add(tokens[i].toLowerCase());
    }
  }
  return out;
}
const SUMMARY_PROPER_NOUNS = extractProperNounsFromText(summary);

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

  // (1) SOURCE GROUNDING — the correct ANSWER's content words must
  // appear in the summary. The question stem doesn't have to — it's
  // paraphrased English and uses generic question vocabulary
  // ("color", "kind", "feels", "keep trying") that won't appear in
  // a tightly-written summary. The summary's job is to confirm that
  // the FACT being tested is actually in the book, not to enforce a
  // word-for-word mapping of every question stem.
  //
  // Hallucinated question PREMISES (e.g. "Who goes to school?" when
  // no one in the book attends school) are caught by the --llm
  // premise-grounding pass below, not by this deterministic check.
  const summaryNorm = norm(summary);
  const qWords = contentWords(qText);
  const aWords = contentWords(correct);
  const missingFromSummary = aWords.filter((w) => !summaryNorm.includes(w));
  if (missingFromSummary.length > 0) {
    issues.push(
      `answer not in summary: ${missingFromSummary.join(", ")}`
    );
  }

  // (2) TELEGRAPHING — question stem must not contain words that match
  // the correct answer's content. Proper nouns are excluded ONLY
  // when they're capitalized in the stem itself (suggesting
  // proper-noun usage in this question). We deliberately don't
  // exempt summary-wide proper nouns — a word like "Fox" can be a
  // CHARACTER name in the summary but a COMMON noun in the stem
  // ("when meeting the fox"), where it IS a telegraph hit and
  // should fire. The original Gruffalo k06 bug: 4 questions all
  // had "fox / owl / snake / gruffalo" food options, and each
  // question's stem named the matching animal. Each was trivially
  // answerable because the SUMMARY had "Fox" capitalized as a name,
  // letting the old check pass.
  const qNorm = norm(qText);
  const correctNorm = norm(correct);
  const stemProperForTelegraph = extractProperNounsFromText(qText);
  const properForTelegraph = stemProperForTelegraph;
  // Length threshold of 3 (was 4) so short content words like animal
  // names — "fox", "owl", "cat", "dog" — count as telegraph hits.
  // Stopwords (the/and/for/etc.) are still excluded so common 3-char
  // English doesn't false-positive. This caught the Gruffalo k06 case
  // where the question stem said "when he meets the fox" and an
  // option was "Roasted fox" — clearly telegraphed but missed by
  // the old 4-char minimum.
  const aTokens = correctNorm.split(/\s+/).filter(
    (t) => t.length >= 3 && !SHARED_STOPWORDS.has(t) && !properForTelegraph.has(t)
  );
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
  //
  // We exclude proper nouns from BOTH sides of the comparison:
  //   • Protagonist names from the stem + summary (Ping, Vashti, Max)
  //   • Proper-noun-as-distractor (the distractor IS a name, like
  //     "Teddy" or "Mr. Rabbit" as an answer to "What's the bear's
  //     name?"). When a distractor is itself a proper noun, any
  //     overlap with the stem's common noun ("teddy bear" → "Teddy")
  //     isn't a logical fish-has-a-fish failure — it's the distractor
  //     proposing an alternative NAME.
  // Same logic as the telegraphing exclusion above: only exempt
  // words that ARE capitalized in the stem itself (proper-noun
  // usage in this question). Summary-wide proper nouns aren't
  // exempted — a word can be a name in the summary AND a common
  // noun in this stem, and we want the common-noun usage to
  // trigger the rule. Distractors that are themselves capitalized
  // (e.g. "Mr. Rabbit" as a name) are still exempted below.
  const stemProperNouns = extractProperNounsFromText(qText);
  const properNouns = stemProperNouns;
  const qNouns = new Set(qWords.filter((w) => !properNouns.has(w)));
  for (let i = 0; i < q.options.length; i++) {
    if (i === q.answer) continue;
    const distractorText = String(q.options[i]);
    // Extract proper nouns FROM THE DISTRACTOR ITSELF. A distractor
    // like "Teddy" or "Mr. Rabbit" has every word capitalized — those
    // ARE the proper-noun answers. Use a looser rule than
    // extractProperNounsFromText (which skips sentence-initial caps):
    // any capitalized word in the distractor is a name candidate.
    const distractorProperNouns = new Set(
      (distractorText.match(/\b[A-Z][a-zA-Z]+\b/g) || []).map((w) => w.toLowerCase())
    );
    const optNouns = contentWords(distractorText).filter(
      (w) => !properNouns.has(w) && !distractorProperNouns.has(w)
    );
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

// Schema issues (missing fields, count < 6, etc.) are fatal even in
// --min-passing tolerant mode. They mean the file isn't valid at all,
// not just that some questions failed quality checks.
if (schemaIssues.length > 0) {
  console.log(`\n[qc-quiz] FAILED — ${schemaIssues.length} schema issue(s). File is structurally invalid.`);
  process.exit(1);
}

if (totalIssues > 0 && minPassing == null) {
  // Strict mode (default): any failure = exit 1, leave file untouched.
  console.log(`\n[qc-quiz] FAILED — ${totalIssues} issue(s) found. Fix the JSON and re-run.`);
  process.exit(1);
}

if (totalIssues > 0 && minPassing != null) {
  // Tolerant mode: check that enough questions pass deterministic
  // checks before spending the LLM call. If we're already below
  // minPassing on the cheap deterministic checks, bail early.
  if (cleanCount < minPassing) {
    console.log(
      `\n[qc-quiz] FAILED — only ${cleanCount}/${perQuestion.length} pass ` +
        `deterministic checks, need ${minPassing}.`
    );
    process.exit(1);
  }
  console.log(
    `\n[qc-quiz] ${cleanCount}/${perQuestion.length} pass deterministic checks ` +
      `(min ${minPassing} required). Proceeding to LLM review.`
  );
}

if (totalIssues === 0) {
  console.log(`\n[qc-quiz] all deterministic checks passed.`);
}

if (!runLlm) {
  // No LLM pass requested. If we're in tolerant mode and have enough
  // passing questions, trim + write here. Otherwise just exit clean
  // (strict mode + no issues = success).
  if (minPassing != null && totalIssues > 0) {
    trimAndWriteBank(perQuestion, /* llmReviews */ null);
  }
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
// IMPORTANT — IIFE wrapper instead of bare top-level await + process.exit.
// The Anthropic SDK's fetch agent keeps a libuv handle in CLOSING state
// after the API call returns; calling process.exit() at that point hits
// a UV_HANDLE_CLOSING assertion on Windows and the process aborts with
// exit code 127 (not 0 or 1). That confused the build driver: a clean
// trim+PASSED gave 127 → driver thought QC failed → kept regenerating
// questions that were already passing. Setting process.exitCode and
// returning lets Node drain the event loop naturally before exit.
await (async () => {
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
    process.exitCode = 1;
    return;
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
  if (flagged.length > 0 && minPassing == null) {
    // Strict mode — any LLM flag = exit 1.
    console.log(`\n[qc-quiz] LLM REVIEW FAILED — ${flagged.length} question(s) flagged.`);
    process.exitCode = 1;
    return;
  }

  if (minPassing != null) {
    // Tolerant mode — count combined (deterministic + LLM) passing
    // questions. If at least minPassing pass both, trim + succeed.
    const llmAccepted = new Set(
      (reviewed.reviews || [])
        .filter((rr) => rr.verdict === 1)
        .map((rr) => rr.idx)
    );
    const combinedPassing = perQuestion.filter(
      (p) => p.issues.length === 0 && llmAccepted.has(p.idx)
    );
    if (combinedPassing.length < minPassing) {
      console.log(
        `\n[qc-quiz] FAILED — ${combinedPassing.length}/${perQuestion.length} pass ` +
          `BOTH deterministic + LLM, need ${minPassing}.`
      );
      process.exitCode = 1;
      return;
    }
    trimAndWriteBank(perQuestion, reviewed);
    console.log(
      `\n[qc-quiz] PASSED — kept ${combinedPassing.length} clean questions ` +
        `(of ${perQuestion.length}; dropped ${perQuestion.length - combinedPassing.length}).`
    );
    process.exitCode = 0;
    return;
  }

  console.log(`\n[qc-quiz] ALL CHECKS PASSED. Bank is ready to commit.`);
  process.exitCode = 0;
})();

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

// --min-passing helper: rewrite the bank file keeping only questions
// that passed BOTH deterministic AND LLM checks. Cap at MAX_KEEP.
// Original question ORDER is preserved (so the bank doesn't shuffle
// unnecessarily). When llmReviews is null, deterministic-only mode.
function trimAndWriteBank(perQ, llmReviews) {
  const llmAccepted = llmReviews
    ? new Set(
        (llmReviews.reviews || [])
          .filter((rr) => rr.verdict === 1)
          .map((rr) => rr.idx)
      )
    : null;
  const passingIndices = perQ
    .filter((p) => p.issues.length === 0 && (llmAccepted === null || llmAccepted.has(p.idx)))
    .map((p) => p.idx);
  const trimmed = passingIndices
    .slice(0, MAX_KEEP)
    .map((idx) => bank.questions[idx]);
  bank.questions = trimmed;
  // Bump the version field automatically so the client-side bank
  // cache busts when a kid loads a re-trimmed bank from disk.
  bank.version = (Number(bank.version) || 1) + 1;
  fs.writeFileSync(jsonFile, JSON.stringify(bank, null, 2) + "\n", "utf-8");
  console.log(
    `[qc-quiz] trimmed bank: kept ${trimmed.length} of ${perQ.length} questions, ` +
      `wrote ${jsonFile} (version ${bank.version})`
  );
}
