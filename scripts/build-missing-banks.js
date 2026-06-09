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

if (targets.length === 0) {
  console.log("No missing banks. Every summary already has a JSON.");
  process.exit(0);
}

console.log(`[build-missing-banks] will generate banks for: ${targets.join(", ")}`);
console.log(`[build-missing-banks] ~$0.30 per book in Anthropic credits.`);

for (const bookId of targets) {
  console.log(`\n=== ${bookId} ===`);
  const author = spawnSync("node", ["scripts/author-quiz.js", "--book", bookId], {
    stdio: "inherit",
    env: process.env,
  });
  if (author.status !== 0) {
    console.error(`[build-missing-banks] author-quiz failed for ${bookId} — stopping.`);
    process.exit(author.status || 1);
  }

  if (args["skip-qc"]) {
    console.log(`[build-missing-banks] --skip-qc set; not running QC for ${bookId}.`);
    continue;
  }

  const qc = spawnSync("node", ["scripts/qc-quiz.js", "--book", bookId, "--llm"], {
    stdio: "inherit",
    env: process.env,
  });
  if (qc.status !== 0) {
    console.error(
      `[build-missing-banks] qc-quiz REJECTED ${bookId}. Open ` +
        `docs/book-questions/${bookId}.json, fix the flagged issues by ` +
        `hand or re-run author-quiz with --overwrite. Stopping.`
    );
    process.exit(qc.status || 1);
  }
  console.log(`[build-missing-banks] ${bookId} passed QC.`);
}

console.log(`\n[build-missing-banks] done. NEXT:`);
console.log(`  1. Open each new docs/book-questions/*.json and read it.`);
console.log(`  2. git add docs/book-questions/`);
console.log(`  3. git commit -m "feat: question banks for <ids>"`);
console.log(`  4. git push`);

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
