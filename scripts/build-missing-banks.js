#!/usr/bin/env node
// Batch driver — generates question banks for every book that has a
// summary under docs/book-summaries/ but no bank under
// docs/book-questions/.
//
// Runs author-quiz.js then qc-quiz.js --llm for each missing bookId.
// If QC fails the script stops so the user can inspect that book
// before more credits are spent on the next one. Each book is ~$0.30
// in Anthropic credits so the full ~22-book sweep is ~$7.
//
// Usage:
//   ANTHROPIC_API_KEY=... node scripts/build-missing-banks.js
//   ANTHROPIC_API_KEY=... node scripts/build-missing-banks.js --skip-qc
//   ANTHROPIC_API_KEY=... node scripts/build-missing-banks.js --only a01,a02
//   ANTHROPIC_API_KEY=... node scripts/build-missing-banks.js --max 10
//   ANTHROPIC_API_KEY=... node scripts/build-missing-banks.js --continue-on-fail
//
// After this finishes, open each new .json yourself, read every
// question, and commit + push.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY before running.");
  process.exit(1);
}

const ROOT = process.cwd();
const SUMMARIES_DIR = path.join(ROOT, "docs", "book-summaries");
const QUESTIONS_DIR = path.join(ROOT, "docs", "book-questions");

// Discover bookIds that have a summary file (bXX-*.md → "bXX").
const summaryIds = new Set();
for (const f of fs.readdirSync(SUMMARIES_DIR)) {
  const m = f.match(/^([a-zA-Z]\d{2,3})-.+\.md$/);
  if (m) summaryIds.add(m[1].toLowerCase());
}

const existingBanks = new Set();
if (fs.existsSync(QUESTIONS_DIR)) {
  for (const f of fs.readdirSync(QUESTIONS_DIR)) {
    if (f.endsWith(".json")) existingBanks.add(f.slice(0, -5).toLowerCase());
  }
}

let targets = [...summaryIds].filter((id) => !existingBanks.has(id)).sort();
if (args.only) {
  const wanted = new Set(args.only.split(",").map((s) => s.trim().toLowerCase()));
  targets = targets.filter((id) => wanted.has(id));
}
if (args.max) {
  const max = Math.max(1, Number(args.max) || 0);
  if (targets.length > max) targets = targets.slice(0, max);
}

if (targets.length === 0) {
  console.log("No missing banks. Every summary already has a JSON.");
  process.exit(0);
}

const continueOnFail = !!args["continue-on-fail"];

console.log(`[build-missing-banks] will generate banks for: ${targets.join(", ")}`);
console.log(`[build-missing-banks] ~$0.30 per book in Anthropic credits.`);
if (continueOnFail) {
  console.log(`[build-missing-banks] --continue-on-fail: will NOT stop on QC failure.`);
}

// Tally for the final summary so the user can see at a glance which
// books passed QC, which failed, and which crashed in the author step.
const results = { passed: [], qcFailed: [], authorFailed: [] };

// Max regenerate-on-QC-fail attempts per book. The author LLM is
// inconsistent at following its own rules; feeding the QC findings
// back in and asking for a corrected pass typically clears
// mechanical violations on attempt #2. We cap at 2 retries (3 total
// author calls) because if the LLM can't fix it in 3 tries, the
// problem is structural and a human needs to look.
const MAX_RETRIES = Number.isFinite(Number(args.retries)) ? Number(args.retries) : 2;

// Run author-quiz, optionally with --fix-issues feedback from a
// prior QC failure. Streams output to console so the user sees it
// live. Returns { ok: boolean }.
function runAuthor(bookId, fixIssues) {
  const argv = ["scripts/author-quiz.js", "--book", bookId, "--overwrite"];
  if (fixIssues) argv.push("--fix-issues", fixIssues);
  const r = spawnSync("node", argv, { stdio: "inherit", env: process.env });
  return { ok: r.status === 0 };
}

// Run qc-quiz with --llm. Capture stdout so we can both display it
// AND parse out the issue lines for the regenerate-on-fail loop. We
// stream the captured output to console at the end so the user sees
// the same QC report they'd see from a manual run.
function runQc(bookId) {
  const r = spawnSync(
    "node",
    ["scripts/qc-quiz.js", "--book", bookId, "--llm"],
    { stdio: ["ignore", "pipe", "pipe"], env: process.env, encoding: "utf-8" }
  );
  const combined = (r.stdout || "") + (r.stderr || "");
  process.stdout.write(combined);
  // Parse the failure lines. The QC agent prints failed questions as
  // `  ✗ Q{n}: {text}` followed by `      → {issue}` lines. We collect
  // both so the author retry sees the full context.
  const issues = [];
  let currentBlock = null;
  for (const line of combined.split(/\r?\n/)) {
    const qMatch = line.match(/^\s*✗\s+(Q\d+:\s*.+)/);
    if (qMatch) {
      currentBlock = `- ${qMatch[1].trim()}`;
      issues.push(currentBlock);
      continue;
    }
    const issueMatch = line.match(/^\s*→\s+(.+)/);
    if (issueMatch && currentBlock !== null) {
      issues.push(`    • ${issueMatch[1].trim()}`);
    }
  }
  return { ok: r.status === 0, issues: issues.join("\n") };
}

for (const bookId of targets) {
  console.log(`\n=== ${bookId} ===`);

  // Initial author pass — no prior issues to fix.
  let author = runAuthor(bookId, null);
  if (!author.ok) {
    results.authorFailed.push(bookId);
    console.error(`[build-missing-banks] author-quiz failed for ${bookId}.`);
    if (continueOnFail) continue;
    console.error(`[build-missing-banks] stopping (pass --continue-on-fail to keep going).`);
    break;
  }

  if (args["skip-qc"]) {
    console.log(`[build-missing-banks] --skip-qc set; not running QC for ${bookId}.`);
    results.passed.push(bookId);
    continue;
  }

  // QC + regenerate loop. On each failure, feed the issues back to
  // author-quiz via --fix-issues and re-run QC. Cap at MAX_RETRIES.
  let attempt = 0;
  let qc = runQc(bookId);
  while (!qc.ok && attempt < MAX_RETRIES) {
    attempt++;
    console.log(
      `[build-missing-banks] ${bookId} failed QC (attempt ${attempt}/${MAX_RETRIES + 1}). ` +
        `Regenerating with feedback…`
    );
    const fixed = runAuthor(bookId, qc.issues);
    if (!fixed.ok) {
      console.error(`[build-missing-banks] regenerate-pass author call failed for ${bookId}.`);
      break;
    }
    qc = runQc(bookId);
  }

  if (!qc.ok) {
    results.qcFailed.push(bookId);
    console.error(
      `[build-missing-banks] qc-quiz REJECTED ${bookId} after ${attempt} retry/retries. ` +
        `Bank is on disk as docs/book-questions/${bookId}.json but needs human review/fix.`
    );
    if (continueOnFail) continue;
    console.error(`[build-missing-banks] stopping (pass --continue-on-fail to keep going).`);
    break;
  }
  results.passed.push(bookId);
  console.log(
    `[build-missing-banks] ${bookId} passed QC` +
      (attempt > 0 ? ` (after ${attempt} regenerate pass${attempt === 1 ? "" : "es"})` : "") +
      `.`
  );
}

console.log(`\n[build-missing-banks] === SUMMARY ===`);
console.log(`[build-missing-banks] passed QC (${results.passed.length}): ${results.passed.join(", ") || "(none)"}`);
console.log(`[build-missing-banks] QC failed (${results.qcFailed.length}): ${results.qcFailed.join(", ") || "(none)"}`);
console.log(`[build-missing-banks] author failed (${results.authorFailed.length}): ${results.authorFailed.join(", ") || "(none)"}`);
console.log(`\n[build-missing-banks] NEXT:`);
console.log(`  1. Open each docs/book-questions/<id>.json and read it.`);
console.log(`  2. For QC-failed banks: fix flagged issues by hand or re-run with --overwrite.`);
console.log(`  3. git add docs/book-questions/`);
console.log(`  4. git commit -m "feat: question banks for <ids>"`);
console.log(`  5. git push`);

// Always exit 0 when we ran to completion. The caller cares about the
// summary above more than the exit code — a 10-book run with 2 QC
// failures is a SUCCESS for the user's purposes (they wanted the list).
// If you want strict CI behavior, omit --continue-on-fail.
process.exit(continueOnFail ? 0 : results.qcFailed.length + results.authorFailed.length > 0 ? 1 : 0);

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
