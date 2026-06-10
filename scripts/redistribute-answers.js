#!/usr/bin/env node
// One-off (idempotent) — redistribute the STORED correct-answer index
// evenly across 0-3 in every question bank. (#11)
//
// Why: the author-quiz schema example used "answer": 0, and the LLM
// followed it, so almost every bank stored the correct option at
// index 0. The client shuffles options at display time, so a kid never
// sees "always A" — BUT the static JSON itself being a trivial
// answer key is a single point of failure (defense-in-depth). If any
// code path ever renders raw bank order, every answer is index 0.
//
// Fix: for each question, move the correct option to a deterministic
// target index = (questionIndex % 4) and update `answer`. This only
// REORDERS the four options — the same option text stays correct, just
// at a new position. The deterministic target makes the script
// idempotent (re-running yields the same layout).
//
// Safe because:
//   - QC checks (parallelism, telegraphing, self-ref) operate on the
//     SET/TEXT of options, not their order — they still pass.
//   - Answer-token HMACs are generated at serve time from the live
//     bank's answer index (not persisted in the file), so re-indexing
//     just changes what the server signs. No stale tokens.
//
// Usage: node scripts/redistribute-answers.js [--book a01]
//        (no --book = all banks). Bumps each touched bank's version.

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
let only = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--book") only = String(args[i + 1] || "").toLowerCase();
}

const DIR = path.join(process.cwd(), "docs", "book-questions");
const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .filter((f) => !only || f.slice(0, -5).toLowerCase() === only)
  .sort();

let changed = 0;
for (const f of files) {
  const full = path.join(DIR, f);
  const bank = JSON.parse(fs.readFileSync(full, "utf-8"));
  if (!Array.isArray(bank.questions)) continue;
  let touched = false;
  bank.questions.forEach((q, i) => {
    if (!Array.isArray(q.options) || q.options.length !== 4) return;
    if (!Number.isInteger(q.answer)) return;
    const target = i % 4;
    if (q.answer === target) return; // already where we want it
    const opts = q.options.slice();
    const correct = opts[q.answer];
    // Swap the correct option into the target slot.
    opts[q.answer] = opts[target];
    opts[target] = correct;
    q.options = opts;
    q.answer = target;
    touched = true;
  });
  if (touched) {
    bank.version = (Number(bank.version) || 1) + 1;
    fs.writeFileSync(full, JSON.stringify(bank, null, 2) + "\n", "utf-8");
    const dist = [0, 0, 0, 0];
    bank.questions.forEach((q) => dist[q.answer]++);
    console.log(`${f.padEnd(10)} rewritten → dist ${dist.join("/")} (v${bank.version})`);
    changed++;
  } else {
    console.log(`${f.padEnd(10)} already balanced — skipped`);
  }
}
console.log(`\n[redistribute-answers] rewrote ${changed} of ${files.length} bank(s).`);
